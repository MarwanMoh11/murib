// AI backend: the Anthropic Messages API called straight from the browser with
// the student's own key. Implements the app's AI interface (see SPEC.md).
import Anthropic from '@anthropic-ai/sdk';

// Haiku does the everyday work; Sonnet is the optional stronger tier and the «دقّق» examiner.
// Any other tier (e.g. 'best' saved by older versions) falls back to Sonnet.
const MODELS = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };

// Effort (thinking depth) and output room per task. max_tokens includes thinking; every
// call streams. Thinking is most of the time and cost: reading and overviews need little,
// analysis and grading get medium, and only the on-demand «دقّق» review thinks hard.
const TASKS = {
  ocr: { effort: 'low', max_tokens: 12000 },
  overview: { effort: 'low', max_tokens: 12000 },
  analyze: { effort: 'medium', max_tokens: 20000 },
  review: { effort: 'high', max_tokens: 32000 },
  grade: { effort: 'medium', max_tokens: 16000 },
  chat: { effort: 'low', max_tokens: 8000 },
};

// A stream that drops mid-reply (flaky mobile data, a busy server) is retried here,
// since the SDK only retries before a reply starts.
const RETRY_CODES = ['upstream_error', 'overloaded'];
const RETRY_WAIT_MS = [2000, 6000];

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject({ code: 'cancelled', message: 'cancelled' }); }, { once: true });
  });

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Whole reply, else a ```json fence, else first { / [ to last } / ]. */
export function parseLooseJson(text) {
  const t = String(text || '').trim();
  const attempts = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1]);
  const a = t.search(/[[{]/);
  const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) attempts.push(t.slice(a, b + 1));
  for (const s of attempts) {
    try {
      return JSON.parse(s);
    } catch {
      /* next */
    }
  }
  throw { code: 'invalid_json', message: 'The reply held no parseable JSON.', text: t };
}

function mapError(e, text) {
  if (e && typeof e.code === 'string' && !(e instanceof Error)) return e; // already ours
  const base = (code) => ({ code, message: String((e && e.message) || code), ...(text ? { text } : {}) });
  if (e instanceof Anthropic.APIUserAbortError || (e && e.name === 'AbortError')) return base('cancelled');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return base('auth_failed');
  if (e instanceof Anthropic.RateLimitError) return base('rate_limited');
  if (e instanceof Anthropic.BadRequestError) {
    const m = String(e.message || '');
    if (/credit balance|billing/i.test(m)) return base('no_credit');
    if (/too long|too large|exceed/i.test(m)) return base('prompt_too_large');
    if (/image/i.test(m)) return base('image_rejected');
    return base('invalid_request');
  }
  if (e instanceof Anthropic.APIConnectionError) return base('upstream_error');
  if (e instanceof Anthropic.InternalServerError || (e && e.status === 529)) return base('overloaded');
  return base('upstream_error');
}

// Consecutive same-role turns are merged; the list must start and end with a user turn.
function normalizeTurns(turns) {
  const out = [];
  for (const t of turns || []) {
    const role = t.role === 'assistant' ? 'assistant' : 'user';
    const content = String(t.content || '').trim();
    if (!content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n\n' + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export function createAnthropicAI({ apiKey }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 4 });
  async function run({ task, tier, messages, signal, onText, onUsage }) {
    const t = TASKS[task] || TASKS.chat;
    const body = {
      model: MODELS[tier] || MODELS.smart,
      max_tokens: t.max_tokens,
      output_config: { effort: t.effort },
      messages,
    };
    for (let attempt = 0; ; attempt++) {
      let full = '';
      try {
        const stream = client.messages.stream(body, { signal });
        stream.on('text', (delta) => {
          full += delta;
          if (onText) onText({ text: full, delta });
        });
        const msg = await stream.finalMessage();
        if (onUsage && msg.usage) onUsage(msg.usage);
        if (msg.stop_reason === 'refusal') {
          throw { code: 'refused', message: (msg.stop_details && msg.stop_details.explanation) || 'refused' };
        }
        const text = (msg.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (!text.trim()) throw { code: 'empty_completion', message: 'empty reply' };
        return { text, truncated: msg.stop_reason === 'max_tokens' };
      } catch (e) {
        const err = mapError(e, full || undefined);
        if (attempt < RETRY_WAIT_MS.length && RETRY_CODES.includes(err.code) && !(signal && signal.aborted)) {
          if (onText) onText({ text: '', delta: '' }); // the retry starts the reply over
          await wait(RETRY_WAIT_MS[attempt], signal);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    limits: async () => ({ images: { maxCount: 8, mediaTypes: IMAGE_TYPES } }),

    /** prompt: a string, or [prefix, suffix] where the prefix is shared by many calls and cached. */
    async json(prompt, { task = 'analyze', tier = 'smart', images, signal, onUsage } = {}) {
      const parts = Array.isArray(prompt) ? prompt : [prompt];
      const content = [];
      for (const img of images ? Array.from(images) : []) {
        const media = IMAGE_TYPES.includes(img.type) ? img.type : 'image/jpeg';
        content.push({ type: 'image', source: { type: 'base64', media_type: media, data: await blobToBase64(img) } });
      }
      parts.forEach((text, i) => {
        const block = { type: 'text', text };
        if (parts.length > 1 && i === 0) block.cache_control = { type: 'ephemeral' };
        content.push(block);
      });
      const { text, truncated } = await run({ task, tier, messages: [{ role: 'user', content }], signal, onUsage });
      if (truncated) throw { code: 'invalid_json', message: 'The reply was cut short.', text };
      return parseLooseJson(text);
    },

    async stream(turns, { task = 'chat', tier = 'smart', signal, onText, onUsage } = {}) {
      const messages = normalizeTurns(turns);
      if (!messages.length || messages[messages.length - 1].role !== 'user') {
        throw { code: 'invalid_request', message: 'turns must end with a user turn' };
      }
      return run({ task, tier, messages, signal, onText, onUsage });
    },

    /** Cheap credential check for the setup screen (no tokens spent). */
    async check() {
      try {
        await client.models.list({ limit: 1 });
        return { ok: true };
      } catch (e) {
        return { ok: false, ...mapError(e) };
      }
    },
  };
}
