/* مُعرِب — app.js
 * Vanilla JS. Three layers: Store (persistence, injected by the platform; mock = localStorage),
 * AI (Claude, injected by the platform; mock for #mock) and the UI.
 * Entry point: window.MuribApp.boot({ ai, store, onLock, mode }). */
(function () {
'use strict';
const C = window.MuribCore;

// ───────────── utils ─────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zh = (s, cls) => `<span lang="zh-CN" dir="ltr"${cls ? ` class="${cls}"` : ''}>${esc(s)}</span>`;
const now = () => Date.now();
const rand4 = () => Math.random().toString(36).slice(2, 6).padEnd(4, 'x');
const clone = (o) => JSON.parse(JSON.stringify(o));
const cancelled = () => ({ code: 'cancelled', message: 'cancelled' });
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(cancelled()); }, { once: true });
});
const fmtDate = (ms) => {
  try { return new Date(ms).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (e) { return new Date(ms).toISOString().slice(0, 10); }
};
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const GROUPS = {};
C.ROLE_GROUPS.forEach((g) => { GROUPS[g.key] = g; });
const gcls = (key) => 'g-' + ({ link: 'pivot', part: 'other' }[key] || key);
const QUIZ_GROUPS = ['subj', 'pred', 'obj', 'attr', 'adv', 'comp'];

const ic = (d, extra) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra || ''}>${d}</svg>`;
const ICON = {
  settings: ic('<path d="M3 6h9M17 6h4M3 12h4M12 12h9M3 18h11M19 18h2"/><circle cx="14.5" cy="6" r="2.5"/><circle cx="9.5" cy="12" r="2.5"/><circle cx="16.5" cy="18" r="2.5"/>'),
  library: ic('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  cards: ic('<rect x="3" y="8" width="14" height="12" rx="2"/><path d="M7 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/>'),
  ccw: ic('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  cw: ic('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
  copy: ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>'),
  chat: ic('<path d="M4 5h16v11H9l-5 4z"/>'),
  check: ic('<path d="M5 12l5 5 9-10"/>'),
  stop: ic('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
  up: ic('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  trash: ic('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  camera: ic('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  lock: ic('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  back: ic('<path d="M9 6l6 6-6 6"/>'),
  next: ic('<path d="M15 6l-6 6 6 6"/>'),
  chev: ic('<path d="M6 9l6 6 6-6"/>'),
  info: ic('<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>'),
  retry: ic('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>'),
};

// ───────────── mock data (local testing, inert without #mock) ─────────────
const MOCK = {
  egypt: {
    title: '中国外交部长访问埃及',
    paragraphs: [
      '《金字塔报》的一位记者写了一篇关于中东的文章，谈到了中国外交部长访问埃及的事。作者在文章中写道：',
      '中国外交部长昨晚抵达埃及，带着一份中国主席给埃及总统的重要信件。在那信件中，中国国家主席谈到了中东局势，表达了他对这一地区和平问题的高度关注。',
      '中国国家主席已经与其他国家领导全面研究了中东问题，外交部长向埃及总统转达他对这一问题的看法。阿拉伯人民渴望和平，将来可以实现和平、维护和平。',
    ],
  },
};


// ───────────── profile / srs defaults ─────────────
const defaultProfile = () => ({ known: [], settings: { tier: 'best', showPinyin: true } });
const defaultSrs = () => ({ cards: {} });
function normProfile(p) {
  const d = defaultProfile();
  p = p && typeof p === 'object' ? p : {};
  const s = Object.assign({}, d.settings, p.settings || {});
  if (s.tier === 'complex') s.tier = 'best';
  if (s.tier === 'default') s.tier = 'fast';
  if (s.tier !== 'best' && s.tier !== 'fast') s.tier = 'best';
  return { known: Array.isArray(p.known) ? p.known.filter((x) => typeof x === 'string') : [], settings: s };
}

// ───────────── Store: injected at boot() (platform store, or the mock below) ─────────────
// Interface: init, listTexts, loadText, saveTextMeta, saveChunk, deleteText, loadProfile, saveProfile, loadSrs, saveSrs.
let Store = null;

/** Serialises writes per key (latest wins), debounces if asked, tracks saving / failed state for the UI. */
const Saver = (() => {
  const writers = new Map();
  const failed = new Map();
  let touched = false;
  const api = {
    status() {
      let busy = false;
      writers.forEach((w) => { if (w.has || w.busy || w.timer) busy = true; });
      return failed.size ? 'error' : busy ? 'saving' : touched ? 'saved' : 'idle';
    },
    put(key, data, fn, delay) {
      touched = true; failed.delete(key);
      let w = writers.get(key);
      if (!w) {
        w = { latest: null, has: false, busy: false, timer: 0, p: Promise.resolve(), fn, go: null };
        w.go = () => {
          w.timer = 0;
          if (w.busy) return w.p;
          w.busy = true;
          w.p = (async () => {
            try {
              while (w.has) {
                const d = w.latest; w.has = false;
                try { await w.fn(d); failed.delete(key); } catch (e) { failed.set(key, { data: d, fn: w.fn, err: e }); }
                if (typeof updateSaveInd === 'function') updateSaveInd();
              }
            } finally { w.busy = false; if (typeof updateSaveInd === 'function') updateSaveInd(); }
          })();
          return w.p;
        };
        writers.set(key, w);
      }
      w.latest = data; w.has = true; w.fn = fn;
      clearTimeout(w.timer);
      if (delay) w.timer = setTimeout(w.go, delay); else w.go();
      if (typeof updateSaveInd === 'function') updateSaveInd();
    },
    flush() { writers.forEach((w) => { if (w.has && !w.busy) { clearTimeout(w.timer); w.go(); } }); },
    async drop(prefix) {
      const ps = [];
      writers.forEach((w, k) => { if (k.startsWith(prefix)) { clearTimeout(w.timer); w.timer = 0; w.has = false; ps.push(w.p); } });
      failed.forEach((_, k) => { if (k.startsWith(prefix)) failed.delete(k); });
      await Promise.all(ps);
    },
    retry() { const list = Array.from(failed.entries()); list.forEach(([k, f]) => api.put(k, f.data, f.fn, 0)); },
    reset() { writers.forEach((w) => clearTimeout(w.timer)); writers.clear(); failed.clear(); touched = false; },
  };
  return api;
})();

/** localStorage-backed store for the #mock mode (falls back to memory if storage throws). */
function makeMockStore() {
  const KEY = 'murib:v1:mock';
  let mem = { profile: null, srs: null, texts: {}, chunks: {} };
  let ok = true;
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (e) { ok = false; } };
  const lag = () => sleep(120);
  return {
    kind: 'local',
    async init() {
      try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); if (d) mem = Object.assign(mem, d); } catch (e) { ok = false; }
    },
    async listTexts() { return Object.values(mem.texts).map((t) => clone(t)); },
    async loadText(id) {
      const m = mem.texts[id]; if (!m) return null;
      const t = clone(m); t.analyses = {};
      Object.values(mem.chunks[id] || {}).forEach((a) => Object.assign(t.analyses, clone(a)));
      return t;
    },
    async saveTextMeta(text) { await lag(); const m = clone(text); delete m.analyses; mem.texts[text.id] = m; persist(); },
    async saveChunk(textId, chunkId, analyses) { await lag(); (mem.chunks[textId] = mem.chunks[textId] || {})[chunkId] = clone(analyses); persist(); },
    async deleteText(id) { await lag(); delete mem.texts[id]; delete mem.chunks[id]; persist(); },
    async loadProfile() { return normProfile(mem.profile); },
    async saveProfile(p) { await lag(); mem.profile = clone(p); persist(); },
    async loadSrs() { return mem.srs && mem.srs.cards ? clone(mem.srs) : defaultSrs(); },
    async saveSrs(s) { await lag(); mem.srs = clone(s); persist(); },
    persistent: () => ok,
  };
}

// ───────────── AI: wraps the injected backend (platform ai, or the mock) ─────────────
// UI tiers: 'best' / 'fast'. Rejections: { code, message, text? }. At most 2 calls run at once.
const AI = (() => {
  let ext = null; let lim = null;
  const Q = { max: 2, active: 0, waiting: [] };
  function pump() {
    while (Q.active < Q.max && Q.waiting.length) {
      const j = Q.waiting.shift(); Q.active++;
      Promise.resolve().then(j.fn).then(j.resolve, j.reject).finally(() => { Q.active--; pump(); });
    }
  }
  function qrun(fn, signal, priority) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(cancelled());
      const job = { fn, resolve, reject };
      if (signal) signal.addEventListener('abort', () => {
        const i = Q.waiting.indexOf(job);
        if (i >= 0) { Q.waiting.splice(i, 1); reject(cancelled()); }
      }, { once: true });
      if (priority) Q.waiting.unshift(job); else Q.waiting.push(job);
      pump();
    });
  }
  return {
    attach(b) { ext = b; lim = null; },
    available() { return !!ext; },
    async loadLimits() {
      try { lim = await ext.limits(); } catch (e) { lim = {}; }
      return lim;
    },
    limits() { return lim || {}; },
    json(prompt, o = {}) {
      if (!ext) return Promise.reject({ code: 'sampling_disabled', message: 'unavailable' });
      const r = { task: o.task, tier: o.tier || 'best' };
      if (o.signal) r.signal = o.signal;
      if (o.fresh) r.fresh = true;
      if (o.images && o.images.length) r.images = o.images;
      if (o.tag && S.mock) r.tag = o.tag; // mock-only routing hint
      return qrun(() => ext.json(prompt, r), o.signal, o.priority);
    },
    stream(turns, o = {}) {
      if (!ext) return Promise.reject({ code: 'sampling_disabled', message: 'unavailable' });
      const r = { task: 'chat', tier: o.tier || 'fast' };
      if (o.signal) r.signal = o.signal;
      if (o.onText) r.onText = o.onText;
      return qrun(() => ext.stream(turns, r), o.signal, true);
    },
  };
})();

function errMsg(e) {
  const c = e && e.code;
  if (c === 'auth_failed' || c === 'not_granted') return 'مفتاح الـAPI غير صالح أو أُلغي. افتح الإعداد وأدخل مفتاحًا جديدًا.';
  if (c === 'no_credit') return 'نفد رصيد الـAPI. اشحن الرصيد من console.anthropic.com.';
  if (c === 'overloaded') return 'Claude مشغول الآن. انتظر دقيقة ثم اضغط «أعد المحاولة».';
  if (c === 'storage_failed') return 'تعذّر الحفظ في GitHub. تحقّق من الاتصال ثم أعد المحاولة.';
  if (c === 'rate_limited' || c === 'queue_overflow') return 'وصلت إلى حدّ الاستخدام مؤقتًا. انتظر قليلًا ثم اضغط «أعد المحاولة».';
  if (c === 'session_expired') return 'انتهت جلستك في Claude. سجّل الدخول ثم حاول مجددًا.';
  if (c === 'image_rejected') return 'تعذّر قراءة هذه الصورة. جرّب صورة JPG أو PNG أوضح.';
  if (c === 'prompt_too_large') return 'النص طويل جدًا. قسّمه إلى نصين.';
  if (c === 'invalid_json') return 'وصل رد غير مكتمل. اضغط «أعد المحاولة».';
  if (c === 'refused') return 'رفض Claude هذا الطلب. عدّل النص ثم حاول مجددًا.';
  if (c === 'sampling_disabled' || c === 'not_declared') return 'Claude غير متاح في هذا العرض.';
  return 'انقطع الاتصال. اضغط «أعد المحاولة».';
}
const isCancel = (e) => !!e && e.code === 'cancelled';

// ───────────── mock Claude backend (#mock only) ─────────────
function makeMockAI() {
  const failed = new Set();
  const ids = (prompt, from, to) => {
    const a = prompt.indexOf(from); if (a < 0) return [];
    const b = prompt.indexOf(to, a); const seg = prompt.slice(a, b < 0 ? undefined : b);
    const out = []; const re = /^(S\d+): (.*)$/gm; let m;
    while ((m = re.exec(seg))) out.push({ id: m[1], text: m[2] });
    return out;
  };
  const fakeAnalysis = (s) => {
    const chars = [...C.stripPunct(s.text)]; const words = [];
    for (let i = 0; i < chars.length; i += 2) words.push(chars.slice(i, i + 2).join(''));
    const gs = C.ROLE_GROUPS;
    const ws = words.map((w, k) => ({ w, py: 'pīnyīn', pos: 'اسم', pos_zh: '名词', role: gs[k % 5].ar, role_zh: gs[k % 5].zh, irab: 'إعراب تجريبي', mean: 'معنى' + (k + 1) }));
    return {
      id: s.id, words: ws,
      parts: ws.map((w) => ({ text: w.w, role: w.role, role_zh: w.role_zh })),
      structure_ar: 'مبتدأ + خبر + مفعول به (تجريبي)', translation_ar: 'ترجمة تجريبية',
      patterns: s.bold && s.bold.length ? [{ zh: s.bold[0], py: 'pīnyīn', ar: 'تركيب تجريبي', explain_ar: 'شرح تجريبي للتركيب.', example_zh: '这是例子。', example_ar: 'هذا مثال.', emphasized: true }] : [],
      notes_ar: [],
    };
  };
  const fromSample = (list) => {
    const S0 = window.MURIB_SAMPLE;
    if (!S0 || !S0.analyses || !S0.doc) return null;
    const out = [];
    for (const s of list) {
      const ss = S0.doc.sentences.find((x) => x.id === s.id && x.text === s.text);
      if (!ss || !S0.analyses[s.id]) return null;
      out.push(Object.assign({ id: s.id }, clone(S0.analyses[s.id])));
    }
    return out;
  };
  return {
    async limits() { return { images: { maxCount: 8, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } }; },
    async stream(turns, o = {}) {
      await sleep(500, o.signal);
      const pieces = ['فهمت سؤالك. ', 'هذا شرح مبسّط مثال: ', '**المبتدأ** هو ما نبدأ به الجملة.\n', '- ثم يأتي الخبر.\n- وبعده المفعول به.'];
      let text = '';
      for (const p of pieces) { await sleep(350, o.signal); text += p; if (o.onText) o.onText({ text, delta: p }); }
      return { text, truncated: false };
    },
    async json(prompt, o = {}) {
      await sleep(600, o.signal);
      const tag = o.tag || '';
      if (o.task === 'ocr') {
        const m = /page (\d+) of (\d+)/.exec(prompt); const p = +m[1]; const n = +m[2]; const E = MOCK.egypt;
        const unc = [{ text: '近', context: '中国外交部长', reason_ar: 'الحرف غير واضح في الصورة' }];
        if (n === 1) return { title: E.title, paragraphs: E.paragraphs, uncertain: unc, notes_ar: '' };
        if (p === 1) return { title: E.title, paragraphs: E.paragraphs.slice(0, 2), uncertain: unc, notes_ar: 'الصفحة مائلة قليلًا.' };
        return { title: '', paragraphs: E.paragraphs.slice(2), uncertain: [], notes_ar: '' };
      }
      if (o.task === 'overview') {
        const S0 = window.MURIB_SAMPLE;
        if (S0 && S0.overview && S0.doc && prompt.includes(S0.doc.title)) return clone(S0.overview);
        return { title_ar: 'عنوان تجريبي', genre_ar: 'خبر صحفي', main_idea_ar: 'الفكرة الرئيسية التجريبية للنص.', purpose_ar: 'غرض تجريبي.', paragraphs: [{ n: 1, idea_ar: 'فكرة الفقرة الأولى.' }, { n: 2, idea_ar: 'فكرة الفقرة الثانية.' }], glossary: [{ zh: '埃及', py: 'Āijí', ar: 'مصر', note_ar: '' }, { zh: '外交部长', py: 'wàijiāo bùzhǎng', ar: 'وزير الخارجية', note_ar: 'منصب' }], tips_ar: ['انتبه لزمن الفعل.', 'استعمل الاسم العربي المعتمد للمؤسسات.'] };
      }
      if (o.task === 'analyze' || o.task === 'review') {
        const review = o.task === 'review';
        if (!review && tag === 'analyze:c3' && !failed.has('c3')) { failed.add('c3'); throw { code: 'overloaded', message: 'mock failure' }; }
        const list = review ? ids(prompt, 'THE SENTENCES (id: text):', "FIRST EXAMINER'S") : ids(prompt, 'ANALYZE THESE SENTENCES (id: text):', 'FIELDS FOR EACH SENTENCE');
        const sentences = fromSample(list) || list.map((s) => {
          const bold = []; const m = /EMPHASIZED in the handout: (.*)/.exec(prompt.slice(prompt.indexOf(s.id + ': ' + s.text)));
          if (m && m[1] !== 'none') m[1].split(' ، ').forEach((b) => bold.push(b));
          return fakeAnalysis({ id: s.id, text: s.text, bold });
        });
        return review ? { changes_ar: ['تجربة: لا أخطاء'], sentences } : { sentences };
      }
      if (o.task === 'grade') {
        return { score: 7.5, verdict_ar: 'ترجمة جيدة بها خطآن بسيطان.', errors: [{ type: 'معنى', student: 'الوزير الخارجي', fix: 'وزير الخارجية', why_ar: 'اسم المنصب المعتمد.' }, { type: 'زمن/نفي', student: 'يصل', fix: 'وصل', why_ar: 'الفعل في الماضي في النص الصيني.' }], corrected_ar: 'وصل وزير الخارجية الصيني إلى مصر أمس.', model_ar: 'وصل وزير الخارجية الصيني إلى مصر ليلة أمس.' };
      }
      return {};
    },
  };
}

// ───────────── state ─────────────
const S = {
  route: { name: 'library' },
  ready: false, mock: false, mode: '', onLock: null, loaded: new Set(), loadErr: {}, loadingAll: false,
  profile: defaultProfile(), known: new Set(), srs: defaultSrs(),
  texts: [], ui: { showNum: true, tint: true, wf: 'all', dedupe: false, openParas: {}, tab: {} },
  sheet: null, chats: {}, ctrls: {}, live: new Set(), reviewing: new Set(), reviewErr: {},
  nt: null, rv: null, quiz: null, grade: {}, confirm: null, toastMsg: '',
};

const tierOf = () => S.profile.settings.tier;
const sampleText = () => (window.MURIB_SAMPLE ? Object.assign(window.MURIB_SAMPLE, { isSample: true, id: 'sample' }) : null);
function allTexts() {
  const s = sampleText();
  const mine = S.texts.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return s ? [s, ...mine] : mine;
}
const getText = (id) => allTexts().find((t) => t.id === id) || null;
const canClaude = () => AI.available();

function saveProfile() { Saver.put('profile', S.profile, (p) => Store.saveProfile(p), 800); }
function saveSrs() { Saver.put('srs', S.srs, (p) => Store.saveSrs(p), 800); }
function setKnown(w, on) {
  if (on) S.known.add(w); else S.known.delete(w);
  S.profile.known = Array.from(S.known); saveProfile();
}
function addKnownMany(ws) { ws.forEach((w) => S.known.add(w)); S.profile.known = Array.from(S.known); saveProfile(); }

let rrPending = false;
function rr() {
  if (rrPending) return;
  rrPending = true;
  const run = () => { if (!rrPending) return; rrPending = false; render(); };
  requestAnimationFrame(run); setTimeout(run, 100); // timer covers background tabs, where rAF is paused
}

// ───────────── derived data ─────────────
const TOK = new WeakMap();
function tokensFor(s, a) {
  if (!a) return null;
  let r = TOK.get(a);
  if (r && r.text === s.text) return r;
  const al = C.alignWords(s.text, a.words);
  const emph = new Set();
  al.tokens.forEach((t) => {
    if (t.type === 'word' && (s.boldRanges || []).some(([x, y]) => t.start < y && t.end > x)) emph.add(t.index);
  });
  r = { tokens: al.tokens, ok: al.ok, emph, text: s.text };
  TOK.set(a, r);
  return r;
}
const analysisOf = (t, sid) => (t.analyses && t.analyses[sid]) || null;

function sentLabels(t) {
  const out = {}; let ord = 0;
  t.doc.sentences.forEach((s) => {
    if (s.para === 0) out[s.id] = { short: 'العنوان', ord: 0, text: 'العنوان' };
    else { ord++; out[s.id] = { short: 'الجملة ' + ord, ord, text: `الجملة ${ord} · الفقرة ${s.para}` }; }
  });
  return out;
}

/** Word instances in sentence order. n = running number (null after the first unfinished sentence). */
function instances(t) {
  const out = []; let n = 0; let blocked = false;
  t.doc.sentences.forEach((s) => {
    const a = analysisOf(t, s.id);
    if (!a) { blocked = true; return; }
    const tk = tokensFor(s, a);
    a.words.forEach((w, i) => {
      out.push({ tid: t.id, sid: s.id, i, w, para: s.para, emph: tk.emph.has(i), n: blocked ? null : ++n });
    });
  });
  return out;
}
function numberStarts(t) {
  const starts = {}; let n = 0; let blocked = false;
  t.doc.sentences.forEach((s) => {
    const a = analysisOf(t, s.id);
    if (!a) { blocked = true; return; }
    if (!blocked) { starts[s.id] = n + 1; n += a.words.length; }
  });
  return starts;
}
function uniqueWords(list) {
  const m = new Map();
  list.forEach((t) => instances(t).forEach((x) => {
    const e = m.get(x.w.w);
    if (!e) m.set(x.w.w, { w: x.w.w, first: x, occ: [x] }); else e.occ.push(x);
  }));
  return m;
}
const isLoaded = (t) => t.isSample || S.loaded.has(t.id);
const textStats = (t) => {
  if (!isLoaded(t)) { const st = t.stats || {}; return { words: st.words == null ? null : st.words, fresh: st.newWordsHint == null ? null : st.newWordsHint, hint: true }; }
  const inst = instances(t); const uni = new Set(inst.map((x) => x.w.w));
  let fresh = 0; uni.forEach((w) => { if (!S.known.has(w)) fresh++; });
  return { words: inst.length, fresh };
};
function chunkProgress(t) {
  const cs = t.chunkState || {}; const total = t.doc.chunks.length;
  let done = 0; let running = 0; let err = 0;
  t.doc.chunks.forEach((c) => { const s = (cs[c.id] || {}).status; if (s === 'done') done++; else if (s === 'running') running++; else if (s === 'error') err++; });
  return { total, done, running, err, pending: total - done - running - err };
}
const isRunning = (t) => !t.isSample && (t.overviewStatus === 'running' || chunkProgress(t).running > 0);
function statusOf(t) {
  if (t.isSample) return 'ready';
  const p = chunkProgress(t);
  if (isRunning(t)) return 'running';
  return p.done === p.total && t.overviewStatus === 'done' ? 'ready' : 'partial';
}
const needsResume = (t) => !t.isSample && !isRunning(t) && (chunkProgress(t).done < t.doc.chunks.length || t.overviewStatus !== 'done');

function chunkSentences(t, c) { const set = new Set(c.sentenceIds); return t.doc.sentences.filter((s) => set.has(s.id)); }
const chunkOf = (t, sid) => t.doc.chunks.find((c) => c.sentenceIds.includes(sid));
const pickAnalyses = (t, sents) => { const o = {}; sents.forEach((s) => { if (t.analyses[s.id]) o[s.id] = t.analyses[s.id]; }); return o; };

function translationOf(t, sentences) {
  return sentences.map((s) => (analysisOf(t, s.id) || {}).translation_ar || '').filter(Boolean).join(' ');
}
function paraSentences(t, p) { return t.doc.sentences.filter((s) => s.para === p); }
function allPatterns(t) {
  const m = new Map();
  t.doc.sentences.forEach((s) => {
    const a = analysisOf(t, s.id); if (!a) return;
    a.patterns.forEach((p) => {
      const e = m.get(p.zh);
      if (!e) m.set(p.zh, Object.assign({}, p, { sids: [s.id] }));
      else { e.sids.push(s.id); if (p.emphasized) e.emphasized = true; }
    });
  });
  return Array.from(m.values());
}

// ───────────── records & pipeline ─────────────
function newTextRecord(course, title, paragraphs) {
  const doc = C.buildDocument({ title, paragraphs });
  const t = {
    id: 't' + now().toString(36) + rand4(), course, title, paragraphs, createdAt: now(), updatedAt: now(),
    doc, overview: null, overviewStatus: 'pending', overviewError: '', chunkState: {}, analyses: {}, promptVersion: C.PROMPT_VERSION,
  };
  ensureChunkState(t);
  return t;
}
function ensureChunkState(t) {
  t.chunkState = t.chunkState || {}; t.analyses = t.analyses || {};
  t.doc.chunks.forEach((c) => {
    const cs = t.chunkState[c.id] || (t.chunkState[c.id] = { status: 'pending', error: '', warnings: [], changes_ar: [], reviewedAt: 0 });
    if (cs.status === 'running' && !S.live.has(t.id + ':' + c.id)) cs.status = 'pending';
  });
  if (t.overviewStatus === 'running' && !S.live.has(t.id + ':ov')) t.overviewStatus = t.overview ? 'done' : 'pending';
}
function metaOf(t) { const m = Object.assign({}, t); delete m.analyses; m.stats = { words: textStats(t).words, newWordsHint: textStats(t).fresh }; return m; }
function persistMeta(t) {
  if (t.isSample || !S.texts.includes(t) || !isLoaded(t)) return;
  t.updatedAt = now(); Saver.put('t:' + t.id, metaOf(t), (m) => Store.saveTextMeta(m), 0);
}
function saveChunkDoc(t, id, analyses) { if (S.texts.includes(t)) Saver.put('c:' + t.id + ':' + id, analyses, (a) => Store.saveChunk(t.id, id, a), 0); }
async function ensureLoaded(t) {
  if (isLoaded(t)) return t;
  if (S.loadErr[t.id] === 'loading') return t;
  S.loadErr[t.id] = 'loading';
  try {
    const full = await Store.loadText(t.id);
    if (full) Object.assign(t, full);
    t.analyses = t.analyses || {};
    S.loaded.add(t.id); ensureChunkState(t); delete S.loadErr[t.id];
  } catch (e) { S.loadErr[t.id] = errMsg({ code: 'storage_failed' }); }
  rr();
  return t;
}
async function ensureAllLoaded() {
  S.loadingAll = true; rr();
  await Promise.all(allTexts().map((t) => (S.loadErr[t.id] === 'loading' ? null : ensureLoaded(t))));
  S.loadingAll = false; rr();
}
function ctrlOf(t) {
  let c = S.ctrls[t.id];
  if (!c || c.signal.aborted) c = S.ctrls[t.id] = new AbortController();
  return c;
}
function stopAnalysis(t) {
  const c = S.ctrls[t.id]; if (c) c.abort();
  t.doc.chunks.forEach((ch) => { const cs = t.chunkState[ch.id]; if (cs && cs.status === 'running' && !S.live.has(t.id + ':' + ch.id + ':call')) cs.status = 'pending'; });
  rr();
}

async function runOverview(t, signal) {
  S.live.add(t.id + ':ov');
  try {
    const raw = await AI.json(C.overviewPrompt({ doc: t.doc, course: t.course }), { task: 'overview', tier: tierOf(), signal, tag: 'overview' });
    t.overview = C.normalizeOverview(raw); t.overviewStatus = 'done'; t.overviewError = '';
  } catch (e) {
    if (isCancel(e)) t.overviewStatus = t.overview ? 'done' : 'pending';
    else { t.overviewStatus = 'error'; t.overviewError = errMsg(e); }
  } finally { S.live.delete(t.id + ':ov'); }
  persistMeta(t); rr();
}

async function runChunk(t, id, { force = false, signal } = {}) {
  const key = t.id + ':' + id; const cs = t.chunkState[id]; const chunk = t.doc.chunks.find((c) => c.id === id);
  S.live.add(key);
  try {
    if (signal.aborted) throw cancelled();
    const sentences = chunkSentences(t, chunk);
    const prompt = C.analyzePrompt({ doc: t.doc, course: t.course, glossary: t.overview && t.overview.glossary, sentences });
    S.live.add(key + ':call');
    const raw = await AI.json(prompt, { task: 'analyze', tier: tierOf(), signal, fresh: !!force, tag: 'analyze:' + id });
    const res = C.normalizeChunk(raw, sentences);
    if (!Object.keys(res.analyses).length) throw { code: 'invalid_json', message: 'empty' };
    Object.assign(t.analyses, res.analyses);
    cs.status = 'done'; cs.error = ''; cs.warnings = res.warnings;
    saveChunkDoc(t, id, res.analyses);
  } catch (e) {
    if (isCancel(e)) { cs.status = 'pending'; cs.error = ''; } else { cs.status = 'error'; cs.error = errMsg(e); }
  } finally { S.live.delete(key); S.live.delete(key + ':call'); }
  persistMeta(t); rr();
}

async function startAnalysis(t) {
  if (t.isSample || !canClaude() || isRunning(t)) return;
  const ctrl = ctrlOf(t); ensureChunkState(t);
  const ids = t.doc.chunks.map((c) => c.id).filter((id) => t.chunkState[id].status !== 'done');
  const needOv = t.overviewStatus !== 'done';
  ids.forEach((id) => { const cs = t.chunkState[id]; cs.status = 'running'; cs.error = ''; S.live.add(t.id + ':' + id); });
  if (needOv) { t.overviewStatus = 'running'; t.overviewError = ''; }
  persistMeta(t); rr();
  if (needOv) await runOverview(t, ctrl.signal);
  await Promise.all(ids.map((id) => runChunk(t, id, { signal: ctrl.signal })));
}
function retryOverview(t) {
  if (!canClaude() || t.isSample) return;
  t.overviewStatus = 'running'; t.overviewError = ''; rr();
  runOverview(t, ctrlOf(t).signal);
}
function retryChunk(t, id, force) {
  if (!canClaude() || t.isSample) return;
  const cs = t.chunkState[id]; cs.status = 'running'; cs.error = ''; rr();
  runChunk(t, id, { force: !!force, signal: ctrlOf(t).signal });
}

async function reviewChunk(t, id) {
  if (!canClaude() || t.isSample) return;
  const key = t.id + ':' + id; const chunk = t.doc.chunks.find((c) => c.id === id);
  const sentences = chunkSentences(t, chunk);
  S.reviewing.add(key); delete S.reviewErr[key]; rr();
  try {
    const prompt = C.reviewPrompt({ doc: t.doc, course: t.course, glossary: t.overview && t.overview.glossary, sentences, current: pickAnalyses(t, sentences) });
    const raw = await AI.json(prompt, { task: 'review', tier: tierOf(), fresh: true, priority: true, tag: 'review:' + id });
    const res = C.normalizeReview(raw, sentences);
    if (!Object.keys(res.analyses).length) throw { code: 'invalid_json', message: 'empty' };
    Object.assign(t.analyses, res.analyses);
    const cs = t.chunkState[id];
    cs.warnings = res.warnings.filter((w) => !(w.kind === 'missing' && t.analyses[w.id]));
    cs.changes_ar = res.changes_ar; cs.reviewedAt = now();
    saveChunkDoc(t, id, pickAnalyses(t, sentences));
    persistMeta(t);
  } catch (e) { if (!isCancel(e)) S.reviewErr[key] = errMsg(e); }
  S.reviewing.delete(key); rr();
}

// ───────────── image prep (rotate + downscale via canvas) ─────────────
async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej({ code: 'image_rejected', message: 'bad image' }); };
      img.src = url;
    });
  }
}
async function prepImage(photo, maxBytes) {
  const bmp = await loadBitmap(photo.file);
  const w0 = bmp.width || bmp.naturalWidth; const h0 = bmp.height || bmp.naturalHeight;
  let scale = Math.min(1, 2400 / Math.max(w0, h0)); let q = 0.92; let blob = null;
  for (let k = 0; k < 5; k++) {
    const w = Math.max(1, Math.round(w0 * scale)); const h = Math.max(1, Math.round(h0 * scale));
    const quarter = photo.rot % 180 !== 0;
    const cv = document.createElement('canvas'); cv.width = quarter ? h : w; cv.height = quarter ? w : h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.translate(cv.width / 2, cv.height / 2); ctx.rotate((photo.rot * Math.PI) / 180);
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h);
    blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', q));
    if (!blob) throw { code: 'image_rejected', message: 'encode failed' };
    if (!maxBytes || blob.size <= maxBytes) break;
    scale *= 0.8; q = 0.85;
  }
  return blob;
}

async function runOcr() {
  const nt = S.nt; const photos = nt.photos; const n = photos.length;
  nt.ctrl = new AbortController(); nt.ocr = { running: true, i: 0, n, error: '' }; rr();
  const maxBytes = (AI.limits().images || {}).maxInputBytes;
  for (let i = 0; i < n; i++) {
    const p = photos[i];
    if (nt.pages[p.id] && nt.pages[p.id].rot === p.rot) continue;
    nt.ocr.i = i; rr();
    try {
      const blob = await prepImage(p, maxBytes);
      const raw = await AI.json(C.ocrPrompt({ page: i + 1, pages: n }), { task: 'ocr', tier: tierOf(), images: [blob], signal: nt.ctrl.signal, priority: true, tag: `ocr:${i + 1}/${n}` });
      nt.pages[p.id] = Object.assign(C.normalizeOcr(raw), { rot: p.rot });
    } catch (e) {
      nt.ocr = { running: false, i, n, error: isCancel(e) ? '' : errMsg(e) }; rr(); return;
    }
  }
  const merged = C.mergeOcrPages(photos.map((p) => nt.pages[p.id]));
  nt.ocr = null; nt.step = 'review';
  nt.edTitle = merged.title; nt.edBody = merged.paragraphs.join('\n');
  nt.uncertain = merged.uncertain; nt.notes = merged.notes_ar.join(' ');
  rr();
}

// ───────────── clipboard ─────────────
function toast(msg) {
  S.toastMsg = msg; const el = $('#toast');
  if (el) { el.textContent = msg; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 1800); }
}
function copyText(text) {
  const fallback = () => { S.sheet = { type: 'copy', text }; renderSheet(); setTimeout(() => { const ta = $('#copy-ta'); if (ta) { ta.focus(); ta.select(); } }, 50); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('تم النسخ'), fallback);
    else fallback();
  } catch (e) { fallback(); }
}

// ───────────── view helpers ─────────────
const claudeOnly = (html) => html;
const pyOn = () => S.profile.settings.showPinyin;
const roleChip = (w) => `<span class="chip role ${gcls(C.roleGroup(w.role_zh))}">${esc(w.role || w.role_zh || '—')}</span>`;
const dataW = (tid, sid, i) => `data-tid="${esc(tid)}" data-sid="${sid}" data-i="${i}"`;
const COURSE_CHIP = { translation: 'ترجمة', article: 'مقال' };

function rubyTokens(t, s, a, o = {}) {
  const tk = tokensFor(s, a); const starts = o.starts || {};
  const noBar = !!(o.plain || o.reading);
  return tk.tokens.map((tok) => {
    if (tok.type !== 'word') return `<span class="wd pu"><ruby>${esc(tok.text)}<rt>&nbsp;</rt></ruby></span>`;
    const w = a.words[tok.index];
    const cls = ['wd', o.plain ? '' : gcls(C.roleGroup(w.role_zh)), tk.emph.has(tok.index) ? 'em' : '', o.tint && !S.known.has(w.w) ? 'nw' : '', o.unk && o.unk.has(w.w) ? 'unk' : '', o.hi === tok.index ? 'hi' : ''].filter(Boolean).join(' ');
    const n = starts[s.id] ? starts[s.id] + tok.index : null;
    const showN = !!(o.showNum && n);
    const act = o.static ? '' : ` data-act="word" ${dataW(t.id, s.id, tok.index)} role="button" tabindex="0"`;
    const bar = noBar ? '' : '<i class="wb"></i>';
    const num = noBar && !showN ? '' : `<i class="wn">${showN ? n : '&nbsp;'}</i>`;
    return `<span class="${cls}"${act}><ruby>${esc(tok.text)}<rt>${esc(w.py)}</rt></ruby>${bar}${num}</span>`;
  }).join('');
}
const rubyLine = (t, s, a, o) => `<div class="zh-line${o && o.nopy ? ' nopy' : (pyOn() ? '' : ' nopy')}" lang="zh-CN" dir="ltr">${rubyTokens(t, s, a, o)}</div>`;
const plainLine = (s) => `<div class="zh-line nopy" lang="zh-CN" dir="ltr"><span class="zh-plain">${esc(s.text)}</span></div>`;
const pinyinToggle = () => `<button class="tog${pyOn() ? ' on' : ''}" id="tg-py" data-act="togglePy" aria-pressed="${pyOn()}">النطق</button>`;

// ───────────── library ─────────────
function deckEntries(tid) {
  const list = tid ? [getText(tid)].filter(Boolean) : allTexts();
  return Array.from(uniqueWords(list).values()).filter((e) => !S.known.has(e.w));
}
function dueCount() {
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return Object.keys(S.srs.cards).filter((w) => !S.known.has(w) && S.srs.cards[w].due <= end.getTime()).length;
}
const STATUS_LABEL = { running: 'جاري التحليل', partial: 'ناقص', ready: 'جاهز' };

function viewLibrary() {
  const all = allTexts();
  let fresh = 0; uniqueWords(all.filter(isLoaded)).forEach((e, w) => { if (!S.known.has(w)) fresh++; });
  all.filter((t) => !isLoaded(t)).forEach((t) => { fresh += (t.stats && t.stats.newWordsHint) || 0; });
  const strip = `<section class="strip" aria-label="إحصاءات"><div><b>${S.known.size}</b><span>كلمة معروفة</span></div><div><b>${fresh}</b><span>كلمة جديدة</span></div><div><b>${dueCount()}</b><span>بطاقة مستحقة</span></div></section>`;
  if (!S.ready) return `<div class="page">${strip}<p class="calm">جاري تحميل مكتبتك…</p></div>`;
  const cards = all.map((t) => {
    const st = textStats(t); const stat = statusOf(t); const p = chunkProgress(t);
    const pct = t.isSample ? 100 : (p.total ? Math.round((p.done / p.total) * 100) : 0);
    const del = !t.isSample && (S.confirm === 'del:' + t.id)
      ? `<div class="confirm" role="alert"><span>حذف هذا النص نهائيًا مع تحليله؟</span><button class="btn danger sm" id="del-yes-${t.id}" data-act="delYes" data-id="${t.id}">نعم، احذف</button><button class="btn ghost sm" id="del-no-${t.id}" data-act="confirmNo">إلغاء</button></div>`
      : '';
    return `<article class="card tcard">
      <div class="tcard-main" role="button" tabindex="0" data-act="openText" data-id="${t.id}">
        <div class="tc-top"><span><span class="pill">${COURSE_CHIP[t.course] || ''}</span>${t.isSample ? ' <span class="pill">مثال</span>' : ''}</span><span>${fmtDate(t.createdAt || now())}</span></div>
        <div>${zh(t.doc.title || '(بلا عنوان)', 'tc-zh')}${t.overview && t.overview.title_ar ? `<div class="tc-ar">${esc(t.overview.title_ar)}</div>` : ''}</div>
        <div class="tc-prog"><div class="bar"><i style="width:${pct}%"></i></div><div class="tc-meta"><span>${st.words == null ? '' : `${st.words} كلمة · ${st.fresh == null ? '؟' : st.fresh} جديدة`}</span><span>${STATUS_LABEL[stat]}</span></div></div>
      </div>
      ${t.isSample ? '' : `<div class="tc-foot">${del || `<button class="btn ghost sm" id="del-${t.id}" data-act="delAsk" data-id="${t.id}">${ICON.trash}<span>حذف</span></button>`}</div>`}
    </article>`;
  }).join('');
  const empty = S.texts.length === 0
    ? `<div class="card empty"><p>ابدأ بأول صورة: صوّر الورقة التي وزّعها الأستاذ وسيجهّز مُعرِب الإعراب والترجمة.</p><button class="btn primary" data-act="go" data-to="new">نص جديد</button></div>` : '';
  return `<div class="page">${strip}<section class="sec-wrap"><div class="sec-h"><h2>نصوصي</h2><span class="muted num">${all.length} نص</span></div><div class="stack">${cards}</div>${empty}</section></div>`;
}

// ───────────── new text ─────────────
function boldPreview(text, doubts) {
  const ds = (doubts || []).map((u) => u && u.text).filter(Boolean); const used = new Set();
  const plain = (p) => {
    let h = esc(p);
    ds.forEach((d) => {
      if (used.has(d)) return;
      const e = esc(d); const i = h.indexOf(e);
      if (i >= 0) { used.add(d); h = h.slice(0, i) + `<span class="doubt">${e}</span>` + h.slice(i + e.length); }
    });
    return h;
  };
  return String(text || '').split('\n').filter((l) => l.trim()).map((l) => {
    const parts = l.split('**'); const unb = parts.length % 2 === 0;
    return '<p>' + parts.map((p, i) => (i % 2 === 1 && !(unb && i === parts.length - 1) ? `<mark>${esc(p)}</mark>` : plain(p))).join('') + '</p>';
  }).join('');
}
function viewNew() {
  const nt = S.nt || (S.nt = { step: 'input', mode: 'photo', course: 'translation', photos: [], pages: {}, pasteTitle: '', pasteBody: '' });
  const courseSeg = `<div class="seg" role="group" aria-label="المقرر"><button id="nt-c-tr" class="${nt.course === 'translation' ? 'on' : ''}" data-act="ntCourse" data-v="translation">ترجمة</button><button id="nt-c-ar" class="${nt.course === 'article' ? 'on' : ''}" data-act="ntCourse" data-v="article">مقال</button></div>`;
  const courseSec = `<section class="group g10"><h2>المقرر</h2>${courseSeg}<p class="hint">«ترجمة» لنصوص مادة الترجمة، و«مقال» لنصوص مادة المقال.</p></section>`;
  if (nt.step === 'review') {
    const unc = (nt.uncertain || []).map((u) => `<div class="warn-note" role="note">${ICON.info}<span>تحقّق من الحرف «${zh(u.text)}»${u.context ? ' — في «' + esc(u.context) + '»' : ''}${u.reason_ar ? ` (${esc(u.reason_ar)})` : ''}</span></div>`).join('');
    const paras = String(nt.edBody || '').split('\n').filter((l) => l.trim()).length;
    return `<div class="sh-bar"><button class="ibtn back" id="nt-back" data-act="ntBack" aria-label="رجوع">${ICON.back}</button><h1>راجع النص</h1></div>
      <div class="page f20">
      <p class="hint">صحّح أي حرف خطأ قبل التحليل — أي خطأ هنا ينتقل إلى الترجمة.</p>
      ${nt.notes ? `<p class="warn-note">${esc(nt.notes)}</p>` : ''}
      <div class="group"><label class="lbl" for="nt-ed-title">العنوان</label>
      <input class="inp zh-inp" id="nt-ed-title" data-model="nt.edTitle" lang="zh-CN" dir="ltr" value="${esc(nt.edTitle)}"></div>
      <section class="group"><div class="sec-h"><label class="lbl" for="nt-ed-body">النص</label><span class="legend-hl"><i></i>كلمات غليظة في الأصل</span></div><p class="hint">كل سطر فقرة، وضع **هكذا** حول الكلمات الغليظة.</p>
      <textarea class="inp zh-inp" id="nt-ed-body" data-model="nt.edBody" lang="zh-CN" dir="ltr" rows="10">${esc(nt.edBody)}</textarea>
      <div class="lbl">المعاينة</div>
      <div class="preview" id="nt-preview" lang="zh-CN" dir="ltr">${boldPreview(nt.edBody, nt.uncertain)}</div>
      ${unc}</section>
      ${courseSec}
      <div class="foot-act"><div class="muted num" id="nt-count">${paras} فقرات</div><button class="btn primary lg block" id="nt-go" data-act="ntAnalyze">حلّل النص</button></div></div>`;
  }
  const limits = AI.limits(); const canImg = !!limits.images;
  const modeSeg = `<div class="seg" role="group" aria-label="طريقة الإدخال"><button id="nt-m-photo" class="${nt.mode === 'photo' ? 'on' : ''}" data-act="ntMode" data-v="photo">صور</button><button id="nt-m-paste" class="${nt.mode === 'paste' ? 'on' : ''}" data-act="ntMode" data-v="paste">الصق النص</button></div>`;
  let body;
  if (nt.ocr && nt.ocr.running) {
    body = `<div class="card pad stack"><p><b>جاري قراءة الصورة ${nt.ocr.i + 1} من ${nt.ocr.n}…</b></p><div class="bar"><i style="width:${Math.round(((nt.ocr.i + 0.5) / nt.ocr.n) * 100)}%"></i></div><button class="btn ghost" id="nt-cancel" data-act="ntCancel">إلغاء</button></div>`;
  } else if (nt.mode === 'paste' || !canImg) {
    body = `${canImg ? '' : '<p class="muted">قراءة الصور غير متاحة هنا؛ الصق النص مباشرة.</p>'}
      <div class="group"><label class="lbl" for="nt-p-title">العنوان (اختياري)</label>
      <input class="inp zh-inp" id="nt-p-title" data-model="nt.pasteTitle" lang="zh-CN" dir="ltr" value="${esc(nt.pasteTitle)}"></div>
      <div class="group"><label class="lbl" for="nt-p-body">النص الصيني (كل سطر فقرة، و**هكذا** للكلمات المُعلَّمة)</label>
      <textarea class="inp zh-inp" id="nt-p-body" data-model="nt.pasteBody" lang="zh-CN" dir="ltr" rows="9">${esc(nt.pasteBody)}</textarea></div>
      ${courseSec}
      <button class="btn primary lg block" id="nt-paste-go" data-act="ntPaste" ${nt.pasteBody.trim() ? '' : 'disabled'}>راجع النص</button>`;
  } else {
    const thumbs = nt.photos.map((p, i) => `<div class="thumb"><div class="th-img"><img src="${p.url}" alt="صورة ${i + 1}" style="transform:rotate(${p.rot}deg)"><span class="th-no">${i + 1}</span></div><div class="th-bar"><button class="ibtn" id="th-cw-${p.id}" data-act="rot" data-id="${p.id}" data-d="90" aria-label="تدوير الصورة ${i + 1}">${ICON.cw}</button><button class="ibtn" id="th-rm-${p.id}" data-act="rmPhoto" data-id="${p.id}" aria-label="حذف الصورة ${i + 1}">${ICON.close}</button></div></div>`).join('');
    body = `<section class="group g10"><div class="sec-h"><h2>الصور</h2>${nt.photos.length ? `<span class="muted num">${nt.photos.length} صفحات · بالترتيب</span>` : ''}</div>
      ${thumbs ? `<div class="thumbs">${thumbs}</div>` : '<p class="hint">للصفحات المزدحمة: صوّر كل نصف في صورة.</p>'}
      <label class="btn big block" for="nt-files">${ICON.camera}<span>صوّر أو اختر صورًا</span></label>
      <input type="file" id="nt-files" class="sr-only" accept="image/*" multiple data-change="pickFiles">
      ${nt.ocr && nt.ocr.error ? `<p class="err" role="alert">${esc(nt.ocr.error)}</p>` : ''}</section>
      ${courseSec}
      <button class="btn primary lg block" id="nt-read" data-act="ntRead" ${nt.photos.length ? '' : 'disabled'}>${nt.ocr && nt.ocr.error ? 'أعد المحاولة' : 'اقرأ النص'}</button>`;
  }
  return `<header class="sh-title"><h1>نص جديد</h1><p>صوّر صفحات النص من الكتاب أو الورقة المطبوعة.</p></header><div class="page p24">${canImg ? modeSeg : ''}${body}</div>`;
}

// ───────────── text view ─────────────
const TABS = [['sent', 'الجمل'], ['read', 'القراءة'], ['words', 'الكلمات'], ['tr', 'الترجمة'], ['sum', 'الملخص'], ['prac', 'تدرّب']];
function viewText(t) {
  if (!t) return '<p class="calm">لم يُعثر على النص.</p>';
  if (!isLoaded(t)) {
    if (S.loadErr[t.id] && S.loadErr[t.id] !== 'loading') return `<div class="card pad stack"><p class="err" role="alert">${esc(S.loadErr[t.id])}</p><button class="btn" id="load-retry" data-act="loadRetry" data-id="${t.id}">أعد المحاولة</button></div>`;
    ensureLoaded(t); return '<div class="skel pad"><i></i><i></i><span>جاري تحميل النص…</span></div>';
  }
  ensureChunkState(t);
  const tab = S.ui.tab[t.id] || 'sent'; const p = chunkProgress(t); const run = isRunning(t);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const prog = t.isSample ? ''
    : `<div class="th-prog"><div class="bar"><i style="width:${pct}%"></i></div><span class="num">${run ? `تحليل ${p.done} من ${p.total}` : `${p.done} من ${p.total} جاهز`}</span>${run
      ? `<button class="btn ghost sm" id="stop-btn" data-act="stop" data-id="${t.id}">${ICON.stop}<span>إيقاف</span></button>`
      : needsResume(t) ? claudeOnly(`<button class="btn primary sm" id="resume-btn" data-act="resume" data-id="${t.id}">أكمل التحليل</button>`) : ''}</div>`;
  const head = `<header class="th">
    <div class="sh-bar slim"><button class="ibtn back" id="back-lib" data-act="go" data-to="library" aria-label="رجوع إلى المكتبة">${ICON.back}</button></div>
    <div class="th-row"><div>${zh(t.doc.title || '(بلا عنوان)', 'th-zh')}${t.overview && t.overview.title_ar ? `<div class="th-ar">${esc(t.overview.title_ar)}${t.isSample ? ' <span class="pill">مثال</span>' : ''}</div>` : ''}</div><span class="rp"><span class="pill">${COURSE_CHIP[t.course] || ''}</span></span></div>${prog}</header>`;
  const tabs = `<div class="tabs" role="tablist" aria-label="أقسام النص">${TABS.map(([k, l]) => `<button role="tab" id="tab-${k}" aria-selected="${tab === k}" class="${tab === k ? 'on' : ''}" data-act="tab" data-k="${k}">${l}</button>`).join('')}</div>`;
  const bodies = { sent: tabSent, read: tabRead, words: tabWords, tr: tabTr, sum: tabSum, prac: tabPrac };
  return head + tabs + `<div class="tabbody" id="tabbody">${bodies[tab](t)}</div>`;
}

function legend() {
  const items = [['subj', 'مبتدأ'], ['pred', 'خبر'], ['obj', 'مفعول به'], ['attr', 'صفة'], ['adv', 'حال / ظرف'], ['comp', 'مكمّل']];
  return `<div class="legend" aria-label="دليل ألوان الإعراب">${items.map(([k, a]) => `<span class="${gcls(k)}"><i></i>${a}</span>`).join('')}<span><i class="hl"></i>مُعلَّم في الورقة</span></div>`;
}

function tabSent(t) {
  const sents = t.doc.sentences; const n = sents.length;
  if (!n) return '<p class="muted">لا جمل بعد.</p>';
  const labels = sentLabels(t); const starts = numberStarts(t);
  const ui = S.ui.si || (S.ui.si = {});
  const idx = Math.min(Math.max(ui[t.id] || 0, 0), n - 1); ui[t.id] = idx;
  const s = sents[idx];
  return `<div class="toolbar">${pinyinToggle()}<button class="tog${S.ui.showNum ? ' on' : ''}" id="tg-num" data-act="toggleNum" aria-pressed="${S.ui.showNum}">الأرقام</button></div>${legend()}${sentCard(t, s, labels[s.id], starts, idx, n)}`;
}

function sentCard(t, s, lab, starts, idx, n) {
  const a = analysisOf(t, s.id); const chunk = chunkOf(t, s.id); const cs = (t.chunkState[chunk.id]) || {};
  const tot = t.doc.sentences.filter((x) => x.para > 0).length;
  const text = s.para === 0 ? 'العنوان' : `الجملة ${lab.ord} من ${tot} · الفقرة ${s.para}`;
  const pager = `<div class="pager"><span class="sc-label">${text}</span><span class="btns"><button class="ibtn" id="sent-prev" data-act="sentNav" data-id="${t.id}" data-d="-1" aria-label="الجملة السابقة" ${idx <= 0 ? 'disabled' : ''}>${ICON.back}</button><button class="ibtn" id="sent-next" data-act="sentNav" data-id="${t.id}" data-d="1" aria-label="الجملة التالية" ${idx >= n - 1 ? 'disabled' : ''}>${ICON.next}</button></span></div>`;
  if (!a) {
    let st;
    if (cs.status === 'running') st = '<div class="skel" aria-busy="true"><i></i><i></i><span>جاري التحليل…</span></div>';
    else if (cs.status === 'error') st = `<p class="err" role="alert">${esc(cs.error)}</p>${claudeOnly(`<button class="btn sm" id="retry-${chunk.id}" data-act="retryChunk" data-id="${t.id}" data-c="${chunk.id}">${ICON.retry}<span>أعد المحاولة</span></button>`)}`;
    else st = '<p class="muted">لم يُحلَّل بعد.</p>';
    return `<article class="card sent" id="sc-${s.id}"><section class="sect">${pager}${plainLine(s)}${st}</section></article>`;
  }
  const tk = tokensFor(s, a); const key = t.id + ':' + chunk.id;
  const warns = (cs.warnings || []).filter((w) => w.id === s.id).map((w) => `<p class="warn-note">${esc(w.msg_ar)}</p>`).join('');
  const parts = a.parts.length ? `<div class="parts" dir="ltr">${a.parts.map((p, i) => `<div class="part ${gcls(C.roleGroup(p.role_zh))}${i === a.parts.length - 1 && [...p.text].length > 6 ? ' wide' : ''}"><span class="p-zh" lang="zh-CN">${esc(p.text)}</span><span class="p-ar" dir="rtl">${esc(p.role || p.role_zh)}</span></div>`).join('')}</div>` : '';
  const LIM = 8; const rk = t.id + ':' + s.id; const open = !!(S.ui.rowsOpen && S.ui.rowsOpen[rk]);
  const rows = a.words.map((w, i) => {
    if (!open && i >= LIM) return '';
    const g = C.roleGroup(w.role_zh); const part = g === 'part'; const num = starts[s.id] ? starts[s.id] + i : '';
    return `<li class="ir ${gcls(g)}"><div class="ir-l"><div class="ir-top"><span class="ir-n">${num}</span><button class="ir-w" lang="zh-CN" dir="ltr" data-act="word" ${dataW(t.id, s.id, i)}><span>${esc(w.w)}</span></button></div><span class="ir-py" dir="ltr">${esc(w.py)}</span></div><div class="ir-b"><div class="ir-h">${roleChip(w)}${part ? '' : `<span class="ir-m">${esc(w.mean)}</span>`}</div>${part ? '' : `<p class="ir-t">${esc(w.irab)}</p>`}</div></li>`;
  }).join('');
  const more = !open && a.words.length > LIM ? `<button class="more-btn" id="more-${s.id}" data-act="moreRows" data-k="${rk}"><span>عرض الكلمات الـ${a.words.length - LIM} الباقية</span>${ICON.chev}</button>` : '';
  const pats = a.patterns.length ? `<section class="sect"><h3>تراكيب مهمة</h3>${a.patterns.map(patternHtml).join('')}</section>` : '';
  const notes = a.notes_ar.length || warns ? `<section class="sect"><h3>ملاحظات</h3><ul class="dots">${a.notes_ar.map((x) => `<li><span>${esc(x)}</span></li>`).join('')}</ul>${warns}</section>` : '';
  const changes = (cs.changes_ar || []).filter((c) => !/\bS\d+\b/.test(c) || new RegExp('\\b' + s.id + '\\b').test(c));
  const reviewed = cs.reviewedAt ? `<div class="reviewed"><b>${ICON.check} تم التدقيق</b>${changes.length ? `<ul class="plain">${changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ' — لا أخطاء'}</div>` : '';
  const rerr = S.reviewErr[key] ? `<p class="err" role="alert">${esc(S.reviewErr[key])}</p>` : '';
  const busy = S.reviewing.has(key); const run = cs.status === 'running';
  const actions = claudeOnly(`<div class="actions"><button class="btn primary" id="ask-${s.id}" data-act="askSent" data-id="${t.id}" data-sid="${s.id}">${ICON.chat}<span>اسأل عن هذه الجملة</span></button>${t.isSample ? '' : `<button class="btn" id="rev-${s.id}" data-act="review" data-id="${t.id}" data-c="${chunk.id}" ${busy || run ? 'disabled' : ''}>${busy ? 'جاري التدقيق…' : 'دقّق'}</button>`}</div>${t.isSample ? '' : `<div class="actions-2"><button class="btn ghost sm" id="reanalyze-${s.id}" data-act="reanalyze" data-id="${t.id}" data-c="${chunk.id}" ${busy || run ? 'disabled' : ''}>أعد التحليل</button></div>`}`);
  return `<article class="card sent" id="sc-${s.id}">
    <section class="sect">${pager}${tk.ok ? rubyLine(t, s, a, { starts, showNum: S.ui.showNum }) : `${plainLine(s)}<p class="warn-note">تعذّر ربط الكلمات بنص الجملة؛ الجدول أدناه هو المرجع.</p>`}</section>
    ${parts ? `<section class="sect"><h3>التركيب</h3>${parts}${a.structure_ar ? `<p class="struct">${esc(a.structure_ar)}</p>` : ''}</section>` : ''}
    <section class="sect"><h3>إعراب الكلمات</h3><ul class="irows">${rows}</ul>${more}</section>
    <section class="sect"><h3>ترجمة حرفية</h3><p class="gloss">${esc(C.literalGloss(a.words))}</p></section>
    <section class="sect"><div class="sect-h"><h3>الترجمة</h3><button class="ibtn" id="cp-${s.id}" data-act="copyTr" data-id="${t.id}" data-sid="${s.id}" aria-label="نسخ الترجمة">${ICON.copy}</button></div><div class="trans"><p>${esc(a.translation_ar)}</p></div></section>
    ${pats}${notes}</article>${reviewed}${rerr}${actions}`;
}
function patternHtml(p) {
  return `<div class="pat"><div class="pat-h"><span>${zh(p.zh, 'pat-zh')}${p.py ? `<span class="pat-py" dir="ltr">${esc(p.py)}</span>` : ''}${p.emphasized ? ' <span class="chip em-chip">مُعلَّم في الورقة</span>' : ''}</span><span class="pat-ar">${esc(p.ar)}</span></div>
    ${p.explain_ar ? `<p class="pat-x">${esc(p.explain_ar)}</p>` : ''}
    ${p.example_zh ? `<div class="exbox"><span class="ex-zh" lang="zh-CN" dir="ltr">${esc(p.example_zh)}</span><span class="ex-ar">${esc(p.example_ar)}</span></div>` : ''}</div>`;
}

function tabRead(t) {
  const starts = numberStarts(t); const q = S.ui.quick;
  const seg = `<div class="seg rd" role="group" aria-label="وضع القراءة"><button id="rd-read" class="${q ? '' : 'on'}" data-act="quickCancel" aria-pressed="${!q}">قراءة</button><button id="tg-quick" class="${q ? 'on' : ''}" data-act="quickOn" aria-pressed="${!!q}">تحديد سريع</button></div>`;
  const toolbar = `${seg}<div class="toolbar">${pinyinToggle()}<button class="tog${S.ui.tint ? ' on' : ''}" id="tg-tint" data-act="toggleTint" aria-pressed="${S.ui.tint}">الكلمات الجديدة</button></div>`;
  const maxPara = Math.max(0, ...t.doc.sentences.map((s) => s.para));
  let out = '';
  for (let p = 0; p <= maxPara; p++) {
    const ss = paraSentences(t, p); if (!ss.length) continue;
    const flow = ss.map((s) => {
      const a = analysisOf(t, s.id);
      return a && tokensFor(s, a).ok ? rubyTokens(t, s, a, { starts, tint: S.ui.tint, unk: q ? q.unknown : null, reading: true }) : `<span class="zh-plain">${esc(s.text)}</span> `;
    }).join('');
    const trs = translationOf(t, ss); const open = S.ui.openParas[t.id + ':' + p];
    out += `<section class="card para rdz"><div class="sc-label">${p === 0 ? 'العنوان' : 'الفقرة ' + p}</div><div class="zh-line${pyOn() ? '' : ' nopy'}" lang="zh-CN" dir="ltr">${flow}</div>
      <button class="link" id="ptr-${p}" data-act="togglePara" data-k="${t.id}:${p}" aria-expanded="${!!open}">${open ? 'إخفاء الترجمة' : 'إظهار الترجمة'}</button>
      ${open ? `<p class="arb">${trs ? esc(trs) : '<span class="muted">لم تكتمل الترجمة بعد.</span>'}</p>` : ''}</section>`;
  }
  return toolbar + (q ? '<p class="hint">المس كل كلمة لا تعرفها، ثم اضغط «الباقي أعرفه».</p>' : '') + out;
}

function wordList(t) {
  let list = instances(t).filter((x) => x.n);
  if (S.ui.dedupe) { const seen = new Set(); list = list.filter((x) => (seen.has(x.w.w) ? false : (seen.add(x.w.w), true))); }
  if (S.ui.wf === 'new') list = list.filter((x) => !S.known.has(x.w.w));
  if (S.ui.wf === 'marked') list = list.filter((x) => x.emph);
  return list;
}
function tabWords(t) {
  const list = wordList(t);
  const f = (k, l) => `<button id="wf-${k}" class="${S.ui.wf === k ? 'on' : ''}" data-act="wf" data-k="${k}">${l}</button>`;
  const rows = list.map((x, k) => `<div class="wrow"><span class="num n">${x.n}</span><button class="ir-w" lang="zh-CN" dir="ltr" data-act="word" ${dataW(t.id, x.sid, x.i)}>${esc(x.w.w)}</button><span class="ir-py" dir="ltr">${esc(x.w.py)}</span><span class="wm">${esc(x.w.mean)}${x.emph ? ' <span class="chip em-chip">مُعلَّمة</span>' : ''}</span><label class="chk" for="kn-${k}"><input type="checkbox" id="kn-${k}" data-change="toggleKnown" data-w="${esc(x.w.w)}" ${S.known.has(x.w.w) ? 'checked' : ''}><span>أعرفها</span></label></div>`).join('');
  return `<div class="toolbar"><div class="seg sm" role="group" aria-label="تصفية">${f('all', 'الكل')}${f('new', 'الجديدة')}${f('marked', 'المُعلَّمة')}</div>
    <button class="tog${S.ui.dedupe ? ' on' : ''}" id="tg-dedupe" data-act="dedupe" aria-pressed="${S.ui.dedupe}">بدون تكرار</button>
    <button class="btn ghost sm" id="cp-words" data-act="copyWords" data-id="${t.id}">${ICON.copy}<span>نسخ القائمة</span></button></div>
    <div class="card wlist">${rows || '<p class="muted pad">لا كلمات لعرضها بعد.</p>'}</div>`;
}

function fullTranslation(t) {
  const maxPara = Math.max(0, ...t.doc.sentences.map((s) => s.para)); const out = [];
  for (let p = 0; p <= maxPara; p++) { const ss = paraSentences(t, p); if (ss.length) out.push(translationOf(t, ss)); }
  return out.filter(Boolean);
}
function tabTr(t) {
  const maxPara = Math.max(0, ...t.doc.sentences.map((s) => s.para)); let body = '';
  for (let p = 0; p <= maxPara; p++) {
    const ss = paraSentences(t, p); if (!ss.length) continue;
    const tr = translationOf(t, ss);
    const gl = S.ui.gloss ? ss.map((s) => { const a = analysisOf(t, s.id); return a ? `<p class="gloss">${esc(C.literalGloss(a.words))}</p>` : ''; }).join('') : '';
    body += `<section class="trp">${S.ui.parallel ? `<p class="zh-par" lang="zh-CN" dir="ltr">${esc(ss.map((s) => s.text).join(''))}</p>` : ''}<p class="${p === 0 ? 'arb title' : 'arb'}">${tr ? esc(tr) : '<span class="muted">…</span>'}</p>${gl}</section>`;
  }
  return `<div class="toolbar"><button class="tog${S.ui.parallel ? ' on' : ''}" id="tg-par" data-act="toggleParallel" aria-pressed="${!!S.ui.parallel}">متوازي</button><button class="tog${S.ui.gloss ? ' on' : ''}" id="tg-gloss" data-act="toggleGloss" aria-pressed="${!!S.ui.gloss}">حرفية</button><button class="btn ghost sm" id="cp-all" data-act="copyAll" data-id="${t.id}">${ICON.copy}<span>نسخ الترجمة</span></button></div><div class="card trfull">${body}</div>`;
}

function tabSum(t) {
  const o = t.overview;
  let head = '';
  if (!o) {
    head = t.overviewStatus === 'running' ? '<div class="skel"><i></i><i></i><span>جاري إعداد الملخص…</span></div>'
      : `${t.overviewError ? `<p class="err" role="alert">${esc(t.overviewError)}</p>` : '<p class="muted">لا يوجد ملخص بعد.</p>'}${claudeOnly(`<button class="btn sm" id="retry-ov" data-act="retryOv" data-id="${t.id}">${ICON.retry}<span>أعد المحاولة</span></button>`)}`;
  } else {
    head = `<div class="card pad stack"><p><b>النوع:</b> ${esc(o.genre_ar)}</p><p><b>الفكرة الرئيسية:</b> ${esc(o.main_idea_ar)}</p><p><b>الغرض:</b> ${esc(o.purpose_ar)}</p></div>
      ${o.paragraphs.length ? `<h3 class="sum-h">أفكار الفقرات</h3><ol class="plain-ol">${o.paragraphs.map((p) => `<li>${esc(p.idea_ar)}</li>`).join('')}</ol>` : ''}
      ${o.glossary.length ? `<h3 class="sum-h">المصطلحات الثابتة</h3><div class="card gl">${o.glossary.map((g) => `<div class="glrow">${zh(g.zh, 'gl-zh')}<span class="ir-py" dir="ltr">${esc(g.py)}</span><b>${esc(g.ar)}</b>${g.note_ar ? `<span class="muted">${esc(g.note_ar)}</span>` : ''}</div>`).join('')}</div>` : ''}`;
  }
  const pats = allPatterns(t);
  return head + (pats.length ? `<h3 class="sum-h">كل التراكيب في النص</h3>${pats.map(patternHtml).join('')}` : '')
    + (o && o.tips_ar.length ? `<h3 class="sum-h">نصائح للامتحان</h3><ul class="tips">${o.tips_ar.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
}

// ───────────── practice: quiz + grade ─────────────
function tabPrac(t) {
  const pbar = (title) => `<div class="sh-bar slim"><button class="ibtn back" id="prac-back" data-act="pracBack" aria-label="رجوع إلى التدريب">${ICON.back}</button><h1>${title}</h1></div>`;
  if (S.ui.prac === 'quiz' && S.quiz && S.quiz.scope === t.id) return `${pbar('اختبار الإعراب')}${viewQuizBody()}`;
  if (S.ui.prac === 'grade') return `${pbar('ترجم وصحّح')}${viewGrade(t)}`;
  const nNew = deckEntries(t.id).length;
  return `<div class="stack">
    <div class="card pad stack"><h3>اختبار الإعراب</h3><p class="muted">١٠ أسئلة من كلمات النص: اختر دور الكلمة في الجملة.</p><button class="btn primary" id="start-quiz" data-act="startQuiz" data-scope="${t.id}">ابدأ الاختبار</button></div>
    <div class="card pad stack"><h3>ترجم وصحّح</h3><p class="muted">اختر جملة أو فقرة، اكتب ترجمتك، ويصحّحها Claude كأنه المصحّح.</p>${claudeOnly(`<button class="btn primary" id="start-grade" data-act="startGrade">ابدأ</button>`)}</div>
    <div class="card pad stack"><h3>بطاقات الكلمات الجديدة</h3><p class="muted">${nNew} كلمة جديدة في هذا النص.</p><button class="btn primary" id="start-cards" data-act="startCards" data-id="${t.id}">راجع البطاقات</button></div></div>`;
}

function buildQuiz(scope) {
  const list = scope === 'all' ? allTexts() : [getText(scope)].filter(Boolean);
  const cand = shuffle(list.flatMap((t) => instances(t).filter((x) => QUIZ_GROUPS.includes(C.roleGroup(x.w.role_zh)))));
  const seen = new Set(); const pick = [];
  cand.forEach((x) => { if (pick.length < 10 && !seen.has(x.w.w)) { seen.add(x.w.w); pick.push(x); } });
  cand.forEach((x) => { if (pick.length < 10 && !pick.includes(x)) pick.push(x); });
  const qs = pick.map((x) => {
    const g = C.roleGroup(x.w.role_zh);
    return { tid: x.tid, sid: x.sid, i: x.i, group: g, options: shuffle([g, ...shuffle(QUIZ_GROUPS.filter((k) => k !== g)).slice(0, 3)]) };
  });
  S.quiz = { scope, qs, i: 0, picked: null, score: 0 };
}
const groupLabel = (k) => `${GROUPS[k].ar} · ${GROUPS[k].zh}`;
function viewQuizBody() {
  const q = S.quiz;
  if (!q || !q.qs.length) return '<div class="card pad"><p>لا توجد كلمات محلَّلة كافية لاختبار الإعراب بعد.</p></div>';
  if (q.i >= q.qs.length) {
    return `<div class="card pad center stack"><h3>النتيجة</h3><div class="score num">${q.score}<small>/ ${q.qs.length}</small></div><p class="muted">${q.score === q.qs.length ? 'ممتاز، لا أخطاء.' : 'راجع الكلمات التي أخطأت فيها ثم أعد الجولة.'}</p><button class="btn primary" id="quiz-again" data-act="startQuiz" data-scope="${q.scope}">جولة جديدة</button></div>`;
  }
  const x = q.qs[q.i]; const t = getText(x.tid); const s = t.doc.sentences.find((y) => y.id === x.sid); const a = analysisOf(t, x.sid); const w = a.words[x.i];
  const opts = x.options.map((g) => {
    let cls = 'opt';
    if (q.picked) { if (g === x.group) cls += ' ok'; else if (g === q.picked) cls += ' bad'; }
    return `<button class="${cls}" id="opt-${g}" data-act="quizPick" data-g="${g}" ${q.picked ? 'disabled' : ''}>${esc(groupLabel(g))}</button>`;
  }).join('');
  const fb = q.picked ? `<div class="card pad fb ${q.picked === x.group ? 'ok' : 'bad'}" role="status"><b>${q.picked === x.group ? 'إجابة صحيحة' : 'إجابة خاطئة'}</b><p>${roleChip(w)}</p><p>${esc(w.irab)}</p><button class="btn primary" id="quiz-next" data-act="quizNext">${q.i + 1 >= q.qs.length ? 'النتيجة' : 'التالي'}</button></div>` : '';
  return `<div class="card pad"><div class="muted num">السؤال ${q.i + 1} من ${q.qs.length}</div>${rubyLine(t, s, a, { hi: x.i, plain: true, static: true, nopy: true })}<p class="qline">ما دور الكلمة ${zh(w.w, 'q-w')} في الجملة؟ <span class="muted">(${esc(w.mean)})</span></p><div class="opts">${opts}</div></div>${fb}`;
}

function viewGrade(t) {
  const g = S.grade[t.id] || (S.grade[t.id] = { sel: new Set(), running: false, error: '', result: null });
  const labels = sentLabels(t);
  const sel = t.doc.sentences.filter((s) => g.sel.has(s.id));
  if (g.result) {
    const r = g.result; const stud = S.ui['gt:' + t.id] || '';
    const mark = (text, items, mk) => {
      let h = esc(text);
      items.forEach((it) => { if (!it) return; const e = esc(it); const i = h.indexOf(e); if (i >= 0) h = h.slice(0, i) + mk(e) + h.slice(i + e.length); });
      return h;
    };
    const errs = r.errors.map((e) => `<article class="card gerr"><div class="gerr-h"><span class="tchip">${esc(e.type)}</span></div><div class="gpair"><div><small>كتبتَ</small>${e.student ? `<span class="w">${esc(e.student)}</span>` : '<span class="muted">(حذف)</span>'}</div><div><small>الصواب</small><span class="r"><span class="fix">${esc(e.fix)}</span></span></div></div><p class="why">${esc(e.why_ar)}</p></article>`).join('');
    return `<section class="sc-head"><div class="score num" id="grade-score">${r.score}<small>/ 10</small></div><p class="v">${esc(r.verdict_ar)}</p></section>
      <section class="group"><h2>ترجمتك</h2>${sel.length ? `<p class="zh-par" lang="zh-CN" dir="ltr">${esc(sel.map((s) => s.text).join(''))}</p>` : ''}<p class="card gtxt">${mark(stud, r.errors.map((e) => e.student), (e) => `<del>${e}</del>`)}</p></section>
      ${errs ? `<section class="sec-wrap"><h2>الأخطاء <span class="muted num">(${r.errors.length})</span></h2>${errs}</section>` : '<p class="ok-note">لا أخطاء.</p>'}
      <section class="group"><h2>ترجمتك بعد التصحيح</h2><p class="card gtxt">${mark(r.corrected_ar, r.errors.map((e) => e.fix), (e) => `<span class="fix">${e}</span>`)}</p></section>
      <section class="group"><h2>الترجمة النموذجية</h2><p class="gtxt alt">${esc(r.model_ar)}</p></section>
      <div class="row-btns"><button class="btn primary lg" id="gr-again" data-act="gradeAgain">ترجمة أخرى</button></div>`;
  }
  const maxPara = Math.max(0, ...t.doc.sentences.map((s) => s.para));
  const paraBtns = Array.from({ length: maxPara + 1 }, (_, p) => (paraSentences(t, p).length ? `<button class="tog" id="gp-${p}" data-act="gradePara" data-p="${p}">${p === 0 ? 'العنوان' : 'الفقرة ' + p}</button>` : '')).join('');
  const rows = t.doc.sentences.map((s) => `<label class="srow" for="gs-${s.id}"><input type="checkbox" id="gs-${s.id}" data-change="gradeSel" data-sid="${s.id}" ${g.sel.has(s.id) ? 'checked' : ''}><span><small class="muted">${labels[s.id].text}</small> ${zh(s.text)}</span></label>`).join('');
  const allDone = sel.every((s) => analysisOf(t, s.id));
  const preview = sel.length ? `<div class="card pad">${sel.map((s) => { const a = analysisOf(t, s.id); return a ? `<p class="gprev" lang="zh-CN" dir="ltr">${esc(s.text)}<small class="py" dir="ltr">${pyOn() ? esc(C.sentencePinyin(s.text, a.words)) : ''}</small></p>` : `<p class="gprev" lang="zh-CN" dir="ltr">${esc(s.text)}</p>`; }).join('')}</div>` : '';
  return `<div class="stack"><p class="muted">اختر الجملة أو الفقرة التي تريد ترجمتها.</p>
    <div class="toolbar">${paraBtns}${pinyinToggle()}</div><div class="card slist">${rows}</div>${preview}
    <div class="group"><label class="lbl" for="gr-text">اكتب ترجمتك</label>
    <textarea class="inp" id="gr-text" data-model="gt:${t.id}" rows="6" placeholder="اكتب الترجمة العربية هنا">${esc(S.ui['gt:' + t.id] || '')}</textarea></div>
    ${g.error ? `<p class="err" role="alert">${esc(g.error)}</p>` : ''}
    ${!allDone ? '<p class="warn-note">بعض الجمل المختارة لم تُحلَّل بعد.</p>' : ''}
    ${claudeOnly(`<button class="btn primary lg block" id="gr-go" data-act="gradeGo" ${g.running || !sel.length || !allDone || !(S.ui['gt:' + t.id] || '').trim() ? 'disabled' : ''}>${g.running ? 'جاري التصحيح…' : 'صحّح'}</button>`)}</div>`;
}

function gradeRun(t) {
  const g = S.grade[t.id]; const sel = t.doc.sentences.filter((s) => g.sel.has(s.id));
  g.running = true; g.error = ''; rr();
  AI.json(C.gradePrompt({ source: sel.map((s) => s.text).join('\n'), reference: translationOf(t, sel), student: S.ui['gt:' + t.id], course: t.course, glossary: t.overview && t.overview.glossary }), { task: 'grade', tier: tierOf(), fresh: true, priority: true, tag: 'grade' })
    .then((raw) => { g.result = C.normalizeGrade(raw); })
    .catch((e) => { if (!isCancel(e)) g.error = errMsg(e); })
    .finally(() => { g.running = false; rr(); });
}

// ───────────── flashcards (Leitner) ─────────────
const BOX_DAYS = [0, 0, 1, 3, 7, 16];
function buildSession(filter) {
  const entries = deckEntries(filter || null); const t0 = now();
  const cards = S.srs.cards;
  const due = entries.filter((e) => cards[e.w] && cards[e.w].due <= t0).sort((a, b) => cards[a.w].due - cards[b.w].due);
  const fresh = entries.filter((e) => !cards[e.w]).slice(0, 15);
  const queue = [...due, ...fresh].map((e) => e.w);
  S.rv = { active: true, filter: filter || '', queue, idx: 0, flipped: false, stats: { good: 0, again: 0, known: 0 }, requeued: new Set(), entries: new Map(entries.map((e) => [e.w, e])), total: queue.length };
}
function rate(kind) {
  const rv = S.rv; const w = rv.queue[rv.idx]; if (!w) return;
  const old = S.srs.cards[w]; const c = old ? Object.assign({}, old) : { box: 1, due: 0, seen: 0 };
  if (kind === 'again') {
    c.box = 1; c.due = now() + 10 * 60000; c.seen++; S.srs.cards[w] = c; rv.stats.again++;
    if (!rv.requeued.has(w)) { rv.requeued.add(w); rv.queue.push(w); }
  } else if (kind === 'good') {
    c.box = Math.min(5, (old ? c.box : 1) + 1); c.due = now() + BOX_DAYS[c.box] * 86400000; c.seen++; S.srs.cards[w] = c; rv.stats.good++;
  } else { setKnown(w, true); delete S.srs.cards[w]; rv.stats.known++; }
  rv.idx++; rv.flipped = false; saveSrs(); rr();
}
function viewReview() {
  if (S.loadingAll) return '<p class="calm">جاري تحميل الكلمات…</p>';
  const rv = S.rv || (S.rv = { active: false, filter: '' });
  if (rv.active) {
    if (rv.idx >= rv.queue.length) {
      const st = rv.stats;
      return `<div class="page p24"><div class="card pad center stack"><h1>انتهت الجلسة</h1><p class="num">تذكرتها: ${st.good} · لم أتذكرها: ${st.again} · أعرفها: ${st.known}</p><div class="row-btns"><button class="btn primary" id="rv-new" data-act="rvEnd">جلسة جديدة</button><button class="btn ghost" data-act="go" data-to="library" id="rv-lib">المكتبة</button></div></div></div>`;
    }
    const w = rv.queue[rv.idx]; const e = rv.entries.get(w); const f = e.first; const t = getText(f.tid); const s = t.doc.sentences.find((x) => x.id === f.sid); const a = analysisOf(t, f.sid);
    const at = s.text.indexOf(w);
    const ctx = at < 0 ? esc(s.text) : esc(s.text.slice(0, at)) + '<span class="blank"></span>' + esc(s.text.slice(at + w.length));
    const pct = Math.round((rv.idx / rv.queue.length) * 100);
    const back = rv.flipped ? `<div class="fc-back"><div class="ir-py" dir="ltr">${esc(f.w.py)}</div><div class="ir-m">${esc(f.w.mean)}</div>${roleChip(f.w)}<p class="muted arb-s">${esc(a.translation_ar)}</p></div>` : '';
    const acts = rv.flipped
      ? `<div class="rate"><button class="btn neg" id="rv-again" data-act="rvRate" data-r="again">لم أتذكرها</button><button class="btn pos" id="rv-good" data-act="rvRate" data-r="good">تذكرتها</button></div><button class="btn ghost block" id="rv-known" data-act="rvRate" data-r="known">أعرفها، احذفها</button>`
      : `<button class="btn primary big block" id="rv-flip" data-act="rvFlip">اقلب</button><div class="rate off"><button class="btn neg" disabled>لم أتذكرها</button><button class="btn pos" disabled>تذكرتها</button></div>`;
    return `<div class="fcw"><div class="fc-head"><div class="row"><button class="ibtn back" id="rv-close" data-act="rvEnd" aria-label="إنهاء المراجعة">${ICON.close}</button><span class="num">${rv.idx + 1} من ${rv.queue.length}</span></div><div class="bar"><i style="width:${pct}%"></i></div></div>
      <section class="fc" aria-label="بطاقة"><div class="fc-cap">ما معنى هذه الكلمة؟</div><div class="fc-mid"><div class="fc-w" lang="zh-CN" dir="ltr">${esc(w)}</div>${back}</div><div class="fc-ctxw"><span>في الجملة</span><p class="fc-ctx" lang="zh-CN" dir="ltr">${ctx}</p></div></section>
      <div class="fc-acts">${acts}</div></div>`;
  }
  const entries = deckEntries(rv.filter || null); const cards = S.srs.cards; const t0 = now();
  const nDue = entries.filter((e) => cards[e.w] && cards[e.w].due <= t0).length; const nNew = entries.filter((e) => !cards[e.w]).length;
  const opts = `<option value="">كل النصوص</option>${allTexts().map((t) => `<option value="${t.id}" ${rv.filter === t.id ? 'selected' : ''}>${esc(t.doc.title || t.id)}${t.isSample ? ' (مثال)' : ''}</option>`).join('')}`;
  return `<header class="sh-title"><h1>المراجعة</h1></header><div class="page p24"><div class="card pad stack"><div class="group"><label class="lbl" for="rv-filter">النص</label><select class="inp" id="rv-filter" data-change="rvFilter">${opts}</select></div>
    <p class="num">مستحقة الآن: <b>${nDue}</b> · جديدة: <b>${nNew}</b> (حتى 15 في الجلسة)</p>
    <button class="btn primary lg block" id="rv-start" data-act="rvStart" ${nDue + Math.min(15, nNew) ? '' : 'disabled'}>ابدأ المراجعة</button></div>
    <div class="card pad stack"><h3>اختبار الإعراب</h3><p class="muted">أسئلة من كل النصوص المحلَّلة.</p><button class="btn" id="quiz-all" data-act="startQuiz" data-scope="all">ابدأ الاختبار</button></div></div>`;
}
function viewQuizRoute() {
  if (S.loadingAll) return '<p class="calm">جاري تحميل الكلمات…</p>';
  return `<div class="sh-bar"><button class="ibtn back" id="quiz-back" data-act="go" data-to="review" aria-label="رجوع">${ICON.back}</button><h1>اختبار الإعراب</h1></div>${viewQuizBody()}`;
}

// ───────────── render ─────────────
function viewHtml() {
  const r = S.route;
  if (S.bootError) return `<div class="card pad"><p class="err" role="alert">${esc(S.bootError)}</p><button class="btn" id="boot-retry" data-act="bootRetry">أعد المحاولة</button></div>`;
  if (r.name === 'new') return viewNew();
  if (r.name === 'review') return viewReview();
  if (r.name === 'quiz') return viewQuizRoute();
  if (r.name === 'text') return viewText(getText(r.id));
  return viewLibrary();
}
const routeKey = () => [S.route.name, S.route.id, S.ui.tab[S.route.id], S.nt && S.nt.step, S.ui.prac, S.rv && S.rv.active].join('|');
let lastKey = '';
function render() {
  const view = $('#view'); if (!view) return;
  const ae = document.activeElement; let f = null;
  if (ae && ae.id && view.contains(ae)) {
    const txt = /^(INPUT|TEXTAREA)$/.test(ae.tagName) && ae.type !== 'checkbox' && ae.type !== 'file';
    f = { id: ae.id, txt, s: txt ? ae.selectionStart : 0, e: txt ? ae.selectionEnd : 0 };
  }
  const y = window.scrollY; const key = routeKey();
  view.innerHTML = viewHtml();
  const app = $('#app'); if (app) app.dataset.route = S.route.name;
  updateNav(); renderQbar();
  window.scrollTo(0, key === lastKey ? y : 0); lastKey = key;
  if (f) {
    const el = document.getElementById(f.id);
    if (el) { try { el.focus({ preventScroll: true }); if (f.txt) el.setSelectionRange(f.s, f.e); } catch (e) { /* ignore */ } }
  }
}
function updateNav() {
  const cur = S.route.name === 'text' || S.route.name === 'quiz' ? (S.route.name === 'quiz' ? 'review' : 'library') : S.route.name;
  $$('#nav [data-to]').forEach((b) => { if (b.dataset.to === cur) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
}
function renderQbar() {
  const el = $('#qbar'); if (!el) return;
  const q = S.ui.quick;
  document.body.classList.toggle('has-qbar', !!(q && S.route.name === 'text'));
  if (!q || S.route.name !== 'text') { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="qbar"><div class="qn"><b>${q.unknown.size}</b><span>كلمات غير معروفة</span></div><button class="btn primary" id="q-done" data-act="quickDone">الباقي أعرفه</button></div>`;
}
function updateSaveInd() {
  const el = $('#save-ind'); const bn = $('#save-banner'); if (!el) return;
  const st = Saver.status();
  el.className = 'save-ind ' + st; el.textContent = st === 'saving' ? 'جارٍ الحفظ…' : st === 'saved' ? 'محفوظ' : '';
  if (bn) {
    const want = st === 'error';
    if (want && bn.hidden) bn.innerHTML = `<span>${esc(errMsg({ code: 'storage_failed' }))}</span><button class="btn sm" id="save-retry" data-act="saveRetry">أعد المحاولة</button>`;
    bn.hidden = !want;
  }
}

function go(name, params) {
  S.route = Object.assign({ name }, params || {});
  S.sheet = null; renderSheet();
  if (name !== 'text') S.ui.quick = null;
  if (name === 'review' && allTexts().some((t) => !isLoaded(t))) ensureAllLoaded();
  rr();
}

// ───────────── sheets ─────────────
function md(s) {
  let out = ''; let inList = false;
  const bold = (x) => x.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  esc(s).split('\n').forEach((l) => {
    const m = /^\s*-\s+(.*)$/.exec(l);
    if (m) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + bold(m[1]) + '</li>'; }
    else { if (inList) { out += '</ul>'; inList = false; } out += bold(l) + '<br>'; }
  });
  if (inList) out += '</ul>';
  return out.replace(/(<br>)+$/, '').replace(/([㐀-鿿＀-￯]+)/g, '<span lang="zh-CN" dir="ltr">$1</span>');
}
function sheetShell(title, inner, cls) {
  return `<div class="sheet-back" data-act="closeSheet"></div><div class="sheet ${cls || ''}" id="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1"><div class="handle" id="sheet-handle"><i></i></div><button class="ibtn sheet-x" id="sheet-x" data-act="closeSheet" aria-label="إغلاق">${ICON.close}</button><div class="sheet-body" id="sheet-body">${inner}</div></div>`;
}
function wordSheetHtml(sh) {
  const t = getText(sh.tid); const s = t.doc.sentences.find((x) => x.id === sh.sid); const a = analysisOf(t, sh.sid); const w = a.words[sh.i];
  const lab = sentLabels(t); const occ = [];
  t.doc.sentences.forEach((x) => { const ax = analysisOf(t, x.id); if (ax && ax.words.some((y) => y.w === w.w)) occ.push(lab[x.id].short); });
  const notes = a.notes_ar.filter((n) => n.includes(w.w));
  return `<div><div class="ws-w" lang="zh-CN" dir="ltr">${esc(w.w)}</div><div class="ws-py" dir="ltr">${esc(w.py)}</div></div>
    <div><div class="ws-m">${esc(w.mean)}</div><div class="ws-chips">${w.pos ? `<span class="tag">${esc(w.pos)}${w.pos_zh ? ' ' + zh(w.pos_zh) : ''}</span>` : ''}${roleChip(w)}</div></div>
    <div class="ws-box"><small>الإعراب في هذه الجملة</small><p>${esc(w.irab)}</p></div>
    ${notes.length ? notes.map((n) => `<p class="note">${esc(n)}</p>`).join('') : ''}
    <p class="muted">يظهر في: ${occ.length ? esc(occ.join('، ')) : '—'}</p>
    <div class="sw-row"><label for="ws-known">أعرفها</label><input class="switch" type="checkbox" role="switch" id="ws-known" data-change="sheetKnown" data-w="${esc(w.w)}" ${S.known.has(w.w) ? 'checked' : ''}></div>
    ${claudeOnly(`<button class="btn primary lg block" id="ws-ask" data-act="wordAsk">${ICON.chat}<span>اسأل Claude عن هذه الكلمة</span></button>`)}
    <p class="ws-sent" lang="zh-CN" dir="ltr">${esc(s.text)}</p>`;
}
const chatOf = (tid) => S.chats[tid] || (S.chats[tid] = { turns: [], busy: false, ctrl: null, focus: null });
function chatMsgsHtml(chat) {
  if (!chat.turns.length) return '<p class="muted pad">اسأل عن أي إعراب أو ترجمة في هذا النص.</p>';
  return chat.turns.map((m) => {
    if (m.role === 'user') return `<div class="msg user">${md(m.content)}</div>`;
    if (m.pending && !m.content) return '<div class="msg bot thinking">يفكّر…</div>';
    return `<div class="msg bot${m.error ? ' error' : ''}">${m.error ? esc(m.error) : md(m.content)}${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}</div>`;
  }).join('');
}
const chatCtlHtml = (chat) => (chat.busy ? `<button class="btn sm" id="chat-stop" data-act="chatStop">${ICON.stop}<span>إيقاف</span></button>` : `<button class="btn primary sm" id="chat-send" data-act="chatSend" aria-label="إرسال">${ICON.up}</button>`);
function chatSheetHtml(sh) {
  const chat = chatOf(sh.tid);
  const chips = ['اشرح الإعراب ببساطة', 'لماذا تُرجمت هكذا؟', 'أعطني أمثلة أخرى لهذا التركيب'].map((c, i) => `<button class="tog" id="chip-${i}" data-act="chatChip" data-q="${esc(c)}">${c}</button>`).join('');
  return `<h3>اسأل Claude</h3><div class="chat-msgs" id="chat-msgs">${chatMsgsHtml(chat)}</div><div class="chips-row">${chips}</div>
    <div class="chat-input"><textarea class="inp" id="chat-in" data-model="chatIn:${sh.tid}" rows="2" placeholder="اكتب سؤالك…">${esc(S.ui['chatIn:' + sh.tid] || '')}</textarea><span id="chat-ctl">${chatCtlHtml(chat)}</span></div>`;
}
function updateChatDom() {
  const sh = S.sheet; if (!sh || sh.type !== 'chat') return;
  const chat = chatOf(sh.tid); const m = $('#chat-msgs'); const c = $('#chat-ctl');
  if (m) { const stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80; m.innerHTML = chatMsgsHtml(chat); if (stick) m.scrollTop = m.scrollHeight; }
  if (c) c.innerHTML = chatCtlHtml(chat);
}
function settingsSheetHtml() {
  const st = S.profile.settings;
  const tierBtn = (k, l) => `<button id="tier-${k}" class="${st.tier === k ? 'on' : ''}" data-act="setTier" data-v="${k}">${l}</button>`;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const themeBtn = (k, l) => `<button class="${theme === k ? 'on' : ''}" data-act="setTheme" data-v="${k}">${l}</button>`;
  const storage = S.mock ? 'وضع تجريبي — محفوظ في هذا المتصفح' : 'محفوظ في مستودع GitHub الخاص بك';
  const reset = S.confirm === 'resetKnown'
    ? `<div class="confirm" role="alert"><span>مسح كل الكلمات المعروفة؟</span><button class="btn danger sm" id="reset-yes" data-act="resetYes">نعم، امسح</button><button class="btn ghost sm" id="reset-no" data-act="confirmNo">إلغاء</button></div>`
    : `<button class="btn" id="reset-known" data-act="resetAsk">إعادة ضبط الكلمات المعروفة</button>`;
  return `<h3>الإعدادات</h3><div class="lbl">النموذج</div>
    <div class="seg col2" role="group" aria-label="النموذج">${tierBtn('best', 'Opus 5.5 — الأدق (افتراضي)')}${tierBtn('fast', 'Sonnet 5.5 — أسرع وأرخص')}</div>
    <div class="lbl">المظهر</div>
    <div class="seg col2" role="group" aria-label="المظهر">${themeBtn('dark', 'داكن')}${themeBtn('light', 'فاتح')}</div>
    <label class="chk big" for="set-py"><input type="checkbox" id="set-py" data-change="setPinyin" ${st.showPinyin ? 'checked' : ''}><span>إظهار النطق (pinyin) افتراضيًا</span></label>
    <p class="muted">${storage}</p>
    <p class="muted">${S.known.size} كلمة معروفة</p>${reset}
    ${S.onLock ? `<button class="btn block" id="set-lock" data-act="lock">${ICON.lock}<span>قفل</span></button>` : ''}`;
}
function renderSheet() {
  const root = $('#sheet-root'); if (!root) return;
  const sh = S.sheet;
  if (!sh) { root.innerHTML = ''; document.body.classList.remove('sheet-open'); return; }
  let inner = ''; let title = ''; let cls = '';
  if (sh.type === 'word') { inner = wordSheetHtml(sh); title = 'الكلمة'; }
  else if (sh.type === 'chat') { inner = chatSheetHtml(sh); title = 'اسأل Claude'; cls = 'tall'; }
  else if (sh.type === 'settings') { inner = settingsSheetHtml(); title = 'الإعدادات'; }
  else if (sh.type === 'copy') { inner = `<h3>انسخ النص</h3><p class="muted">تعذّر النسخ تلقائيًا. النص محدد، انسخه يدويًا.</p><textarea class="inp" id="copy-ta" rows="8" readonly>${esc(sh.text)}</textarea>`; title = 'نسخ'; }
  const ae = document.activeElement; const keep = ae && ae.id && root.contains(ae) ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  root.innerHTML = sheetShell(title, inner, cls);
  document.body.classList.add('sheet-open');
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.focus({ preventScroll: true }); try { el.setSelectionRange(keep.s, keep.e); } catch (e) { /* ignore */ } } }
  else if (!sh.noFocus) { const sheet = $('#sheet'); if (sheet) sheet.focus({ preventScroll: true }); }
  const m = $('#chat-msgs'); if (m) m.scrollTop = m.scrollHeight;
  const h = $('#sheet-handle'); const sheet = $('#sheet');
  if (h && sheet) {
    let y0 = null; let dy = 0;
    h.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; }, { passive: true });
    h.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
    h.addEventListener('touchend', () => { sheet.style.transition = ''; if (dy > 80) closeSheet(); else sheet.style.transform = ''; y0 = null; });
  }
}
function closeSheet() { S.sheet = null; renderSheet(); }
function openChat(tid, sid, prefill) {
  const chat = chatOf(tid); if (sid) chat.focus = sid;
  if (prefill != null) S.ui['chatIn:' + tid] = prefill;
  S.sheet = { type: 'chat', tid }; renderSheet();
}
function sendChat(text) {
  const sh = S.sheet; if (!sh || sh.type !== 'chat') return;
  const t = getText(sh.tid); const chat = chatOf(sh.tid);
  text = String(text || '').trim(); if (!text || chat.busy) return;
  S.ui['chatIn:' + sh.tid] = '';
  const ta = $('#chat-in'); if (ta) ta.value = '';
  chat.turns.push({ role: 'user', content: text });
  const bot = { role: 'assistant', content: '', pending: true }; chat.turns.push(bot);
  chat.busy = true; chat.ctrl = new AbortController();
  const fs = chat.focus ? t.doc.sentences.find((x) => x.id === chat.focus) : null;
  const intro = C.tutorIntro({ doc: t.doc, course: t.course, focus: fs ? { sentence: fs, analysis: analysisOf(t, fs.id) } : null });
  let hist = chat.turns.slice(0, -1).filter((m) => !m.error && m.content).slice(-12).map((m) => ({ role: m.role, content: m.content }));
  while (hist.length && hist[0].role !== 'user') hist.shift();
  const merged = [];
  hist.forEach((m) => { const l = merged[merged.length - 1]; if (l && l.role === m.role) l.content += '\n\n' + m.content; else merged.push(Object.assign({}, m)); });
  merged[0].content = intro + '\n\n— سؤال الطالب:\n' + merged[0].content;
  updateChatDom();
  AI.stream(merged, { tier: 'fast', signal: chat.ctrl.signal, onText: ({ text: tx }) => { bot.content = tx; bot.pending = false; updateChatDom(); } })
    .then((r) => { if (r && r.text) bot.content = r.text; if (r && r.truncated) bot.note = 'انقطع الرد — اسأل عن جزء أصغر'; })
    .catch((e) => { if (!isCancel(e)) bot.error = errMsg(e); })
    .finally(() => {
      bot.pending = false; chat.busy = false;
      if (!bot.content && !bot.error) chat.turns.splice(chat.turns.indexOf(bot), 1);
      updateChatDom();
    });
}

// ───────────── events ─────────────
const dsT = (el) => getText(el.dataset.id);
const ACT = {
  go: (el) => go(el.dataset.to),
  openText: (el) => go('text', { id: el.dataset.id }),
  delAsk: (el) => { S.confirm = 'del:' + el.dataset.id; rr(); },
  confirmNo: () => { S.confirm = null; rr(); renderSheet(); },
  delYes: async (el) => {
    const id = el.dataset.id; const t = getText(id); S.confirm = null;
    if (S.ctrls[id]) S.ctrls[id].abort();
    S.texts = S.texts.filter((x) => x.id !== id); S.loaded.delete(id); delete S.chats[id];
    rr();
    await Saver.drop('t:' + id); await Saver.drop('c:' + id + ':');
    if (t) Saver.put('del:' + id, id, (i) => Store.deleteText(i), 0);
  },
  settings: () => { S.sheet = { type: 'settings' }; renderSheet(); },
  lock: () => {
    Object.values(S.ctrls).forEach((c) => c.abort());
    Saver.flush(); S.sheet = null; renderSheet();
    const app = $('#app'); if (app) app.hidden = true;
    if (S.onLock) S.onLock();
  },
  closeSheet: () => closeSheet(),
  saveRetry: () => { Saver.retry(); updateSaveInd(); },
  bootRetry: () => loadData(),
  // new text
  ntCourse: (el) => { S.nt.course = el.dataset.v; rr(); },
  ntMode: (el) => { S.nt.mode = el.dataset.v; rr(); },
  rot: (el) => { const p = S.nt.photos.find((x) => x.id === el.dataset.id); if (p) { p.rot = (p.rot + Number(el.dataset.d) + 360) % 360; rr(); } },
  rmPhoto: (el) => { const i = S.nt.photos.findIndex((x) => x.id === el.dataset.id); if (i >= 0) { URL.revokeObjectURL(S.nt.photos[i].url); S.nt.photos.splice(i, 1); } rr(); },
  ntRead: () => { if (S.nt.photos.length && !(S.nt.ocr && S.nt.ocr.running)) runOcr(); },
  ntCancel: () => { if (S.nt.ctrl) S.nt.ctrl.abort(); S.nt.ocr = null; rr(); },
  ntPaste: () => { const nt = S.nt; nt.edTitle = nt.pasteTitle; nt.edBody = nt.pasteBody; nt.uncertain = []; nt.notes = ''; nt.step = 'review'; rr(); },
  ntBack: () => { S.nt.step = 'input'; rr(); },
  ntAnalyze: () => {
    const nt = S.nt; const paras = C.parseEditor(nt.edBody); const title = (nt.edTitle || '').trim();
    if (!C.buildDocument({ title, paragraphs: paras }).sentences.length) { toast('النص فارغ'); return; }
    const t = newTextRecord(nt.course, title, paras);
    nt.photos.forEach((p) => URL.revokeObjectURL(p.url));
    S.loaded.add(t.id); S.texts.push(t); persistMeta(t); S.nt = null;
    S.ui.tab[t.id] = 'sent'; go('text', { id: t.id }); startAnalysis(t);
  },
  // text view
  tab: (el) => { S.ui.tab[S.route.id] = el.dataset.k; S.ui.quick = null; S.ui.prac = null; rr(); },
  stop: (el) => { const t = dsT(el); if (t) stopAnalysis(t); },
  resume: (el) => { const t = dsT(el); if (t) startAnalysis(t); },
  loadRetry: (el) => { delete S.loadErr[el.dataset.id]; rr(); },
  togglePy: () => { S.profile.settings.showPinyin = !S.profile.settings.showPinyin; saveProfile(); rr(); },
  toggleNum: () => { S.ui.showNum = !S.ui.showNum; rr(); },
  toggleTint: () => { S.ui.tint = !S.ui.tint; rr(); },
  quick: () => { S.ui.quick = S.ui.quick ? null : { unknown: new Set() }; rr(); },
  quickCancel: () => { S.ui.quick = null; rr(); },
  quickDone: () => {
    const t = getText(S.route.id); const q = S.ui.quick; if (!t || !q) return;
    const ws = new Set(instances(t).map((x) => x.w.w)); const mark = [];
    ws.forEach((w) => { if (!q.unknown.has(w)) mark.push(w); });
    q.unknown.forEach((w) => S.known.delete(w));
    addKnownMany(mark); S.profile.known = Array.from(S.known); saveProfile();
    S.ui.quick = null; toast(`تم تعليم ${mark.length} كلمة كمعروفة`); rr();
  },
  togglePara: (el) => { const k = el.dataset.k; S.ui.openParas[k] = !S.ui.openParas[k]; rr(); },
  word: (el) => {
    const q = S.ui.quick;
    if (q && S.route.name === 'text') {
      const t = getText(el.dataset.tid); const w = analysisOf(t, el.dataset.sid).words[Number(el.dataset.i)].w;
      if (q.unknown.has(w)) q.unknown.delete(w); else q.unknown.add(w);
      rr(); return;
    }
    S.sheet = { type: 'word', tid: el.dataset.tid, sid: el.dataset.sid, i: Number(el.dataset.i) }; renderSheet();
  },
  retryChunk: (el) => { const t = dsT(el); if (t) retryChunk(t, el.dataset.c, false); },
  review: (el) => { const t = dsT(el); if (t) reviewChunk(t, el.dataset.c); },
  reanalyze: (el) => { const t = dsT(el); if (t) retryChunk(t, el.dataset.c, true); },
  askSent: (el) => openChat(el.dataset.id, el.dataset.sid, null),
  wordAsk: () => {
    const sh = S.sheet; const t = getText(sh.tid); const w = analysisOf(t, sh.sid).words[sh.i];
    openChat(sh.tid, sh.sid, `اشرح لي كلمة «${w.w}» (${w.py}) في هذه الجملة: ما معناها وإعرابها هنا؟`);
  },
  copyTr: (el) => { const t = dsT(el); const a = analysisOf(t, el.dataset.sid); if (a) copyText(a.translation_ar); },
  sentNav: (el) => {
    const t = dsT(el); if (!t) return; const ui = S.ui.si || (S.ui.si = {});
    ui[t.id] = Math.min(Math.max((ui[t.id] || 0) + Number(el.dataset.d), 0), t.doc.sentences.length - 1); rr(); window.scrollTo(0, 0);
  },
  moreRows: (el) => { const o = S.ui.rowsOpen || (S.ui.rowsOpen = {}); o[el.dataset.k] = true; rr(); },
  quickOn: () => { if (!S.ui.quick) S.ui.quick = { unknown: new Set() }; rr(); },
  wf: (el) => { S.ui.wf = el.dataset.k; rr(); },
  dedupe: () => { S.ui.dedupe = !S.ui.dedupe; rr(); },
  copyWords: (el) => { const t = dsT(el); copyText(wordList(t).map((x) => `${x.n}. ${x.w.w} — ${x.w.py} — ${x.w.mean}`).join('\n')); },
  toggleParallel: () => { S.ui.parallel = !S.ui.parallel; rr(); },
  toggleGloss: () => { S.ui.gloss = !S.ui.gloss; rr(); },
  copyAll: (el) => { const t = dsT(el); copyText(fullTranslation(t).join('\n\n')); },
  retryOv: (el) => { const t = dsT(el); if (t) retryOverview(t); },
  // practice
  startQuiz: async (el) => {
    const scope = el.dataset.scope;
    if (scope === 'all') {
      go('quiz');
      if (allTexts().some((t) => !isLoaded(t))) await ensureAllLoaded();
      buildQuiz('all'); rr();
    } else { buildQuiz(scope); S.ui.prac = 'quiz'; rr(); }
  },
  pracBack: () => { S.ui.prac = null; rr(); },
  startGrade: () => { S.ui.prac = 'grade'; rr(); },
  startCards: (el) => { buildSession(el.dataset.id); go('review'); },
  quizPick: (el) => { const q = S.quiz; if (q.picked) return; q.picked = el.dataset.g; if (q.picked === q.qs[q.i].group) q.score++; rr(); },
  quizNext: () => { S.quiz.i++; S.quiz.picked = null; rr(); },
  gradePara: (el) => {
    const t = getText(S.route.id); const g = S.grade[t.id]; const ss = paraSentences(t, Number(el.dataset.p));
    const all = ss.every((s) => g.sel.has(s.id)); ss.forEach((s) => (all ? g.sel.delete(s.id) : g.sel.add(s.id))); rr();
  },
  gradeGo: () => gradeRun(getText(S.route.id)),
  gradeAgain: () => { const g = S.grade[S.route.id]; g.result = null; g.sel = new Set(); S.ui['gt:' + S.route.id] = ''; rr(); },
  // review
  rvStart: () => { buildSession(S.rv.filter); rr(); },
  rvFlip: () => { S.rv.flipped = true; rr(); },
  rvRate: (el) => rate(el.dataset.r),
  rvEnd: () => { S.rv = { active: false, filter: S.rv.filter }; rr(); },
  // sheets
  chatSend: () => sendChat(($('#chat-in') || {}).value),
  chatStop: () => { const c = chatOf(S.sheet.tid); if (c.ctrl) c.ctrl.abort(); },
  chatChip: (el) => sendChat(el.dataset.q),
  setTier: (el) => { S.profile.settings.tier = el.dataset.v; saveProfile(); renderSheet(); },
  // Per device (also styles the lock screen, before the profile loads), so localStorage rather than the profile.
  setTheme: (el) => {
    const v = el.dataset.v === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = v;
    try { localStorage.setItem('murib-theme', v); } catch { /* private mode: this visit only */ }
    const m = $('meta[name="theme-color"]'); if (m) m.content = v === 'light' ? '#F3F4F0' : '#121413';
    renderSheet();
  },
  resetAsk: () => { S.confirm = 'resetKnown'; renderSheet(); },
  resetYes: () => { S.confirm = null; S.known = new Set(); S.profile.known = []; saveProfile(); renderSheet(); rr(); toast('تمت إعادة الضبط'); },
};
const CHANGE = {
  pickFiles: (el) => {
    const nt = S.nt; const max = ((AI.limits().images || {}).maxCount) || 8;
    Array.from(el.files || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).forEach((f) => {
      if (nt.photos.length < max) nt.photos.push({ id: 'p' + rand4() + nt.photos.length, file: f, url: URL.createObjectURL(f), rot: 0 });
    });
    el.value = ''; rr();
  },
  toggleKnown: (el) => { setKnown(el.dataset.w, el.checked); rr(); },
  sheetKnown: (el) => { setKnown(el.dataset.w, el.checked); rr(); },
  gradeSel: (el) => { const g = S.grade[S.route.id]; if (el.checked) g.sel.add(el.dataset.sid); else g.sel.delete(el.dataset.sid); rr(); },
  rvFilter: (el) => { S.rv.filter = el.value; rr(); },
  setPinyin: (el) => { S.profile.settings.showPinyin = el.checked; saveProfile(); rr(); },
};
function bindEvents() {
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act]; if (fn) fn(el, ev);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (S.sheet) { closeSheet(); return; }
      if (S.ui.quick) { S.ui.quick = null; rr(); return; }
    }
    const el = ev.target;
    if ((ev.key === 'Enter' || ev.key === ' ') && el.matches && el.matches('[role="button"][data-act]')) { ev.preventDefault(); el.click(); return; }
    if (ev.key === 'Enter' && !ev.shiftKey && el.id === 'chat-in') { ev.preventDefault(); sendChat(el.value); }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]'); if (!el) return;
    const fn = CHANGE[el.dataset.change]; if (fn) fn(el);
  });
  document.addEventListener('input', (ev) => {
    const el = ev.target; const m = el.dataset && el.dataset.model; if (!m) return;
    if (m.startsWith('nt.')) {
      S.nt[m.slice(3)] = el.value;
      if (m === 'nt.edBody') { const pv = $('#nt-preview'); if (pv) pv.innerHTML = boldPreview(el.value, S.nt.uncertain); }
      if (m === 'nt.pasteBody') { const b = $('#nt-paste-go'); if (b) b.disabled = !el.value.trim(); }
    } else {
      S.ui[m] = el.value;
      if (m.startsWith('gt:')) rr();
    }
  });
  window.addEventListener('pagehide', () => Saver.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') Saver.flush(); });
}

// ───────────── boot ─────────────
async function loadData() {
  S.bootError = ''; S.ready = false; rr();
  try {
    await Store.init();
    S.profile = normProfile(await Store.loadProfile());
    S.srs = (await Store.loadSrs()) || defaultSrs();
    if (!S.srs.cards) S.srs.cards = {};
    const metas = await Store.listTexts();
    S.known = new Set(S.profile.known);
    S.loaded = new Set();
    S.texts = (metas || []).filter((m) => m && m.id && m.doc).map((m) => {
      if (m.analyses) S.loaded.add(m.id);
      else delete m.analyses;
      ensureChunkState(m);
      return m;
    });
  } catch (e) {
    S.bootError = errMsg({ code: 'storage_failed' });
  }
  S.ready = true; rr();
}
let bound = false;
async function boot(opts) {
  opts = opts || {};
  Object.values(S.ctrls).forEach((c) => c.abort());
  Saver.reset(); AI.attach(opts.ai || null); Store = opts.store;
  S.mode = opts.mode || ''; S.mock = S.mode === 'mock'; S.onLock = typeof opts.onLock === 'function' ? opts.onLock : null;
  S.route = { name: 'library' }; S.sheet = null; S.nt = null; S.rv = null; S.quiz = null; S.chats = {}; S.grade = {}; S.ctrls = {}; S.live = new Set();
  S.confirm = null; S.ui.quick = null; S.ui.prac = null;
  document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl';
  const app = $('#app'); if (app) app.hidden = false;
  const lb = $('#lock-btn'); if (lb) lb.hidden = !S.onLock;
  const mt = $('#mock-tag'); if (mt) mt.hidden = !S.mock;
  if (!bound) { bound = true; bindEvents(); }
  updateSaveInd();
  await AI.loadLimits();
  await loadData();
}

window.MuribApp = { boot };
if (/mock/.test(location.hash)) boot({ ai: makeMockAI(), store: makeMockStore(), mode: 'mock', onLock: null });
})();
