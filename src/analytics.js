/* مُعرِب — analytics.js
 * Who opened the app, when, and what they did there. The tracker keeps one record per
 * session (views, actions, Claude calls, active time) and hands it to the store, which keeps
 * it in the private data repo as analytics/<YYYY-MM>_<device>.json: one file per device per
 * month, so two devices never write the same file. summarize() turns those files into the
 * dashboard's numbers. Also loads under Node (module.exports) so tests can use it. */
(function (root) {
  'use strict';

  const IDLE_MS = 30 * 60 * 1000; // a pause this long ends the session; the next tap starts a new one
  const ACTIVE_GAP_MS = 2 * 60 * 1000; // longer gaps between interactions don't count as time spent
  const SAVE_EVERY_MS = 5 * 60 * 1000; // each save is a commit in the data repo, so save sparingly
  const FIRST_SAVE_MS = 10 * 1000;
  const MAX_TEXTS = 40;
  const DEVICE_KEY = 'murib-device-id';
  const NAME_KEY = 'murib-visitor';
  const VISIT_KEY = 'murib-visit'; // the current session, so a reload continues it

  function randomId(n) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(n);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (b) => abc[b % abc.length]).join('');
  }

  function local() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function getItem(k) {
    try { const s = local(); return (s && s.getItem(k)) || ''; } catch (e) { return ''; }
  }
  function setItem(k, v) {
    try { const s = local(); if (s) { if (v) s.setItem(k, v); else s.removeItem(k); } } catch (e) { /* private mode */ }
  }

  /** The name this device's visitor gave (lock screen or Settings), or ''. */
  function visitorName() { return getItem(NAME_KEY).trim(); }
  function setVisitorName(name) { setItem(NAME_KEY, String(name || '').trim().slice(0, 40)); }

  /** User agent → { os, browser, type: 'phone' | 'tablet' | 'desktop' }. */
  function parseUA(ua, touchPoints) {
    ua = String(ua || '');
    let os = 'غير معروف';
    if (/iPhone|iPod/.test(ua)) os = 'iPhone';
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) os = 'iPad'; // iPadOS asks for desktop sites
    else if (/Android/.test(ua)) os = 'Android';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
    else if (/Linux/.test(ua)) os = 'Linux';
    let browser = 'متصفح';
    if (/Edg[A]?\//.test(ua)) browser = 'Edge';
    else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
    else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
    else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
    else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
    else if (/Safari\//.test(ua)) browser = 'Safari';
    const type = os === 'iPad' || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet'
      : os === 'iPhone' || /Mobile/.test(ua) ? 'phone' : 'desktop';
    return { os, browser, type };
  }

  function monthOf(ms) { return new Date(ms).toISOString().slice(0, 7); }

  /**
   * createTracker({ save(device, session) → Promise, now?, env? })
   * env: { ua, touchPoints, width, height, lang, tz } (read from the browser when omitted).
   */
  function createTracker(o) {
    const clock = o.now || Date.now;
    const nav = root.navigator || {};
    const scr = root.screen || {};
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* old browser */ }
    const env = Object.assign({ ua: nav.userAgent, touchPoints: nav.maxTouchPoints || 0, width: scr.width, height: scr.height, lang: nav.language, tz }, o.env || {});
    let id = getItem(DEVICE_KEY);
    if (!/^[a-z0-9]{6,16}$/.test(id)) { id = randomId(10); setItem(DEVICE_KEY, id); }

    let sess = null; let lastAct = 0; let lastSave = 0; let dirty = false; let timer = 0; let unlock = '';

    function device() {
      return Object.assign({ id, name: visitorName() }, parseUA(env.ua, env.touchPoints),
        { lang: env.lang || '', tz: env.tz || '', screen: env.width ? `${env.width}×${env.height}` : '' });
    }
    function begin(t) {
      sess = { id: randomId(8), start: t, last: t, active: 0, unlock, views: {}, acts: {}, ai: {}, texts: [] };
      lastAct = t; dirty = true;
      lastSave = t - SAVE_EVERY_MS + FIRST_SAVE_MS; // the first save comes soon, so short visits count too
      later();
    }
    function later() {
      if (timer || !dirty) return;
      timer = setTimeout(() => { timer = 0; flush(); }, Math.max(0, lastSave + SAVE_EVERY_MS - clock()));
    }
    function flush() {
      clearTimeout(timer); timer = 0;
      if (!sess || !dirty) return Promise.resolve();
      dirty = false; lastSave = clock();
      const json = JSON.stringify(sess); const snap = JSON.parse(json);
      setItem(VISIT_KEY, json);
      return Promise.resolve()
        .then(() => o.save(device(), snap))
        .catch(() => { dirty = true; }); // tried again with the next save
    }
    /** A user interaction: extends the session (or starts a new one after a long pause). */
    function touch() {
      const t = clock();
      if (!sess || t - sess.last > IDLE_MS) {
        if (sess) flush();
        begin(t);
        return;
      }
      if (t - lastAct < ACTIVE_GAP_MS) sess.active += t - lastAct;
      lastAct = t; sess.last = t; dirty = true; later();
    }

    return {
      start(opts) {
        unlock = (opts && opts.unlock) || '';
        const t = clock(); let prev = null;
        try { prev = JSON.parse(getItem(VISIT_KEY) || 'null'); } catch (e) { /* start fresh */ }
        if (!prev || !prev.id || !prev.views || t - prev.last > IDLE_MS || t < prev.last) return begin(t);
        // iPhone reloads tabs it dropped from memory: within the idle window that is the same visit
        sess = prev; lastAct = t; dirty = true;
        lastSave = t - SAVE_EVERY_MS + FIRST_SAVE_MS; later();
      },
      activity: touch,
      view(name, textId) {
        touch();
        sess.views[name] = (sess.views[name] || 0) + 1;
        if (textId && !sess.texts.includes(textId) && sess.texts.length < MAX_TEXTS) sess.texts.push(textId);
      },
      act(name) { touch(); sess.acts[name] = (sess.acts[name] || 0) + 1; },
      /** One finished Claude call. Not an interaction: it does not extend the session. */
      ai(task, tier, r) {
        if (!sess) begin(clock());
        const k = `${task}:${tier}`; const a = sess.ai[k] || (sess.ai[k] = { n: 0, err: 0, ms: 0, in: 0, out: 0 });
        const u = r.usage || {};
        a.n++; if (!r.ok) a.err++;
        a.ms += Math.max(0, Math.round(r.ms || 0));
        a.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        a.out += u.output_tokens || 0;
        dirty = true; later();
      },
      flush,
      device,
      session: () => (sess ? JSON.parse(JSON.stringify(sess)) : null),
      setName(name) { setVisitorName(name); dirty = true; flush(); },
    };
  }

  // ───────────── dashboard numbers ─────────────

  const DAY = 24 * 60 * 60 * 1000;
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const add = (m, k, n) => { m[k] = (m[k] || 0) + n; };
  const sorted = (m) => Object.entries(m).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

  /** Visitors are people when they gave a name (the same name on two devices is one person). */
  function visitorKey(device) {
    const name = String((device && device.name) || '').trim();
    return name ? 'n:' + name.toLowerCase() : 'd:' + ((device && device.id) || '?');
  }

  /**
   * files: [{ device, sessions }] → numbers for the days [from, to] (local time), optionally one visitor.
   * Sessions are deduplicated by id, keeping the most recent copy.
   */
  function summarize(files, { from, to, who } = {}) {
    to = to || Date.now(); from = from == null ? 0 : from;
    const byId = new Map();
    for (const f of files || []) {
      if (!f || !f.device) continue;
      for (const s of f.sessions || []) {
        if (!s || !s.id || !s.start) continue;
        const cur = byId.get(s.id);
        if (!cur || (s.last || 0) >= (cur.s.last || 0)) byId.set(s.id, { s, device: f.device });
      }
    }
    const people = new Map();
    const all = [];
    for (const { s, device } of byId.values()) {
      const key = visitorKey(device);
      let p = people.get(key);
      if (!p) people.set(key, (p = { key, name: String(device.name || '').trim(), devices: new Map(), sessions: 0, active: 0, ai: 0, first: Infinity, last: 0, inRange: false }));
      p.devices.set(device.id, device);
      if (s.start < from || s.start > to) continue;
      all.push({ s, device, key });
    }

    const pick = who ? all.filter((x) => x.key === who) : all;
    const days = [];
    for (let d = startOfDay(Math.max(from, to - 400 * DAY)); d <= to; d += DAY) days.push({ day: dayKey(d), at: d, sessions: 0, people: new Set(), active: 0 });
    const dayIdx = new Map(days.map((d, i) => [d.day, i]));
    const hours = Array(24).fill(0);
    const views = {}; const acts = {}; const aiTask = {}; const aiTier = {}; const texts = {};
    const totals = { sessions: 0, active: 0, ai: 0, aiErr: 0, tokIn: 0, tokOut: 0 };

    for (const { s, device, key } of all) {
      const p = people.get(key);
      p.inRange = true; p.sessions++; p.active += s.active || 0;
      p.first = Math.min(p.first, s.start); p.last = Math.max(p.last, s.last || s.start);
      for (const a of Object.values(s.ai || {})) p.ai += a.n || 0;
      if (!p.lastDevice || (s.last || 0) >= p.lastAt) { p.lastDevice = device; p.lastAt = s.last || 0; }
    }
    for (const { s, key } of pick) {
      totals.sessions++; totals.active += s.active || 0;
      const i = dayIdx.get(dayKey(s.start));
      if (i != null) { days[i].sessions++; days[i].people.add(key); days[i].active += s.active || 0; }
      hours[new Date(s.start).getHours()]++;
      for (const [k, n] of Object.entries(s.views || {})) add(views, k, n);
      for (const [k, n] of Object.entries(s.acts || {})) add(acts, k, n);
      for (const t of s.texts || []) add(texts, t, 1);
      for (const [k, a] of Object.entries(s.ai || {})) {
        const [task, tier] = k.split(':');
        const t = aiTask[task] || (aiTask[task] = { n: 0, err: 0, in: 0, out: 0, ms: 0 });
        t.n += a.n || 0; t.err += a.err || 0; t.in += a.in || 0; t.out += a.out || 0; t.ms += a.ms || 0;
        const r = aiTier[tier] || (aiTier[tier] = { n: 0, in: 0, out: 0 });
        r.n += a.n || 0; r.in += a.in || 0; r.out += a.out || 0;
        totals.ai += a.n || 0; totals.aiErr += a.err || 0; totals.tokIn += a.in || 0; totals.tokOut += a.out || 0;
      }
    }

    const visitors = Array.from(people.values()).filter((p) => p.inRange)
      .map((p) => ({ key: p.key, name: p.name, device: p.lastDevice, devices: Array.from(p.devices.values()), sessions: p.sessions, active: p.active, ai: p.ai, first: p.first, last: p.last }))
      .sort((a, b) => b.last - a.last);
    return {
      totals: Object.assign(totals, { visitors: who ? (pick.length ? 1 : 0) : visitors.length }),
      visitors,
      sessions: pick.map(({ s, device, key }) => Object.assign({}, s, { device, who: key })).sort((a, b) => b.start - a.start),
      days: days.map((d) => ({ day: d.day, at: d.at, sessions: d.sessions, people: d.people.size, active: d.active })),
      hours,
      views: sorted(views),
      acts: sorted(acts),
      texts: sorted(texts),
      ai: Object.entries(aiTask).sort((a, b) => b[1].n - a[1].n),
      tiers: aiTier,
    };
  }

  const api = { createTracker, summarize, parseUA, visitorKey, visitorName, setVisitorName, monthOf, IDLE_MS };
  root.MuribAnalytics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
