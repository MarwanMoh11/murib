// Storage backend: JSON files in the student's private GitHub repo via the
// Contents API. Implements the app's Store interface (see SPEC.md).
//
//   index.json          { texts: [meta…] }   — every text without `analyses`, plus `stats`
//   texts/<id>.json     the full text record (analyses included)
//   profile.json        { known, settings }
//   srs.json            { cards }
//   analytics/<YYYY-MM>_<device>.json   { device, sessions } — the visit log (see src/analytics.js)
//
// Writes are debounced and serialized per file; each write is one commit. Another device or
// the murib-fix review skill may have changed a file since this session read it: before
// overwriting texts/*.json or index.json the store folds those changes in (three-way merge).

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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Per key: what this device changed since `base` wins; everything else takes the remote value. */
export function merge3(base, local, remote) {
  base = base || {};
  local = local || {};
  remote = remote || {};
  const out = {};
  for (const k of new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(base)])) {
    const v = same(local[k], base[k]) ? remote[k] : local[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A text record: field by field, and sentence by sentence inside analyses and chunkState. */
export function mergeText(base, local, remote) {
  base = base || {};
  const out = merge3(base, local, remote);
  for (const k of ['analyses', 'chunkState']) out[k] = merge3(base[k], local[k], remote[k]);
  return out;
}

/** index.json: text by text. */
export function mergeIndex(base, local, remote) {
  const byId = (d) => Object.fromEntries(((d && d.texts) || []).map((m) => [m.id, m]));
  const texts = Object.values(merge3(byId(base), byId(local), byId(remote)));
  return { texts: texts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
}

/** A visit log: session by session (the copy seen last wins), the newest device details. */
export function mergeVisits(base, local, remote) {
  local = local || {};
  remote = remote || {};
  const byId = new Map();
  for (const s of [...(remote.sessions || []), ...(local.sessions || [])]) {
    const cur = byId.get(s.id);
    if (!cur || (s.last || 0) >= (cur.last || 0)) byId.set(s.id, s);
  }
  return { v: 1, device: local.device || remote.device, sessions: [...byId.values()].sort((a, b) => a.start - b.start) };
}

export function createGithubStore({ token, repo }) {
  const shas = new Map(); // path → last known blob sha
  const synced = new Map(); // path → JSON last read from or written to GitHub (the merge base)
  const seen = new Map(); // text id → the record as the app last loaded or sent it
  const texts = new Map(); // id → full record (session cache)
  let index = null; // [meta]
  let profileCache = null;
  const visits = new Map(); // analytics path → this device's visit log as last read or written
  const visitNext = new Map(); // analytics path → { device, session } to write next

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
    let text;
    if (meta.encoding === 'base64' && meta.content) {
      text = fromB64(meta.content);
    } else {
      // over 1 MB: the JSON form carries no content
      const raw = await request('GET', path, null, 'application/vnd.github.raw+json');
      if (!raw.ok) throw fail(`GET raw ${path}: ${raw.status}`, raw.status);
      text = await raw.text();
    }
    const value = JSON.parse(text);
    shas.set(path, meta.sha);
    synced.set(path, JSON.stringify(value));
    return value;
  }

  // One commit at a time. Every write is a commit on the same branch, and two commits racing
  // for it make one fail with 409 even when they touch different files.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  function mergerFor(path) {
    if (path === 'index.json') return { merge: mergeIndex, apply: (v) => { index = v.texts; } };
    if (path.startsWith('analytics/')) return { merge: mergeVisits, apply: (v) => visits.set(path, v) };
    const m = /^texts\/(.+)\.json$/.exec(path);
    return m && { merge: mergeText, apply: (v) => texts.set(m[1], v) };
  }

  /** Learn the current sha; for texts and the index also fold in what changed there. → value to write */
  async function catchUp(path, value) {
    const m = mergerFor(path);
    shas.delete(path);
    if (!m) {
      const probe = await request('GET', path);
      if (probe.ok) shas.set(path, (await probe.json()).sha);
      return value;
    }
    const base = synced.has(path) ? JSON.parse(synced.get(path)) : null;
    const remote = await read(path);
    if (!remote) return value;
    const merged = m.merge(base, value, remote);
    m.apply(merged);
    return merged;
  }

  async function put(path, value, attempt = 0) {
    if (!shas.has(path) && attempt === 0) value = await catchUp(path, value); // a file we never read here
    const json = JSON.stringify(value);
    const res = await request('PUT', path, {
      message: `murib: save ${path}`,
      content: toB64(json),
      ...(shas.get(path) ? { sha: shas.get(path) } : {}),
    });
    if ((res.status === 409 || res.status === 422) && attempt < 3) {
      // another device or the review skill wrote this file, or another commit won the branch
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return put(path, await catchUp(path, value), attempt + 1);
    }
    if (!res.ok) throw fail(`PUT ${path}: ${res.status}`, res.status);
    const out = await res.json();
    shas.set(path, out.content && out.content.sha);
    synced.set(path, json);
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
      const t = await ensureText(id);
      if (t) seen.set(id, clone(t));
      return clone(t);
    },

    async saveTextMeta(text) {
      const incoming = clone(text);
      const cur = texts.get(text.id);
      const prev = seen.get(text.id) || {};
      // Apply only what the app changed since it loaded or last sent this text: its copy can be
      // older than ours when another device or the review skill wrote in between.
      const next = { ...(cur || {}) };
      for (const [k, v] of Object.entries(incoming)) {
        if (k === 'analyses') continue;
        if (k === 'chunkState' && v && typeof v === 'object') {
          next.chunkState = { ...(next.chunkState || {}) };
          for (const [c, st] of Object.entries(v)) if (!cur || !same(st, prev.chunkState && prev.chunkState[c])) next.chunkState[c] = st;
        } else if (!cur || !same(v, prev[k])) next[k] = v;
      }
      next.analyses = { ...(next.analyses || {}), ...(incoming.analyses || {}) };
      texts.set(text.id, next);
      seen.set(text.id, { ...prev, ...incoming });
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

    /** Record (or update) one session in this device's visit log for the session's month. */
    async saveVisit(device, session) {
      const path = `analytics/${new Date(session.start).toISOString().slice(0, 7)}_${device.id}.json`;
      visitNext.set(path, { device, session });
      await schedule(path, () => {
        const { device: d, session: s } = visitNext.get(path);
        const v = mergeVisits(null, { device: d, sessions: [s] }, visits.get(path));
        visits.set(path, v);
        return v;
      }, 0);
    },

    /** Every device's visit logs from the month of `since` on. → [{ device, sessions }] */
    async loadVisits(since = 0) {
      const res = await request('GET', 'analytics');
      if (res.status === 404) return [];
      if (!res.ok) throw fail(`GET analytics: ${res.status}`, res.status);
      const month = new Date(since).toISOString().slice(0, 7);
      const list = (await res.json()).filter((f) => f.type === 'file' && /^\d{4}-\d{2}_[\w-]+\.json$/.test(f.name) && f.name.slice(0, 7) >= month);
      const out = [];
      for (let i = 0; i < list.length; i += 6) {
        const got = await Promise.all(list.slice(i, i + 6).map((f) => read(f.path).catch(() => null)));
        got.forEach((v, j) => {
          if (!v) return;
          const path = list[i + j].path;
          // read() moved this file's sha to the remote copy: fold that copy into ours before the next write
          visits.set(path, mergeVisits(null, visits.get(path), v));
          out.push(v);
        });
      }
      return out;
    },

    /** Setup check: proves the token can write to the repo. */
    async checkWrite() {
      await serial(() => put('setup.json', { setupAt: new Date().toISOString() }));
    },
  };
}
