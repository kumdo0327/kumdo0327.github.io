// Settings live in localStorage. Finished translations are cached in IndexedDB,
// keyed by a hash of the target language and the source paragraph, so opening a
// paper again costs no API calls.

import { PROVIDERS } from './llm.js';

const SETTINGS_KEY = 'easypaper:settings';
const KEYS_KEY = 'easypaper:keys';

/** [name used in the prompt, label shown in the menu] */
export const LANGUAGES = [
  ['Korean', '한국어'],
  ['English', 'English'],
  ['Japanese', '日本語'],
  ['Simplified Chinese', '简体中文'],
  ['Traditional Chinese', '繁體中文'],
  ['Spanish', 'Español'],
  ['French', 'Français'],
  ['German', 'Deutsch'],
];

const DEFAULTS = {
  provider: 'anthropic',
  models: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.models[0] || ''])),
  // API addresses of the OpenAI-compatible providers, editable in the settings.
  baseUrls: Object.fromEntries(Object.entries(PROVIDERS).filter(([, p]) => p.group === 'compatible').map(([id, p]) => [id, p.baseUrl])),
  language: 'Korean',
  notes: '',
  rememberKeys: true,
};

const SETTINGS_VERSION = 2;
// The defaults before version 2. Older saved settings hold them only because
// they were the defaults, so they give way to today's lighter ones.
const V1_DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-terra', gemini: 'gemini-3.8-flash' };

export function loadSettings() {
  const saved = readJSON(localStorage, SETTINGS_KEY) || {};
  const keys = readJSON(localStorage, KEYS_KEY) || readJSON(sessionStorage, KEYS_KEY) || {};
  const models = { ...saved.models };
  if (!saved.version) {
    for (const [id, model] of Object.entries(V1_DEFAULT_MODELS)) if (models[id] === model) delete models[id];
  }
  return {
    ...DEFAULTS,
    ...saved,
    provider: PROVIDERS[saved.provider] ? saved.provider : DEFAULTS.provider,
    models: { ...DEFAULTS.models, ...models },
    baseUrls: { ...DEFAULTS.baseUrls, ...saved.baseUrls },
    keys: Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, keys[id] || ''])),
  };
}

export function saveSettings(settings) {
  const { keys, ...rest } = settings;
  writeJSON(localStorage, SETTINGS_KEY, { ...rest, version: SETTINGS_VERSION });
  // Unremembered keys go to sessionStorage, which the browser clears when the tab closes.
  writeJSON(settings.rememberKeys ? localStorage : sessionStorage, KEYS_KEY, keys);
  remove(settings.rememberKeys ? sessionStorage : localStorage, KEYS_KEY);
}

function readJSON(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function writeJSON(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private windows, blocked site data); settings then last for this visit.
  }
}

function remove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    // see writeJSON
  }
}

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('easypaper', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('translations');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null);
  return dbPromise;
}

export async function cacheKey(language, text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${language}\n${text}`));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** Cached translations for the given keys, undefined where there is none. */
export async function getCached(keys) {
  const conn = await db();
  if (!conn || !keys.length) return [];
  return new Promise(resolve => {
    const out = new Array(keys.length);
    const tx = conn.transaction('translations');
    keys.forEach((key, i) => {
      tx.objectStore('translations').get(key).onsuccess = e => (out[i] = e.target.result);
    });
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve(out);
  });
}

export async function putCached(key, value) {
  const conn = await db();
  conn?.transaction('translations', 'readwrite').objectStore('translations').put(value, key);
}

export async function deleteCached(keys) {
  const conn = await db();
  if (!conn || !keys.length) return;
  await new Promise(resolve => {
    const tx = conn.transaction('translations', 'readwrite');
    for (const key of keys) tx.objectStore('translations').delete(key);
    tx.oncomplete = tx.onerror = tx.onabort = resolve;
  });
}

export async function clearCache() {
  const conn = await db();
  if (!conn) return;
  await new Promise(resolve => {
    const tx = conn.transaction('translations', 'readwrite');
    tx.objectStore('translations').clear();
    tx.oncomplete = tx.onerror = tx.onabort = resolve;
  });
}
