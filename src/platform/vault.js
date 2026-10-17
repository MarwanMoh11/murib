// Password vault: the API key and GitHub token live in the public site only as
// AES-GCM ciphertext under a PBKDF2-derived key. Decrypted secrets stay in memory.
// "Remember this device" stores the derived key in IndexedDB as a NON-extractable
// CryptoKey, so the raw key and the secrets are never written to disk.

const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations, extractable = false) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

/** secrets → the JSON object published as config.enc.json */
export async function encryptConfig(secrets, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secrets)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

async function decryptWithKey(config, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(config.iv) }, key, unb64(config.ct));
  return JSON.parse(dec.decode(pt));
}

/** → { secrets, key } or throws { code: 'wrong_password' } */
export async function unlock(config, password) {
  const key = await deriveKey(password, unb64(config.salt), config.iter || ITERATIONS);
  try {
    return { secrets: await decryptWithKey(config, key), key };
  } catch {
    throw { code: 'wrong_password' };
  }
}

// ── Remembered device (IndexedDB, non-extractable key) ──

const DB = 'murib-device';
const STORE = 'keys';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** Store the key bound to this exact config (by its salt). */
export async function rememberDevice(config, key) {
  try {
    await idbOp('readwrite', (s) => s.put({ key, salt: config.salt }, 'vault'));
    return true;
  } catch {
    return false;
  }
}

/** → secrets, or null when this device is not remembered or the config changed. */
export async function unlockRemembered(config) {
  try {
    const entry = await idbOp('readonly', (s) => s.get('vault'));
    if (!entry || entry.salt !== config.salt) return null;
    return await decryptWithKey(config, entry.key);
  } catch {
    return null;
  }
}

export async function forgetDevice() {
  try {
    await idbOp('readwrite', (s) => s.delete('vault'));
  } catch {
    /* nothing remembered */
  }
}

export async function isRemembered() {
  try {
    return !!(await idbOp('readonly', (s) => s.get('vault')));
  } catch {
    return false;
  }
}
