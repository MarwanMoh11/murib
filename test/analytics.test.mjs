// Exercises src/analytics.js (tracker, summarize) and the visit log in src/platform/github-store.js.
import assert from 'node:assert/strict';
import '../src/analytics.js';
import { createGithubStore } from '../src/platform/github-store.js';

const A = globalThis.MuribAnalytics;
const MIN = 60 * 1000;

// ── tracker: sessions, active time, Claude calls ──
let t = Date.UTC(2026, 9, 18, 9, 0);
const saves = [];
const tr = A.createTracker({ now: () => t, save: (d, s) => { saves.push({ d, s }); }, env: { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } });
tr.start({ unlock: 'password' });
tr.view('library');
t += MIN; tr.act('openText'); tr.view('text:sent', 'tabc');
t += 5 * MIN; tr.activity(); // a 5-minute gap is not counted as use
t += 30 * 1000; tr.view('text:read', 'tabc');
tr.ai('analyze', 'fast', { ok: true, ms: 9000, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50 } });
tr.ai('chat', 'fast', { ok: false, ms: 1000 });
await tr.flush();
let s = saves.at(-1).s;
assert.equal(s.unlock, 'password');
assert.equal(s.active, MIN + 30 * 1000);
assert.deepEqual(s.views, { library: 1, 'text:sent': 1, 'text:read': 1 });
assert.deepEqual(s.texts, ['tabc']);
assert.deepEqual(s.ai['analyze:fast'], { n: 1, err: 0, ms: 9000, in: 120, out: 50 });
assert.equal(s.ai['chat:fast'].err, 1);
assert.deepEqual([saves.at(-1).d.os, saves.at(-1).d.browser, saves.at(-1).d.type], ['iPhone', 'Safari', 'phone']);
const first = s.id;
t += 31 * MIN; tr.activity(); // a long pause starts a new session
await tr.flush();
assert.notEqual(saves.at(-1).s.id, first);
assert.equal(saves.at(-1).s.unlock, 'password');
assert.equal(saves.filter((x) => x.s.id === first).length, 1, 'the old session is not saved again when nothing changed');

assert.equal(A.parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5).os, 'iPad');
assert.equal(A.parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0').browser, 'Edge');

// ── summarize: people, ranges, per-visitor filter ──
const day = 24 * 60 * MIN;
const now = new Date(2026, 9, 18, 20, 0).getTime();
const sess = (id, start, extra) => Object.assign({ id, start, last: start + 10 * MIN, active: 8 * MIN, views: { library: 1 }, acts: {}, ai: {}, texts: [] }, extra);
const files = [
  { device: { id: 'aaaaaa', name: 'Sara', os: 'iPhone' }, sessions: [sess('s1', now - 2 * 3600e3, { ai: { 'analyze:fast': { n: 3, err: 0, in: 10, out: 5 } } }), sess('s2', now - 3 * day)] },
  { device: { id: 'bbbbbb', name: 'sara ', os: 'Windows' }, sessions: [sess('s3', now - day, { views: { review: 4 } })] },
  { device: { id: 'cccccc', name: '', os: 'Android' }, sessions: [sess('s4', now - 40 * day), sess('s5', now - 5 * 3600e3)] },
  { device: { id: 'aaaaaa', name: 'Sara' }, sessions: [sess('s1', now - 2 * 3600e3, { last: now, active: 20 * MIN, ai: { 'analyze:fast': { n: 3, err: 0, in: 10, out: 5 } } })] }, // a newer copy of s1
];
const from = new Date(2026, 9, 18).getTime() - 29 * day;
const r = A.summarize(files, { from, to: now });
assert.equal(r.totals.sessions, 4, 's4 is out of range, s1 is counted once');
assert.equal(r.totals.visitors, 2, 'the same name on two devices is one person');
const sara = r.visitors.find((v) => v.key === 'n:sara');
assert.equal(sara.sessions, 3);
assert.equal(sara.devices.length, 2);
assert.equal(sara.active, 20 * MIN + 8 * MIN + 8 * MIN, 'the newer copy of s1 wins');
assert.equal(r.days.length, 30);
assert.equal(r.days.at(-1).sessions, 2);
assert.equal(r.days.at(-1).people, 2);
assert.deepEqual(r.views[0], ['review', 4]);
assert.equal(r.totals.ai, 3);
const one = A.summarize(files, { from, to: now, who: 'd:cccccc' });
assert.equal(one.totals.sessions, 1);
assert.equal(one.totals.visitors, 1);
assert.equal(one.visitors.length, 2, 'the visitor list stays complete under a filter');

// ── store: one file per device per month; two tabs on one device keep both sessions ──
const files2 = new Map();
let n = 0;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.pathname === '/repos/me/data') return json(200, {});
  const path = decodeURIComponent(u.pathname.replace('/repos/me/data/contents/', ''));
  const method = opts.method || 'GET';
  if (method === 'GET' && path === 'analytics') {
    const list = [...files2.keys()].filter((p) => p.startsWith('analytics/')).map((p) => ({ type: 'file', name: p.slice(10), path: p }));
    return list.length ? json(200, list) : json(404, {});
  }
  if (method === 'GET') return files2.has(path) ? json(200, { sha: files2.get(path).sha, encoding: 'base64', content: files2.get(path).content }) : json(404, {});
  const body = JSON.parse(opts.body);
  if ((files2.get(path)?.sha || undefined) !== body.sha) return json(409, {});
  const sha = 's' + n++;
  files2.set(path, { sha, content: body.content });
  return json(200, { content: { sha } });
};
const decode = (p) => JSON.parse(Buffer.from(files2.get(p).content, 'base64').toString('utf8'));
const dev = { id: 'dev123', name: 'Sara', os: 'iPhone' };
const tab1 = createGithubStore({ token: 'tok', repo: 'me/data' });
const tab2 = createGithubStore({ token: 'tok', repo: 'me/data' });
const oct = Date.UTC(2026, 9, 18, 9);
assert.deepEqual(await tab1.loadVisits(0), [], 'no analytics folder yet');
await tab1.saveVisit(dev, sess('a1', oct));
await tab1.saveVisit(dev, sess('a1', oct, { active: 30 * MIN, last: oct + 40 * MIN }));
await tab2.saveVisit(dev, sess('b1', oct + 5 * MIN)); // the other tab has never read the file
await tab1.saveVisit(dev, sess('a2', oct + 2 * 3600e3)); // tab1's sha is stale now: 409, then merge
const log = decode('analytics/2026-10_dev123.json');
assert.deepEqual(log.sessions.map((x) => x.id), ['a1', 'b1', 'a2']);
assert.equal(log.sessions[0].active, 30 * MIN);
await tab1.saveVisit(dev, sess('n1', Date.UTC(2026, 10, 2)));
assert.ok(files2.has('analytics/2026-11_dev123.json'), 'a new month starts a new file');
const novOnly = await tab2.loadVisits(Date.UTC(2026, 10, 1));
assert.deepEqual(novOnly.map((f) => f.sessions.length), [1]);
assert.equal((await tab2.loadVisits(0)).length, 2);
await tab2.saveVisit(dev, sess('b1', oct + 5 * MIN, { last: oct + 50 * MIN }));
assert.deepEqual(decode('analytics/2026-10_dev123.json').sessions.map((x) => x.id), ['a1', 'b1', 'a2'], 'reading the logs never drops sessions');
console.log('analytics: all checks passed');
