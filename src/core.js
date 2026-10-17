/* مُعرِب — core.js
 * The prompts sent to Claude, the text pipeline (bold markers, sentences, chunks,
 * word alignment) and the normalizers that turn Claude's JSON into stored records.
 * Lead-owned: app.js consumes window.MuribCore and must not re-implement any of this.
 * Also loads under Node (module.exports) so the fixture and tests can use it. */
(function (root) {
  'use strict';

  const PROMPT_VERSION = 2;

  // ───────────── Text utilities ─────────────

  const PUNCT_CHAR = /[\p{P}\p{S}\s]/u;
  const PUNCT_ALL = /[\p{P}\p{S}\s]/gu;
  const TERMINATORS = '。！？!?；;';
  const CLOSERS = '”’"\'」』）)》】';

  const isPunct = (ch) => PUNCT_CHAR.test(ch);
  const stripPunct = (s) => String(s ?? '').replace(PUNCT_ALL, '');
  const str = (v) => (v == null ? '' : String(v)).trim();
  const arr = (v) => (Array.isArray(v) ? v : []);

  /** "a**b**c" → { clean: "abc", ranges: [[1, 2]] }; ranges are [start, end) in clean. */
  function parseBold(marked) {
    const parts = String(marked ?? '').split('**');
    const unbalanced = parts.length % 2 === 0; // odd number of markers: ignore the last one
    let clean = '';
    const ranges = [];
    parts.forEach((p, i) => {
      const bold = i % 2 === 1 && !(unbalanced && i === parts.length - 1);
      if (bold && p) ranges.push([clean.length, clean.length + p.length]);
      clean += p;
    });
    return { clean, ranges };
  }

  /** Split clean text into sentences: [{ text, start, end }] with offsets into the input. */
  function splitSentences(text) {
    const out = [];
    const n = text.length;
    let start = 0;
    const push = (s, e) => {
      while (s < e && /\s/.test(text[s])) s++;
      let t = e;
      while (t > s && /\s/.test(text[t - 1])) t--;
      if (t <= s) return;
      if (!stripPunct(text.slice(s, t)) && out.length) {
        // stray closing marks belong to the previous sentence
        const prev = out[out.length - 1];
        prev.end = t;
        prev.text = text.slice(prev.start, t);
        return;
      }
      out.push({ text: text.slice(s, t), start: s, end: t });
    };
    for (let i = 0; i < n; i++) {
      if (!TERMINATORS.includes(text[i])) continue;
      let j = i + 1;
      while (j < n && (TERMINATORS.includes(text[j]) || CLOSERS.includes(text[j]))) j++;
      push(start, j);
      start = j;
      i = j - 1;
    }
    push(start, n);
    return out;
  }

  /** Editor text → paragraphs. Every non-empty line is one paragraph. */
  function parseEditor(text) {
    return String(text ?? '')
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => stripPunct(l.replace(/\*\*/g, '')));
  }

  /**
   * Turn a reviewed text into numbered sentences and analysis chunks.
   * input: { title, paragraphs } — strings that may carry **bold** markers.
   * returns {
   *   title, paragraphs,                         // clean strings (markers removed)
   *   sentences: [{ id: 'S1', para, text, bold: [string], boldRanges: [[s, e]] }],
   *   chunks:    [{ id: 'c1', para, sentenceIds: ['S1', …] }]
   * }
   * para 0 is the title; paragraphs are numbered from 1. Chunks never cross a paragraph.
   * One sentence per chunk by default: each call is short, so sentences appear one by one,
   * a dropped connection costs one sentence, and the shared prompt prefix is cached.
   * Store the result with the text: ids must not change after analysis.
   */
  function buildDocument({ title = '', paragraphs = [] } = {}, { maxChars = 100, maxSentences = 1 } = {}) {
    const blocks = [];
    if (stripPunct(parseBold(title).clean)) blocks.push({ para: 0, marked: title });
    paragraphs
      .filter((p) => stripPunct(parseBold(p).clean))
      .forEach((p, i) => blocks.push({ para: i + 1, marked: p }));

    const sentences = [];
    const chunks = [];
    for (const block of blocks) {
      const { clean, ranges } = parseBold(block.marked);
      let current = null;
      for (const s of splitSentences(clean)) {
        const boldRanges = ranges
          .map(([a, b]) => [Math.max(a, s.start) - s.start, Math.min(b, s.end) - s.start])
          .filter(([a, b]) => b > a);
        const sentence = {
          id: 'S' + (sentences.length + 1),
          para: block.para,
          text: s.text,
          bold: boldRanges.map(([a, b]) => s.text.slice(a, b)).filter((b) => stripPunct(b)),
          boldRanges,
        };
        sentences.push(sentence);
        const len = stripPunct(sentence.text).length;
        if (!current || current.chars + len > maxChars || current.sentenceIds.length >= maxSentences) {
          current = { id: 'c' + (chunks.length + 1), para: block.para, sentenceIds: [], chars: 0 };
          chunks.push(current);
        }
        current.sentenceIds.push(sentence.id);
        current.chars += len;
      }
    }
    chunks.forEach((c) => delete c.chars);
    return {
      title: parseBold(title).clean.trim(),
      paragraphs: blocks.filter((b) => b.para > 0).map((b) => parseBold(b.marked).clean.trim()),
      sentences,
      chunks,
    };
  }

  /**
   * Lay a sentence's analyzed words over its printed text, for rendering.
   * returns { tokens, ok } where tokens are
   *   { type: 'word', index, text, start, end }  — index into words
   *   { type: 'punct', text }                    — punctuation / spaces
   *   { type: 'raw', text }                      — printed characters no word covered (segmentation slip)
   * ok is false when any word could not be placed or any character was left uncovered.
   */
  function alignWords(text, words) {
    const tokens = [];
    let pos = 0;
    let ok = true;
    const pushGap = (a, b) => {
      if (b <= a) return;
      let run = '';
      let runType = null;
      for (const ch of text.slice(a, b)) {
        const t = isPunct(ch) ? 'punct' : 'raw';
        if (t !== runType && run) {
          tokens.push({ type: runType, text: run });
          run = '';
        }
        runType = t;
        run += ch;
        if (t === 'raw') ok = false;
      }
      if (run) tokens.push({ type: runType, text: run });
    };
    arr(words).forEach((w, index) => {
      const target = w && w.w;
      if (!target) return;
      const at = text.indexOf(target, pos);
      if (at === -1 || stripPunct(text.slice(pos, at)).length > 8) {
        ok = false;
        return;
      }
      pushGap(pos, at);
      tokens.push({ type: 'word', index, text: target, start: at, end: at + target.length });
      pos = at + target.length;
    });
    pushGap(pos, text.length);
    return { tokens, ok };
  }

  const PUNCT_PINYIN = {
    '，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!',
    '“': '"', '”': '"', '‘': "'", '’': "'", '《': '«', '》': '»', '（': '(', '）': ')',
  };

  /** Whole-sentence pinyin built from the words, punctuation kept in Latin form. */
  function sentencePinyin(text, words) {
    const { tokens } = alignWords(text, words);
    let out = '';
    for (const t of tokens) {
      if (t.type === 'word') {
        const py = (words[t.index] && words[t.index].py) || t.text;
        const attach = /^(le|zhe|guo)$/.test(py) && /[\p{L}]$/u.test(out); // 写了 → xiěle
        out += (out && !attach && !/[«(]$/.test(out) ? ' ' : '') + py;
      } else if (t.type === 'punct') {
        out += [...t.text.replace(/\s+/g, '')].map((c) => PUNCT_PINYIN[c] ?? c).join('');
      } else {
        out += ' ' + t.text;
      }
    }
    return out.trim();
  }

  /** Word-by-word Arabic gloss in Chinese order (the "ترجمة حرفية"). */
  function literalGloss(words) {
    return arr(words).map((w) => w.mean || '…').join(' / ');
  }

  // ───────────── Grammar roles ─────────────

  /** Colour groups, keyed by the Chinese component name Claude returns in role_zh. */
  const ROLE_GROUPS = [
    { key: 'subj', zh: '主语', ar: 'مبتدأ' },
    { key: 'pred', zh: '谓语', ar: 'خبر' },
    { key: 'obj', zh: '宾语', ar: 'مفعول به' },
    { key: 'attr', zh: '定语', ar: 'صفة / مضاف إليه' },
    { key: 'adv', zh: '状语', ar: 'حال / ظرف' },
    { key: 'comp', zh: '补语', ar: 'مكمّل' },
    { key: 'pivot', zh: '兼语', ar: 'مفعول به وفاعل' },
    { key: 'link', zh: '关联词', ar: 'أداة ربط' },
    { key: 'part', zh: '助词', ar: 'أداة' },
    { key: 'other', zh: '独立语', ar: 'جملة اعتراضية' },
  ];
  const ROLE_ZH = ROLE_GROUPS.map((g) => g.zh);

  function canonicalRoleZh(z) {
    z = str(z);
    if (ROLE_ZH.includes(z)) return z;
    return ROLE_ZH.find((r) => z.includes(r)) || '';
  }

  /** role_zh → group key ('subj' … 'other'); unknown roles fall into 'other'. */
  function roleGroup(roleZh) {
    const zh = canonicalRoleZh(roleZh);
    const g = ROLE_GROUPS.find((x) => x.zh === zh);
    return g ? g.key : 'other';
  }

  // ───────────── Normalizers ─────────────

  function normalizeWord(w) {
    w = w || {};
    return {
      w: stripPunct(w.w ?? w.word ?? w.hanzi),
      py: str(w.py ?? w.pinyin),
      pos: str(w.pos),
      pos_zh: str(w.pos_zh),
      role: str(w.role),
      role_zh: canonicalRoleZh(w.role_zh) || str(w.role_zh),
      irab: str(w.irab),
      mean: str(w.mean ?? w.meaning),
    };
  }

  function normalizePattern(p) {
    p = p || {};
    return {
      zh: str(p.zh),
      py: str(p.py),
      ar: str(p.ar),
      explain_ar: str(p.explain_ar),
      example_zh: str(p.example_zh),
      example_ar: str(p.example_ar),
      emphasized: p.emphasized === true || p.emphasized === 'true',
    };
  }

  function normalizeAnalysis(r) {
    r = r || {};
    return {
      words: arr(r.words).map(normalizeWord).filter((w) => w.w),
      parts: arr(r.parts)
        .map((p) => ({
          text: stripPunct(p && p.text),
          role: str(p && p.role),
          role_zh: canonicalRoleZh(p && p.role_zh) || str(p && p.role_zh),
        }))
        .filter((p) => p.text),
      structure_ar: str(r.structure_ar),
      translation_ar: str(r.translation_ar),
      patterns: arr(r.patterns).map(normalizePattern).filter((p) => p.zh),
      notes_ar: arr(r.notes_ar).map(str).filter(Boolean),
    };
  }

  /** Checks an analysis against its printed sentence. → [{ kind, msg_ar }] */
  function checkAnalysis(sentence, a) {
    const issues = [];
    const target = stripPunct(sentence.text);
    if (!a.words.length) {
      issues.push({ kind: 'words', msg_ar: 'لم تصل كلمات هذه الجملة.' });
    } else if (a.words.map((w) => w.w).join('') !== target) {
      issues.push({ kind: 'words', msg_ar: 'تقطيع الكلمات لا يطابق نص الجملة حرفًا بحرف. راجعه أو اضغط «دقّق».' });
    }
    if (a.parts.length && a.parts.map((p) => p.text).join('') !== target) {
      issues.push({ kind: 'parts', msg_ar: 'أجزاء التركيب لا تغطي الجملة كاملة.' });
    }
    if (!a.translation_ar) issues.push({ kind: 'translation', msg_ar: 'الترجمة ناقصة لهذه الجملة.' });
    if (a.words.some((w) => !w.py)) issues.push({ kind: 'pinyin', msg_ar: 'بعض الكلمات بلا نطق.' });
    return issues;
  }

  /**
   * Claude's reply for one chunk → { analyses: { S1: analysis, … }, warnings: [{ id, kind, msg_ar }] }.
   * chunkSentences: the sentence objects of the chunk (from buildDocument).
   * A sentence with no usable reply is left out of analyses and gets a warning of kind 'missing'.
   */
  function normalizeChunk(raw, chunkSentences) {
    const list = Array.isArray(raw) ? raw : arr(raw && raw.sentences);
    const byId = new Map(list.filter((s) => s && s.id).map((s) => [str(s.id).toUpperCase(), s]));
    const analyses = {};
    const warnings = [];
    chunkSentences.forEach((sentence, i) => {
      const r = byId.get(sentence.id.toUpperCase()) || (byId.size === 0 ? list[i] : undefined);
      if (!r) {
        warnings.push({ id: sentence.id, kind: 'missing', msg_ar: 'لم يصل تحليل هذه الجملة. اضغط «أعد التحليل».' });
        return;
      }
      const a = normalizeAnalysis(r);
      analyses[sentence.id] = a;
      checkAnalysis(sentence, a).forEach((w) => warnings.push({ id: sentence.id, ...w }));
    });
    return { analyses, warnings };
  }

  /** Review reply → { analyses, warnings, changes_ar }. */
  function normalizeReview(raw, chunkSentences) {
    const out = normalizeChunk(raw, chunkSentences);
    out.changes_ar = arr(raw && raw.changes_ar).map(str).filter(Boolean);
    return out;
  }

  function normalizeOverview(raw) {
    raw = raw || {};
    return {
      title_ar: str(raw.title_ar),
      genre_ar: str(raw.genre_ar),
      main_idea_ar: str(raw.main_idea_ar),
      purpose_ar: str(raw.purpose_ar),
      paragraphs: arr(raw.paragraphs)
        .map((p) => ({ n: Number(p && p.n) || 0, idea_ar: str(p && p.idea_ar) }))
        .filter((p) => p.idea_ar),
      glossary: arr(raw.glossary)
        .map((g) => ({ zh: str(g && g.zh), py: str(g && g.py), ar: str(g && g.ar), note_ar: str(g && g.note_ar) }))
        .filter((g) => g.zh && g.ar),
      tips_ar: arr(raw.tips_ar).map(str).filter(Boolean),
    };
  }

  /** One OCR page → { title, paragraphs, uncertain, notes_ar }. Paragraphs keep **bold** markers. */
  function normalizeOcr(raw) {
    raw = raw || {};
    return {
      title: str(raw.title),
      paragraphs: arr(raw.paragraphs).map(str).filter((p) => stripPunct(p.replace(/\*\*/g, ''))),
      uncertain: arr(raw.uncertain)
        .map((u) => ({ text: str(u && u.text), context: str(u && u.context), reason_ar: str(u && u.reason_ar) }))
        .filter((u) => u.text),
      notes_ar: str(raw.notes_ar),
    };
  }

  /** Several OCR pages (in order) → one { title, paragraphs, uncertain, notes_ar }. */
  function mergeOcrPages(pages) {
    const out = { title: '', paragraphs: [], uncertain: [], notes_ar: [] };
    pages.forEach((p, i) => {
      if (p.title && !out.title) out.title = p.title;
      else if (p.title) out.paragraphs.push(p.title);
      out.paragraphs.push(...p.paragraphs);
      out.uncertain.push(...p.uncertain.map((u) => ({ ...u, page: i + 1 })));
      if (p.notes_ar) out.notes_ar.push(pages.length > 1 ? `صفحة ${i + 1}: ${p.notes_ar}` : p.notes_ar);
    });
    return out;
  }

  const ERROR_TYPES = ['معنى', 'حذف', 'إضافة', 'اسم علم/مصطلح', 'زمن/نفي', 'نحو وإملاء', 'أسلوب'];

  function normalizeGrade(raw) {
    raw = raw || {};
    let score = Number(raw.score);
    if (!Number.isFinite(score)) score = 0;
    score = Math.round(Math.min(10, Math.max(0, score)) * 4) / 4;
    return {
      score,
      verdict_ar: str(raw.verdict_ar),
      errors: arr(raw.errors)
        .map((e) => ({
          type: ERROR_TYPES.find((t) => str(e && e.type).includes(t.split('/')[0])) || str(e && e.type) || 'معنى',
          student: str(e && e.student),
          fix: str(e && e.fix),
          why_ar: str(e && e.why_ar),
        }))
        .filter((e) => e.student || e.fix || e.why_ar),
      corrected_ar: str(raw.corrected_ar),
      model_ar: str(raw.model_ar),
    };
  }

  // ───────────── Prompts ─────────────

  const COURSE_AR = { translation: 'الترجمة', article: 'المقال' };

  /** doc: { title, paragraphs } with clean strings (buildDocument output or a stored text). */
  function passage(doc) {
    const lines = [];
    if (doc.title) lines.push('TITLE: ' + doc.title);
    arr(doc.paragraphs).forEach((p, i) => lines.push(`[${i + 1}] ${p}`));
    return lines.join('\n');
  }

  function glossaryBlock(glossary) {
    const lines = arr(glossary)
      .filter((g) => g.zh && g.ar)
      .map((g) => `${g.zh} → ${g.ar}`);
    return lines.length ? lines.join('\n') : '(none yet — use established Arabic names)';
  }

  function sentenceList(sentences) {
    return sentences
      .map((s) => `${s.id}: ${s.text}\n    EMPHASIZED in the handout: ${s.bold && s.bold.length ? s.bold.join(' ، ') : 'none'}`)
      .join('\n');
  }

  function persona(course) {
    return `You are a meticulous teacher of Chinese–Arabic translation at an Egyptian university (Faculty of Al-Alsun style). Your student is a native Arabic speaker preparing for the course «${COURSE_AR[course] || COURSE_AR.translation}». In the exam they get a Chinese text and must read it (pinyin), parse every word using Arabic grammar terms (إعراب), and translate it into Arabic with zero mistakes — every error costs marks. The student memorizes what you produce, so accuracy matters more than anything else. Check your work carefully before answering.`;
  }

  const RULES = `FIELDS FOR EACH SENTENCE

"words" — the sentence split into dictionary words (词), in order. Each word is
  {"w": the characters exactly as printed, "py": pinyin,
   "pos": Arabic part of speech, "pos_zh": Chinese part of speech,
   "role": Arabic i'rab term, "role_zh": Chinese sentence component,
   "irab": one short Arabic i'rab line, "mean": Arabic meaning in this context}

SEGMENTATION
- Split as a good Chinese dictionary would (办事 / 方式; 规章制度 stays one word). Real 成语 — four-character idioms listed in a 成语 dictionary (不可估量, 伤痕累累, 草草了事) — stay one word with pos_zh 成语. Other phrases are split into their words, and pos_zh 成语 is never used for them (发自内心 is 发自 / 内心; 终身大事 is 终身 / 大事).
- An adverb and the verb after it are two words (就 / 像, 都 / 是); 这/那/哪 and a following measure word are two words (这 / 种, 那 / 种). Split the same string the same way every time it appears in the text.
- Separate words: the particles 的 地 得 了 着 过 所 吗 呢 吧; the negators 不 没 别 (but keep lexicalized words whole: 不论, 不要, 不过, 不但); a numeral and its measure word (一 / 份); a verb and a following 了.
- Keep 们 attached (朋友们). Keep proper nouns and titles whole, without 《》 (金字塔报).
- No punctuation inside words. Never correct the printed text, even an obvious typo: analyze what is printed and give the likely intended word in notes_ar.

PINYIN ("py")
- Tone marks (ā á ǎ à, ǖ ǘ ǚ ǜ), never tone numbers. Syllables of one word written together (jīntiān, bànshì); a four-character expression in two halves (bùkě gūliàng).
- Neutral tone unmarked (de, le, zhe, men, xǐhuan). Proper nouns capitalized and written by Hanyu Pinyin orthography, proper part and generic part apart (Zhōngguó, Āijí, Jīnzìtǎ Bào, Běijīng Shì).
- 一 and 不 take the tone actually spoken, as Chinese textbooks mark it (bú shì, bú yào, yí gè, yìqǐ, yídìng); every other character keeps its dictionary tone (do not mark third-tone sandhi).
- Polyphonic characters: pick the reading that fits the context — 地 de/dì, 得 de/dé/děi, 了 le/liǎo, 着 zhe/zháo/zhuó, 为 wèi/wéi, 都 dōu/dū, 长 cháng/zhǎng, 行 xíng/háng, 重 zhòng/chóng, 还 hái/huán, 只 zhǐ/zhī, 种 zhǒng/zhòng, 处 chù/chǔ, 好 hǎo/hào, 要 yào/yāo, 分 fēn/fèn, 当 dāng/dàng, 将 jiāng/jiàng, 相 xiāng/xiàng, 觉 jué/jiào, 发 fā/fà, 便 biàn/pián, 数 shù/shǔ, 调 diào/tiáo, 传 chuán/zhuàn, 结 jié/jiē, 量 liàng/liáng, 少 shǎo/shào, 似 sì/shì. When the choice is a classic trap, add a note in notes_ar.

PARTS OF SPEECH
- "pos" (Arabic), one of: اسم، مصدر، اسم علم، ضمير، اسم إشارة، فعل، فعل مساعد، صفة، ظرف، أداة نفي، حرف جر، أداة ربط، أداة، عدد، كلمة قياس، اسم زمان، اسم مكان، تعبير اصطلاحي. Describe the word as it functions in THIS sentence: a verb used as a noun (表达了…关注 → 关注) is «مصدر».
- "pos_zh" (Chinese), one of: 名词、专有名词、代词、指示代词、动词、能愿动词、形容词、副词、介词、连词、助词、数词、量词、时间名词、方位名词、成语 — the dictionary class (关注 stays 动词 even when its pos is «مصدر»).

I'RAB — the Arabic grammar terms this class uses
"role_zh" must be exactly one of: 主语 谓语 宾语 定语 状语 补语 兼语 关联词 助词 独立语
"role" is the Arabic term the student writes (a short qualifier in parentheses is fine):
- 主语 → «مبتدأ». Arabic reads «我分享…» like «أنا أشاركُ…»: the subject is the مبتدأ and the verb clause is its خبر.
- 谓语 → «خبر»: «خبر (فعل)» for the main verb, «خبر (صفة)» for an adjective predicate, «خبر (فعل الكينونة)» for 是. A second verb phrase sharing the same subject (连谓: 写了…，谈到了…; 带着…) → «خبر ثانٍ (فعل)»; if your translation renders it as a حال (حاملًا), say so in irab. Auxiliary verbs (能、会、要、必须、可以、应该、能够) → «فعل مساعد» with role_zh 状语.
- 去/来 before another verb (去工作، 不要去做، 去帮他، 来看) means setting out to do it, not physical movement: 去/来 is «خبر (فعل)» with "mean" «[الإقدام على الفعل]», and the verb after it is «خبر ثانٍ (فعل)» (连谓) — never «مفعول به». 去/来 means "go/come" only when a place follows or is implied (去北京).
- 宾语 → «مفعول به» (the object of a verb). Exception: the noun, pronoun or phrase after 是 is «خبر الكينونة» (role_zh 宾语), never «مفعول به». The object of a preposition (在、对、给、跟、与、向、为了、关于、把、被、从) → «اسم مجرور», role_zh of the prepositional phrase: 状语, or 定语 when it modifies a noun (关于中东的文章).
- 把 + N + verb: N is «اسم مجرور» (role_zh 状语); its irab says it is the verb's object moved before it, e.g. «اسم مجرور بـ«把»، وهو في المعنى مفعول به للفعل «当成» تقدّم عليه». The 把-phrase is «شبه جملة (جار ومجرور) متعلق بالفعل», never «حال».
- 定语 → «صفة» for a descriptive modifier; «مضاف إليه» for a possessor (我的، 学生的، 中国的 meaning "China's"); numerals «عدد»; measure words «كلمة قياس»; 这/那 «اسم إشارة».
- 状语 → «حال» (manner: 自发地، 全面), «ظرف زمان» (今天، 昨晚، 已经، 将来), «ظرف مكان», «ظرف» (degree, scope, frequency: 很، 最، 都، 也، 就، 才، 始终), «أداة نفي» (不، 没、别), «حرف جر» for the preposition itself. In 在……中/上/里/下 the noun is «اسم مجرور» and 中/上/里/下 is «اسم مكان (يكمل حرف الجر)», all with role_zh 状语.
- 补语 → «مكمّل» with its type: (نتيجة 结果) only for a verb or adjective attached straight to the verb with no 得 (做完، 看懂); (حال/درجة 情态/程度) for what follows 得 (累得身心疲惫، 说得很好); (اتجاه 趋向), (إمكان 可能), (مدة/عدد 时量/动量). The role and the irab name the same type.
- 兼语 → «مفعول به وفاعل» — the noun after 让/叫/使/请/托/派/要求/鼓励/劝 that is the object of that verb and the subject of the next one. The verb after it is «خبر (فعل) لـ«N»» (N = that noun), role_zh 谓语 — not «خبر ثانٍ», which is only for verbs sharing the sentence's own subject.
- 关联词 → «أداة ربط» (不论، 只有、而且、但، 因为، 所以، 而، 然后، 即، 进而). Explain paired connectors in "patterns".
- 助词 → «أداة» with its function: 的 «أداة الصفة/الإضافة», 地 «أداة الحال», 得 «أداة المكمّل», 着 «أداة الاستمرار», 过 «أداة التجربة», 吗/呢/吧 «أداة استفهام/تقرير», 所 «أداة (مع 被)». 了 has two uses — decide which before you label it: right after a verb, «أداة الإتمام» (a completed action, usually rendered in the past); at the end of a sentence or clause, «أداة تغيّر الحال» (a new situation has come about: 天黑了 «حلّ الظلام», 就失去意义了 «فعندئذٍ يفقد الأمر معناه») — this 了 is not a past-tense marker.
- 是……的 is only the emphatic frame around a predicate (他是昨天来的، 这是可以理解的). When 的 closes a clause that describes a following noun (我认为是最有效的方式), that 的 is «أداة الصفة» and there is no 是……的.
- 独立语 → «جملة اعتراضية» — inserted words outside the main structure (你看، 看来، 总之).
- A给B的N (中国主席给埃及总统的信件): 给 is the verb of the 的-clause («خبر (فعل)» inside it), A its «مبتدأ», B «مفعول به»; the whole clause is «صفة» of N.
Give each word the role it has inside the smallest clause that contains it; when that clause is itself part of a bigger one (an object clause, a 的-clause before a noun), say so in "irab".
"irab": one short Arabic line in the style of an Arabic-grammar teacher — the word's type, its role, and what it attaches to, at most 22 words. E.g. «اسم، مفعول به للفعل «分享»» or «ضمير، مبتدأ لجملة «我认为是最有效的» الواقعة صفة لـ«方式»». No case-ending talk (مرفوع/منصوب).

"parts" — the sentence's main components in order, the way a teacher brackets them on the board: [{"text": contiguous characters of the sentence, "role": Arabic term, "role_zh": Chinese component}]. Their texts joined must equal the sentence without punctuation. Group modifiers with their head (中国菜 is one part «مفعول به (مركب وصفي)»; 跟大家 is one part «شبه جملة (جار ومجرور)» with role_zh 状语). For a complex sentence (复句) list each clause's parts in order, with each connector as its own part («أداة ربط», 关联词). A long object or attribute clause may stay one part.
"structure_ar" — the main structure as a one-line Arabic formula, e.g. «ظرف زمان + مبتدأ + جار ومجرور + فعل (خبر) + مفعول به»; for a complex sentence also name how the clauses relate (شرط، سبب ونتيجة، استدراك، تتابع…).

TRANSLATION
"translation_ar" — the exam answer: faithful first, then fluent formal Arabic (فصحى).
- Render every element: subject, tense and aspect (verb + 了 completed → usually past; sentence-final 了 → a change of state, rendered with «صار/أصبح/عندئذٍ» in whatever tense the context needs; 已经 → «قد» + past; 将/将来 → «سـ/سوف» or «في المستقبل»; 正在 → ongoing present), negation and its scope, degree words (很، 最، 绝对، 始终، 千万), numbers and quantities, every modifier.
- Negation: 不 negates the present, habits, wishes and the future → «لا» / «لن» (a past habit or state: «لم يكن + مضارع»); 没/没有 negates an action that did not happen → «لم». Never translate 不 as «لم» + past.
- Add nothing that is not in the Chinese; no explanations inside the translation. One exception: when an Arabic pronoun would point to the wrong person, name the referent instead (他 → «الرئيس الصيني») and say so in notes_ar.
- With no aspect marker, take the tense from the context (a news report narrates in the past; 写道 → «كتب»).
- Proper nouns and institutions: the established Arabic name, never a literal one (《金字塔报》 → صحيفة «الأهرام»; 外交部长 → وزير الخارجية; 中国国家主席 → الرئيس الصيني; 埃及总统 → الرئيس المصري). Follow the glossary exactly.
- Correct grammar, agreement, hamzas and taa marbuta; natural Arabic order (start with the verb where Arabic prefers it); titles in «». No full diacritics — add a mark only where it prevents ambiguity.
- Measure words and particles are expressed through Arabic structure, not translated as separate words.
"mean" (per word) — the meaning in THIS context, 1–4 Arabic words, in the form used in your translation_ar (实现 → «تحقيق» if the translation says «تحقيق السلام»); for a particle give its function in brackets, e.g. «[أداة الإتمام]», «[أداة الإضافة]». Joined in order, the "mean" values form the student's word-by-word gloss.

"patterns" — grammar patterns and connectors in this sentence the student must learn: paired connectors (不论…都…، 只有…才…، 因为…而…), 被 and 被…所…, 把, 是…的, 在…下, 让/使 + verb, comparisons, verb–complement constructions, set phrases. Each: {"zh": the pattern with …… for the gaps, "py": its pinyin, "ar": Arabic equivalent(s), "explain_ar": how it works in 1–2 sentences, "example_zh": a NEW short example sentence (not from the text), "example_ar": its Arabic translation, "emphasized": true if it matches handout-emphasized text}. Empty array if none.
"notes_ar" — 0–4 short Arabic notes on traps: polyphones, a word whose usual dictionary meaning is wrong here, a likely typo in the source, a translation choice. Empty array if nothing important.
- Only state what you are sure of. Call the source a typo only when the printed form is not a real word or makes the sentence ungrammatical — a rarer but correct word (托 = يُوكِل) is not a typo. Never call a printed word redundant (زائدة) when the sentence reads correctly with it (不是因为… = «ليس لأن…»). No general claims about Arabic grammar you cannot back (Arabic needs no linking word between مبتدأ and خبر).`;

  const EXAMPLE = JSON.stringify({
    sentences: [
      {
        id: 'S1',
        words: [
          { w: '我', py: 'wǒ', pos: 'ضمير', pos_zh: '代词', role: 'مبتدأ', role_zh: '主语', irab: 'ضمير المتكلم، مبتدأ، وخبره جملة «很喜欢中国菜»', mean: 'أنا' },
          { w: '很', py: 'hěn', pos: 'ظرف', pos_zh: '副词', role: 'ظرف (درجة)', role_zh: '状语', irab: 'ظرف درجة يقيّد الفعل «喜欢»', mean: 'كثيرًا' },
          { w: '喜欢', py: 'xǐhuan', pos: 'فعل', pos_zh: '动词', role: 'خبر (فعل)', role_zh: '谓语', irab: 'فعل، رأس الخبر للمبتدأ «我»', mean: 'أحب' },
          { w: '中国', py: 'Zhōngguó', pos: 'اسم علم', pos_zh: '专有名词', role: 'صفة', role_zh: '定语', irab: 'اسم علم، صفة لـ«菜»', mean: 'الصيني' },
          { w: '菜', py: 'cài', pos: 'اسم', pos_zh: '名词', role: 'مفعول به', role_zh: '宾语', irab: 'اسم، مفعول به للفعل «喜欢»', mean: 'الطعام' },
        ],
        parts: [
          { text: '我', role: 'مبتدأ', role_zh: '主语' },
          { text: '很', role: 'ظرف (درجة)', role_zh: '状语' },
          { text: '喜欢', role: 'خبر (فعل)', role_zh: '谓语' },
          { text: '中国菜', role: 'مفعول به (مركب وصفي)', role_zh: '宾语' },
        ],
        structure_ar: 'مبتدأ + ظرف درجة + فعل (خبر) + مفعول به (مركب وصفي)',
        translation_ar: 'أحب الطعام الصيني كثيرًا.',
        patterns: [],
        notes_ar: ['«喜欢» تُنطق xǐhuan بنبرة خفيفة في المقطع الثاني.'],
      },
    ],
  });

  const FINAL_CHECK = `FINAL CHECK before you reply:
1. For each sentence, the "w" values joined equal the sentence with punctuation removed — every character, in order, nothing corrected.
2. The "parts" texts joined equal it too.
3. Every polyphonic character has the reading that fits this context; 一 and 不 carry their spoken tones.
4. Read your translation against the Chinese clause by clause: nothing missing, nothing added, tense and negation right, glossary names used, Arabic grammar and spelling correct.
5. Every EMPHASIZED item is covered in "patterns" (or in notes_ar if it is a plain word).
6. Each word's role, irab and mean agree with each other and with the translation. Recheck every 了 (completion or change of state), 是 and the word after it, 把, 去/来 + verb, 兼语 verbs, 得 complements and every 不.`;

  /**
   * Analyze one chunk.
   * doc: { title, paragraphs } clean; sentences: the chunk's sentence objects; glossary: overview.glossary.
   * Reply: { sentences: [...] } → normalizeChunk(reply, sentences).
   */
  /**
   * [prefix, suffix]: the prefix is identical for every chunk of a text (cached by the API),
   * the suffix names the sentences to analyze.
   */
  function analyzePromptParts({ doc, course, glossary, sentences }) {
    const prefix = `${persona(course)}

THE WHOLE TEXT (context only):
${passage(doc)}

GLOSSARY — use exactly these Arabic renderings:
${glossaryBlock(glossary)}

${RULES}

OUTPUT — reply with only this JSON, no markdown fences, no commentary:
{"sentences":[{"id":"S…","words":[…],"parts":[…],"structure_ar":"…","translation_ar":"…","patterns":[…],"notes_ar":[…]}]}
One object per sentence listed at the end, same ids, same order.

EXAMPLE for the sentence «S1: 我很喜欢中国菜。»:
${EXAMPLE}

${FINAL_CHECK}

`;
    const suffix = `ANALYZE THESE SENTENCES (id: text):
${sentenceList(sentences)}`;
    return [prefix, suffix];
  }

  function analyzePrompt(args) {
    return analyzePromptParts(args).join('');
  }

  /**
   * Second-examiner review of one chunk.
   * current: { S1: analysis, … } as stored. Reply → normalizeReview(reply, sentences).
   */
  function reviewPrompt({ doc, course, glossary, sentences, current }) {
    const first = {
      sentences: sentences.filter((s) => current && current[s.id]).map((s) => ({ id: s.id, ...current[s.id] })),
    };
    return `${persona(course)}

You are the SECOND examiner. A first examiner analyzed some sentences of this text for the student (JSON below). Find and fix every error.

THE WHOLE TEXT (context only):
${passage(doc)}

GLOSSARY — use exactly these Arabic renderings:
${glossaryBlock(glossary)}

THE SENTENCES (id: text):
${sentenceList(sentences)}

FIRST EXAMINER'S ANALYSIS:
${JSON.stringify(first)}

THE RULES BOTH EXAMINERS FOLLOW:
${RULES}

Check especially: every 了 (completion or change of state), the word after 是, 把, 去/来 + verb, 兼语 verbs, 得 complements, 不 translated as past, and unfounded typo or «زائدة» claims; pinyin of polyphones and of 一/不; words that do not reproduce the printed sentence exactly; wrong role or i'rab, including what a word attaches to; meanings that do not fit the context; translation errors (missing or added meaning, tense, negation scope, proper-noun names, Arabic grammar and spelling); wrong or missing patterns for EMPHASIZED items. Keep everything that is already correct exactly as it is — do not rephrase for style. If a sentence is missing from the first analysis, write it in full.

OUTPUT — reply with only this JSON, no markdown fences:
{"changes_ar":["one short Arabic line per correction, e.g. «S2: نطق 地 هنا de وليس dì»"],"sentences":[the complete corrected analysis, same shape and ids]}
If nothing is wrong, return the analysis unchanged with "changes_ar": [].

${FINAL_CHECK}`;
  }

  /** Whole-text overview. Reply → normalizeOverview(reply). Run it before the chunks: they use its glossary. */
  function overviewPrompt({ doc, course }) {
    return `${persona(course)}

Read the whole text below and prepare the overview the student studies before the sentence-by-sentence work.

TEXT:
${passage(doc)}

Reply with only this JSON, no markdown fences:
{"title_ar":"…","genre_ar":"…","main_idea_ar":"…","purpose_ar":"…","paragraphs":[{"n":1,"idea_ar":"…"}],"glossary":[{"zh":"…","py":"…","ar":"…","note_ar":"…"}],"tips_ar":["…"]}

- "title_ar": the title translated into Arabic, exam quality ("" if there is no title).
- "genre_ar": the kind of text in 2–4 Arabic words (خبر صحفي، مقال رأي، خطاب، قصة قصيرة…).
- "main_idea_ar": the main idea in 2–3 Arabic sentences. "purpose_ar": the author's purpose or stance in one Arabic sentence.
- "paragraphs": one entry per numbered paragraph, same numbers, the idea of each in one Arabic sentence.
- "glossary": every proper noun (people, countries, cities, institutions, newspapers, titles of office) and every key term that repeats or has a fixed Arabic equivalent, with the exact Arabic wording the translation must use everywhere — established Arabic names, never literal ones (《金字塔报》 → صحيفة «الأهرام»). "py" in tone marks. "note_ar" only when it helps, else "". Up to 15 entries, most important first.
- "tips_ar": 3–6 short Arabic tips specific to THIS text for the exam: translation traps, repeated structures, tense, names.
- Write in Arabic, quoting Chinese only as it is printed in the text — never mix English or pinyin into a Chinese quote. Do not count how often a word appears unless you counted it in the text. Call something a typo only when the printed form is not a real word or is ungrammatical (托 = يُوكِل is a real verb). Glossary "py": dictionary pinyin with tone marks, syllables of a word together, a four-character expression in two halves (bùkě gūliàng).`;
  }

  /** OCR of one photo (pass the image in options.images). Reply → normalizeOcr(reply). */
  function ocrPrompt({ page = 1, pages = 1 } = {}) {
    return `This photo is page ${page} of ${pages} of a printed Chinese handout from an Egyptian university course. It may be rotated, tilted, curved or shadowed.

Transcribe ALL of the printed Chinese text exactly:
- Simplified characters exactly as printed. Do not correct, modernize, add or drop anything — even an obvious typo stays as printed.
- Keep the Chinese punctuation exactly (，。、；：？！“”‘’《》（）……——).
- "paragraphs": one string per paragraph, in reading order. Lines that wrap inside a paragraph are joined with no space. A paragraph starts where the first line is indented or after a visible gap.
- "title": a heading line, if the page has one (otherwise ""). Do not repeat it in paragraphs.
- Emphasis: wrap each run of characters printed in bold (visibly heavier than the text around it), underlined or highlighted in **double asterisks**, e.g. 今天我跟大家分享**我认为**是**最有效**的办事方式。 No asterisks if nothing is emphasized.
- Ignore page numbers, handwriting and anything that is not printed Chinese text.
- "uncertain": every character you could not read with confidence: {"text": what you transcribed, "context": the 6–10 characters around it, "reason_ar": a short Arabic reason}. Empty array if none.

Reply with only this JSON, no markdown fences:
{"title":"…","paragraphs":["…"],"uncertain":[],"notes_ar":"one short Arabic sentence about anything the student should double-check, or \\"\\""}`;
  }

  /** Grade the student's translation. Reply → normalizeGrade(reply). */
  function gradePrompt({ source, reference, student, course, glossary }) {
    return `${persona(course)}

Grade the student's Arabic translation of this Chinese passage the way the course examiner would. Every meaning error, omission, addition, wrong proper-noun name, wrong tense or negation, and Arabic grammar or spelling mistake loses marks. Different wording that is faithful and correct is NOT a mistake — do not penalize it.

CHINESE:
${source}

REFERENCE TRANSLATION (one acceptable version, not the only one):
${reference || '(none)'}

GLOSSARY:
${glossaryBlock(glossary)}

STUDENT'S TRANSLATION:
${student}

Scoring out of 10: start at 10. A meaning error, omission, addition, wrong name or wrong tense/negation: −1 each (−0.5 if minor). An Arabic grammar or spelling mistake: −0.5. A clumsy but correct phrasing: −0.25 (style costs at most −1 in total). Never below 0.

Reply with only this JSON, no markdown fences:
{"score":7.5,"verdict_ar":"…","errors":[{"type":"…","student":"…","fix":"…","why_ar":"…"}],"corrected_ar":"…","model_ar":"…"}
- "type": one of ${ERROR_TYPES.map((t) => `«${t}»`).join('، ')}.
- "student": the exact words from the student's translation ("" for an omission). "fix": the corrected wording. "why_ar": a short Arabic reason.
- "corrected_ar": the student's translation with only the errors fixed, their wording kept otherwise.
- "model_ar": the best translation.
- "verdict_ar": one Arabic sentence summing up the result.`;
  }

  /** Compact text form of one analyzed sentence, for chat context. */
  function analysisSummary(sentence, a) {
    if (!a) return '(not analyzed yet)';
    const words = a.words.map((w, i) => `${i + 1}. ${w.w} (${w.py}) — ${w.role} — ${w.mean}`).join('\n');
    return `Translation: ${a.translation_ar}\nStructure: ${a.structure_ar}\nWords:\n${words}`;
  }

  /**
   * The standing first user turn of a chat about a text.
   * focus (optional): { sentence, analysis } — the sentence the student opened the chat from.
   * Call sample([{ role: 'user', content: tutorIntro(...) }, ...turns], { cache: false }).
   */
  function tutorIntro({ doc, course, focus }) {
    const f = focus && focus.sentence
      ? `\n\nTHE SENTENCE THE STUDENT IS LOOKING AT (${focus.sentence.id}): ${focus.sentence.text}\n${analysisSummary(focus.sentence, focus.analysis)}`
      : '';
    return `${persona(course)}

You are now chatting with the student about the text below. Answer in clear, simple Arabic (فصحى مبسطة; a light Egyptian tone is fine). Keep answers short and organized — short paragraphs or "- " bullets, Chinese words followed by their pinyin in parentheses. Use the class's i'rab terms (مبتدأ، خبر، مفعول به، صفة، مضاف إليه، حال، ظرف، مكمّل، أداة ربط، أداة) with the Chinese component name when relevant. You may use **bold**; no tables, no headings. If you are not sure, say so — never invent.

THE TEXT:
${passage(doc)}${f}`;
  }

  const api = {
    PROMPT_VERSION,
    ROLE_GROUPS,
    ERROR_TYPES,
    COURSE_AR,
    // text
    isPunct,
    stripPunct,
    parseBold,
    splitSentences,
    parseEditor,
    buildDocument,
    alignWords,
    sentencePinyin,
    literalGloss,
    roleGroup,
    canonicalRoleZh,
    // normalizers
    normalizeOcr,
    mergeOcrPages,
    normalizeOverview,
    normalizeChunk,
    normalizeReview,
    normalizeGrade,
    checkAnalysis,
    // prompts
    ocrPrompt,
    overviewPrompt,
    analyzePrompt,
    analyzePromptParts,
    reviewPrompt,
    gradePrompt,
    tutorIntro,
    analysisSummary,
  };

  root.MuribCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
