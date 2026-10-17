// Exercises src/platform/github-store.js against an in-memory fake of the GitHub Contents API.
import assert from 'node:assert/strict';
import { createGithubStore } from '../src/platform/github-store.js';

const files = new Map(); // path → { sha, content(base64) }
let n = 0, puts = 0, conflicts = 0, inflight = 0, maxInflight = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.pathname === '/repos/me/data') return json(200, { full_name: 'me/data' });
  const path = decodeURIComponent(u.pathname.replace('/repos/me/data/contents/', ''));
  const method = opts.method || 'GET';
  assert.equal(opts.headers.Authorization, 'Bearer tok');
  if (method === 'GET') return files.has(path) ? json(200, { sha: files.get(path).sha, encoding: 'base64', content: files.get(path).content }) : json(404, {});
  const body = JSON.parse(opts.body);
  // Like GitHub: every write is a commit on one branch, and a commit that races another fails.
  const racing = inflight > 0; inflight++; maxInflight = Math.max(maxInflight, inflight);
  await new Promise((r) => setTimeout(r, 5));
  inflight--;
  if (racing) return json(409, {});
  if (method === 'PUT') {
    puts++;
    if (conflicts > 0) { conflicts--; files.set(path, { ...files.get(path), sha: 'other' + n++ }); return json(409, {}); }
    if (files.has(path) && body.sha !== files.get(path).sha) return json(409, {});
    if (!files.has(path) && body.sha) return json(422, {});
    const sha = 's' + n++;
    files.set(path, { sha, content: body.content });
    return json(200, { content: { sha } });
  }
  if (method === 'DELETE') { if (files.get(path)?.sha !== body.sha) return json(409, {}); files.delete(path); return json(200, {}); }
};
const decode = (p) => JSON.parse(Buffer.from(files.get(p).content, 'base64').toString('utf8'));

const s1 = createGithubStore({ token: 'tok', repo: 'me/data' });
await s1.init();
assert.deepEqual(await s1.listTexts(), []);
assert.equal(await s1.loadProfile(), null);
const text = { id: 'tabc', title: '中国外交部长访问埃及', createdAt: 1, updatedAt: 1, chunkState: {}, doc: { sentences: [] } };
await s1.saveTextMeta(text);
await s1.saveChunk('tabc', 'c1', { S1: { words: [{ w: '中国' }, { w: '外交部长' }, { w: '中国' }] } });
assert.equal(decode('texts/tabc.json').analyses.S1.words.length, 3);
assert.equal(decode('index.json').texts[0].stats.unique, 2);
assert.equal(decode('index.json').texts[0].analyses, undefined);

// burst of writes coalesces and the last value wins
const before = puts;
await Promise.all([s1.saveProfile({ known: ['a'] }), s1.saveProfile({ known: ['a', 'b'] }), s1.saveProfile({ known: ['a', 'b', 'c'] })]);
assert.deepEqual(decode('profile.json').known, ['a', 'b', 'c']);
assert.equal(puts - before, 1);

// a second device: reads fresh, survives a conflicting write
const s2 = createGithubStore({ token: 'tok', repo: 'me/data' });
assert.equal((await s2.listTexts())[0].id, 'tabc');
const full = await s2.loadText('tabc');
assert.equal(full.title, '中国外交部长访问埃及');
conflicts = 2; // another device wrote twice meanwhile
await s2.saveChunk('tabc', 'c2', { S2: { words: [{ w: '访问' }] } });
assert.ok(decode('texts/tabc.json').analyses.S2);
await s2.saveSrs({ cards: { 中国: { box: 2, due: 5 } } });
assert.equal((await s1.loadSrs()).cards['中国'].box, 2);

await s2.deleteText('tabc');
assert.ok(!files.has('texts/tabc.json'));
assert.equal(decode('index.json').texts.length, 0);
assert.equal(maxInflight, 1, 'writes must never overlap');
console.log('github-store: all checks passed');
