// Storage backend: JSON files in the student's private GitHub repo via the
// Contents API. Implements the app's Store interface (see SPEC.md).
//
//   index.json          { texts: [meta…] }   — every text without `analyses`, plus `stats`
//   texts/<id>.json     the full text record (analyses included)
//   profile.json        { known, settings }
//   srs.json            { cards }
//
// Writes are debounced and serialized per file; each write is one commit.

const API = 'https://api.github.com';

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const fail = (message, status) => ({ code: status === 401 || status === 403 ? 'storage_auth' : 'storage_failed', message, status });

export function createGithubStore({ token, repo }) {
  const shas = new Map(); // path → last known blob sha
  const texts = new Map(); // id → full record (session cache)
  let index = null; // [meta]
  let profileCache = null;

  async function request(method, path, body, accept = 'application/vnd.github+json') {
    const url = `${API}/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw fail('network: ' + (e && e.message), 0);
    }
    return res;
  }

  /** → parsed JSON or null when the file does not exist. */
  async function read(path) {
    const res = await request('GET', path);
    if (res.status === 404) {
      shas.delete(path);
      return null;
    }
    if (!res.ok) throw fail(`GET ${path}: ${res.status}`, res.status);
    const meta = await res.json();
    shas.set(path, meta.sha);
    let text;
    if (meta.encoding === 'base64' && meta.content) {
      text = fromB64(meta.content);
    } else {
      // over 1 MB: the JSON form carries no content
      const raw = await request('GET', path, null, 'application/vnd.github.raw+json');
      if (!raw.ok) throw fail(`GET raw ${path}: ${raw.status}`, raw.status);
      text = await raw.text();
    }
    return JSON.parse(text);
  }

  // One commit at a time. Every write is a commit on the same branch, and two commits racing
  // for it make one fail with 409 even when they touch different files.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function put(path, value, attempt = 0) {
    if (!shas.has(path) && attempt === 0) {
      // learn the sha of an existing file we never read in this session
      const probe = await request('GET', path);
      if (probe.ok) shas.set(path, (await probe.json()).sha);
    }
    const res = await request('PUT', path, {
      message: `murib: save ${path}`,
      content: toB64(JSON.stringify(value)),
      ...(shas.get(path) ? { sha: shas.get(path) } : {}),
    });
    if ((res.status === 409 || res.status === 422) && attempt < 3) {
      // another device wrote this file, or another commit won the branch: refresh the sha,
      // retry (last writer wins)
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      shas.delete(path);
      const probe = await request('GET', path);
      if (probe.ok) shas.set(path, (await probe.json()).sha);
      return put(path, value, attempt + 1);
    }
    if (!res.ok) throw fail(`PUT ${path}: ${res.status}`, res.status);
    const out = await res.json();
    shas.set(path, out.content && out.content.sha);
  }

  async function remove(path) {
    if (!shas.has(path)) {
      const probe = await request('GET', path);
      if (probe.status === 404) return;
      if (!probe.ok) throw fail(`GET ${path}: ${probe.status}`, probe.status);
      shas.set(path, (await probe.json()).sha);
    }
    const res = await request('DELETE', path, { message: `murib: delete ${path}`, sha: shas.get(path) });
    if (!res.ok && res.status !== 404) throw fail(`DELETE ${path}: ${res.status}`, res.status);
    shas.delete(path);
  }

  // One debounced, serialized writer per file. write() resolves when that content is saved.
  const writers = new Map();
  function schedule(path, getValue, delay = 700) {
    let w = writers.get(path);
    if (!w) {
      w = { timer: null, inflight: null, dirty: false, waiters: [], getValue: null };
      w.flush = async () => {
        if (w.inflight || !w.dirty) return;
        w.dirty = false;
        const waiters = w.waiters;
        w.waiters = [];
        w.inflight = serial(() => put(path, w.getValue()));
        try {
          await w.inflight;
          waiters.forEach((x) => x.resolve());
        } catch (e) {
          waiters.forEach((x) => x.reject(e));
        } finally {
          w.inflight = null;
          if (w.dirty) w.flush();
        }
      };
      writers.set(path, w);
    }
    w.dirty = true;
    w.getValue = getValue; // always write the latest value
    return new Promise((resolve, reject) => {
      w.waiters.push({ resolve, reject });
      clearTimeout(w.timer);
      w.timer = setTimeout(w.flush, delay);
    });
  }

  function metaOf(text) {
    const { analyses, ...meta } = text;
    const words = [];
    for (const a of Object.values(analyses || {})) for (const w of (a && a.words) || []) words.push(w.w);
    const unique = [...new Set(words)];
    const known = new Set((profileCache && profileCache.known) || []);
    meta.stats = { words: words.length, unique: unique.length, newWordsHint: unique.filter((w) => !known.has(w)).length };
    return meta;
  }

  function saveIndex() {
    return schedule('index.json', () => ({ texts: index }), 900);
  }

  function upsertMeta(text) {
    if (!index) index = [];
    const meta = metaOf(text);
    const i = index.findIndex((m) => m.id === text.id);
    if (i >= 0) index[i] = meta;
    else index.unshift(meta);
  }

  async function ensureText(id) {
    if (texts.has(id)) return texts.get(id);
    const t = await read(`texts/${id}.json`);
    if (t) texts.set(id, t);
    return t;
  }

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  return {
    kind: 'github',

    async init() {
      const res = await fetch(`${API}/repos/${repo}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      }).catch((e) => {
        throw fail('network: ' + (e && e.message), 0);
      });
      if (!res.ok) throw fail(`repo ${repo}: ${res.status}`, res.status === 404 ? 401 : res.status);
      return { mode: 'github' };
    },

    async listTexts() {
      if (!index) {
        const data = await read('index.json');
        index = (data && Array.isArray(data.texts) && data.texts) || [];
      }
      return clone(index).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async loadText(id) {
      return clone(await ensureText(id));
    },

    async saveTextMeta(text) {
      const cur = texts.get(text.id) || {};
      const next = { ...cur, ...clone(text), analyses: (cur.analyses && { ...cur.analyses, ...(text.analyses || {}) }) || clone(text.analyses) || {} };
      texts.set(text.id, next);
      upsertMeta(next);
      await Promise.all([schedule(`texts/${text.id}.json`, () => texts.get(text.id)), saveIndex()]);
    },

    async saveChunk(textId, chunkId, analyses) {
      const cur = texts.get(textId) || (await ensureText(textId));
      if (!cur) throw fail(`unknown text ${textId}`, 0);
      cur.analyses = { ...(cur.analyses || {}), ...clone(analyses) };
      cur.updatedAt = Date.now();
      upsertMeta(cur);
      await Promise.all([schedule(`texts/${textId}.json`, () => texts.get(textId)), saveIndex()]);
    },

    async deleteText(id) {
      texts.delete(id);
      await serial(() => remove(`texts/${id}.json`));
      if (!index) await this.listTexts();
      index = index.filter((m) => m.id !== id);
      await saveIndex();
    },

    async loadProfile() {
      if (!profileCache) profileCache = await read('profile.json');
      return clone(profileCache);
    },

    async saveProfile(p) {
      profileCache = clone(p);
      await schedule('profile.json', () => profileCache, 1200);
    },

    async loadSrs() {
      return read('srs.json');
    },

    async saveSrs(s) {
      const snapshot = clone(s);
      await schedule('srs.json', () => snapshot, 1500);
    },

    /** Setup check: proves the token can write to the repo. */
    async checkWrite() {
      await serial(() => put('setup.json', { setupAt: new Date().toISOString() }));
    },
  };
}
