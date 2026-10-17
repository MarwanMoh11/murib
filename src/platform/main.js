// Platform shell: setup screen, lock screen, auto-lock, then boots the app with
// the Anthropic AI backend and the GitHub store. Inert in #mock mode.
import { createAnthropicAI } from './anthropic.js';
import { createGithubStore } from './github-store.js';
import { encryptConfig, unlock, unlockRemembered, rememberDevice, forgetDevice, isRemembered } from './vault.js';

const DEFAULT_REPO = 'MarwanMoh11/murib-data';
const AUTO_LOCK_MS = 30 * 60 * 1000;
const MIN_PASSWORD = 12;

// Lock/setup styles live in src/styles.css (shared design tokens).
const CSS = '';

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const BRAND = `<div class="lk-brand"><div class="lk-seal" aria-hidden="true">析</div><div><h1 class="lk-name">مُعرِب</h1><p class="lk-tag">إعراب النصوص الصينية وترجمتها إلى العربية</p></div></div>`;

function root() {
  let r = document.getElementById('lock-root');
  if (!r) {
    r = document.createElement('div');
    r.id = 'lock-root';
    document.body.prepend(r);
  }
  return r;
}

function show(node) {
  const r = root();
  r.hidden = false;
  r.replaceChildren(node);
}

function hide() {
  const r = root();
  r.replaceChildren();
  r.hidden = true;
}

async function loadConfig() {
  try {
    const res = await fetch('config.enc.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const c = await res.json();
    return c && c.ct && c.salt && c.iv ? c : null;
  } catch {
    return null;
  }
}

function storageMessage(e) {
  if (e && e.code === 'storage_auth') return 'رمز GitHub لا يملك صلاحية على مستودع البيانات أو انتهت صلاحيته. أنشئ رمزًا جديدًا ثم أعد الإعداد.';
  return 'تعذّر الوصول إلى مستودع البيانات على GitHub. تحقّق من الاتصال ثم أعد المحاولة.';
}

// ── Boot ──

async function start(secrets, { remembered }) {
  const ai = createAnthropicAI({ apiKey: secrets.anthropicKey });
  const store = createGithubStore({ token: secrets.githubToken, repo: secrets.dataRepo || DEFAULT_REPO });
  await store.init();
  hide();
  let locking = false;
  const lockNow = async () => {
    if (locking) return;
    locking = true;
    const A = window.MuribApp || {};
    if (A.busy && A.busy()) await finishRunningWork(A);
    // Pending saves get a few seconds; a dead network must not keep the app unlocked.
    await Promise.race([A.settle ? A.settle().catch(() => {}) : null, new Promise((r) => setTimeout(r, 8000))]);
    await forgetDevice();
    location.hash = '';
    location.reload();
  };
  if (!remembered) armAutoLock(lockNow);
  window.MuribApp.boot({ ai, store, onLock: lockNow, mode: 'live' });
}

// Locking while AI calls run: hide the app at once, but let the calls finish and save,
// since they are already being paid for. "Lock now" abandons them (the reload ends them).
function finishRunningWork(A) {
  const app = document.getElementById('app');
  if (app) app.hidden = true;
  return new Promise((resolve) => {
    const node = el(`<main class="lk"><div class="lk-card">${BRAND}
      <p class="lk-sub"><b>تم القفل.</b> يُكمل التحليل الجاري ويحفظه حتى لا يضيع رصيدك، ثم تظهر شاشة كلمة المرور تلقائيًا.</p>
      <button class="lk-btn secondary" type="button">اقفل فورًا وأوقف التحليل</button></div></main>`);
    node.querySelector('button').addEventListener('click', resolve);
    show(node);
    const poll = () => (A.busy() ? setTimeout(poll, 3000) : resolve());
    poll();
  });
}

function armAutoLock(lockNow) {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(lockNow, AUTO_LOCK_MS);
  };
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => addEventListener(ev, reset, { passive: true }));
  reset();
}

// ── Lock screen ──

function lockScreen(config) {
  const node = el(`<main class="lk"><form class="lk-card" novalidate>
    ${BRAND}
    <p class="lk-sub">أدخل كلمة المرور لفتح مكتبتك.</p>
    <div class="lk-field"><label for="lk-pass">كلمة المرور</label>
      <input id="lk-pass" type="password" autocomplete="current-password" required></div>
    <label class="lk-check"><input id="lk-remember" type="checkbox">
      <span>تذكّر هذا الجهاز — لهاتفك أو حاسوبك الشخصي فقط، لا تستخدمه على أجهزة الكلية أو المقاهي.</span></label>
    <p class="lk-err" role="alert" hidden></p>
    <button class="lk-btn" type="submit">افتح</button>
    <button class="lk-link" type="button" data-setup>إعداد مفاتيح جديدة</button>
  </form></main>`);
  const form = node.querySelector('form');
  const err = node.querySelector('.lk-err');
  const btn = node.querySelector('.lk-btn');
  node.querySelector('[data-setup]').onclick = () => setupScreen();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const pass = node.querySelector('#lk-pass').value;
    if (!pass) return;
    btn.disabled = true;
    btn.textContent = 'جارٍ الفتح…';
    err.hidden = true;
    try {
      const { secrets, key } = await unlock(config, pass);
      const remember = node.querySelector('#lk-remember').checked;
      if (remember) await rememberDevice(config, key);
      await start(secrets, { remembered: remember });
    } catch (e) {
      err.textContent = e && e.code === 'wrong_password' ? 'كلمة المرور غير صحيحة.' : storageMessage(e);
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'افتح';
    }
  };
  show(node);
  node.querySelector('#lk-pass').focus();
}

// ── Setup screen ──

function setupScreen() {
  const node = el(`<main class="lk"><form class="lk-card lk-wide" novalidate>
    ${BRAND}
    <p class="lk-sub">إعداد لمرة واحدة. المفاتيح تُشفَّر بكلمة مرورك داخل هذا المتصفح، ولا تُرسَل إلى أي مكان غير Anthropic وGitHub.</p>
    <ol class="lk-steps">
      <li>أنشئ مفتاح API من <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> في الحساب الذي فيه رصيدك، وضع حدًّا شهريًا للإنفاق من صفحة Limits.</li>
      <li>أنشئ رمز GitHub دقيق الصلاحيات من <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">إعدادات GitHub</a>: اختر المستودع <b dir="ltr">murib-data</b> فقط، وصلاحية <b dir="ltr">Contents: Read and write</b>.</li>
      <li>اختر كلمة مرور طويلة (${MIN_PASSWORD} حرفًا على الأقل) — جملة من عدة كلمات أسهل للتذكر وأقوى.</li>
    </ol>
    <div class="lk-field"><label for="su-key">مفتاح Anthropic API</label>
      <input id="su-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…"></div>
    <div class="lk-field"><label for="su-gh">رمز GitHub</label>
      <input id="su-gh" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></div>
    <div class="lk-field"><label for="su-repo">مستودع البيانات</label>
      <input id="su-repo" type="text" autocomplete="off" spellcheck="false" value="${DEFAULT_REPO}"></div>
    <div class="lk-field"><label for="su-pass">كلمة المرور</label>
      <input id="su-pass" type="password" autocomplete="new-password"></div>
    <div class="lk-field"><label for="su-pass2">أعد كتابة كلمة المرور</label>
      <input id="su-pass2" type="password" autocomplete="new-password"></div>
    <p class="lk-err" role="alert" hidden></p>
    <p class="lk-ok" role="status" hidden></p>
    <button class="lk-btn" type="submit">اختبر وشفّر</button>
    <div class="lk-field" data-out hidden>
      <label for="su-out">الإعداد المشفَّر</label>
      <small>هذا النص مشفَّر بكلمة مرورك وآمن للمشاركة. أرسله إلى Claude ليضعه في الموقع، أو احفظه باسم <b dir="ltr">docs/config.enc.json</b> في مستودع الموقع.</small>
      <textarea id="su-out" readonly></textarea>
      <div class="lk-row"><button class="lk-btn" type="button" data-copy>نسخ</button>
        <button class="lk-btn secondary" type="button" data-download>تنزيل الملف</button></div>
    </div>
  </form></main>`);
  const $ = (s) => node.querySelector(s);
  const err = $('.lk-err');
  const ok = $('.lk-ok');
  const btn = $('.lk-btn[type=submit]');
  const say = (box, msg) => {
    box.textContent = msg;
    box.hidden = !msg;
  };

  node.querySelector('form').onsubmit = async (ev) => {
    ev.preventDefault();
    say(err, '');
    say(ok, '');
    const anthropicKey = $('#su-key').value.trim();
    const githubToken = $('#su-gh').value.trim();
    const dataRepo = $('#su-repo').value.trim();
    const pass = $('#su-pass').value;
    if (!anthropicKey || !githubToken || !/^[\w.-]+\/[\w.-]+$/.test(dataRepo)) return say(err, 'املأ المفتاح والرمز واسم المستودع بالشكل owner/repo.');
    if (pass.length < MIN_PASSWORD) return say(err, `كلمة المرور قصيرة: ${MIN_PASSWORD} حرفًا على الأقل.`);
    if (pass !== $('#su-pass2').value) return say(err, 'كلمتا المرور غير متطابقتين.');
    btn.disabled = true;
    try {
      btn.textContent = 'أختبر مفتاح Anthropic…';
      const check = await createAnthropicAI({ apiKey: anthropicKey }).check();
      if (!check.ok) {
        throw new Error(check.code === 'auth_failed' ? 'مفتاح Anthropic غير صالح.' : 'تعذّر الاتصال بـAnthropic. تحقّق من الاتصال ثم أعد المحاولة.');
      }
      btn.textContent = 'أختبر GitHub…';
      const store = createGithubStore({ token: githubToken, repo: dataRepo });
      try {
        await store.init();
        await store.checkWrite();
      } catch (e) {
        throw new Error(storageMessage(e));
      }
      btn.textContent = 'أشفّر…';
      const config = await encryptConfig({ anthropicKey, githubToken, dataRepo, createdAt: new Date().toISOString() }, pass);
      const json = JSON.stringify(config, null, 2);
      $('#su-out').value = json;
      $('[data-out]').hidden = false;
      say(ok, 'المفتاحان يعملان. انسخ الإعداد المشفَّر بالأسفل.');
      $('[data-copy]').onclick = async () => {
        try {
          await navigator.clipboard.writeText(json);
          say(ok, 'تم النسخ.');
        } catch {
          $('#su-out').select();
        }
      };
      $('[data-download]').onclick = () => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        a.download = 'config.enc.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
      ['#su-key', '#su-gh', '#su-pass', '#su-pass2'].forEach((s) => ($(s).value = ''));
    } catch (e) {
      say(err, e.message || 'حدث خطأ غير متوقع.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'اختبر وشفّر';
    }
  };
  show(node);
}

// ── Entry ──

async function main() {
  if (location.hash.includes('mock')) return; // the app boots itself with mock backends
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  show(el(`<main class="lk"><div class="lk-card">${BRAND}<p class="lk-sub">جارٍ التحميل…</p></div></main>`));

  const config = await loadConfig();
  if (!config || location.hash.includes('setup')) return setupScreen();
  if (await isRemembered()) {
    const secrets = await unlockRemembered(config);
    if (secrets) {
      try {
        return await start(secrets, { remembered: true });
      } catch (e) {
        /* fall through to the password screen with the error */
        lockScreen(config);
        const err = document.querySelector('.lk-err');
        if (err) {
          err.textContent = storageMessage(e);
          err.hidden = false;
        }
        return;
      }
    }
  }
  lockScreen(config);
}

window.MuribPlatform = { createAnthropicAI, createGithubStore, version: 1 };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
else main();
