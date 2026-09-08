/*
 * Codeforces Statistics — service worker.
 *
 * Every network call lives here: one rate-limited queue for the whole browser,
 * one cache, no matter how many Codeforces tabs are open. Content scripts only
 * ask for a submission index and get back a compact result.
 */
importScripts(
  chrome.runtime.getURL('src/core/matching.js'),
  chrome.runtime.getURL('src/core/errors.js'),
  chrome.runtime.getURL('src/core/cf-api.js')
);

const CFST = self.CFST;
const TAG = '[CF Stats]';

const storage = {
  get(key) {
    return new Promise((resolve) => chrome.storage.local.get(key, (o) => resolve(o ? o[key] : undefined)));
  },
  set(key, value) {
    return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, () => resolve()));
  },
  remove(key) {
    return new Promise((resolve) => chrome.storage.local.remove(key, () => resolve()));
  }
};

const api = CFST.createApi({
  fetchImpl: (url, init) => fetch(url, init),
  storage,
  matching: CFST.matching,
  errors: CFST.errors,
  log: (...args) => console.log(TAG, ...args)
});

// One in-flight request per handle, shared by every tab that asks.
const inFlight = new Map();

function loadIndex({ handle, contestId, force, revalidate }) {
  // The mode is part of the key: a revalidating caller must never be handed the
  // result of an in-flight request that was allowed to answer from cache.
  const mode = force ? 'force' : (revalidate ? 'revalidate' : 'cache');
  const key = String(handle).toLowerCase() + '|' + (contestId || '') + '|' + mode;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = api.loadIndex({ handle, contestId, force, revalidate }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'CFSTATS_LOAD') return;

  loadIndex(msg)
    .then((res) => {
      if (!res.ok) {
        console.log(TAG, 'submission load failed:', res.error.code, res.error.detail || '');
        sendResponse({ ok: false, error: { code: res.error.code, message: res.error.message } });
        return;
      }
      sendResponse({
        ok: true,
        index: res.index,
        fetchedAt: res.fetchedAt,
        fromCache: res.fromCache,
        revalidated: !!res.revalidated,
        warning: res.warning || null
      });
    })
    .catch((err) => {
      console.log(TAG, 'unexpected failure:', err && err.message);
      sendResponse({ ok: false, error: CFST.errors.build(undefined, err && err.message) });
    });

  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  console.log(TAG, 'installed. Statistics are injected directly into Codeforces pages.');
});
