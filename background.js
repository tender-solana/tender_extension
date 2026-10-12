// Tender — service worker: talks to the Tender server and stores the pairing.
// the Tender server (paywithtender.vercel.app); a pairing made on a local server (127.0.0.1) keeps using that one
const DEFAULT_SERVER = 'https://paywithtender.vercel.app';

// Older versions talked to a local server started by "Lancer Tender.bat": forget that pairing,
// so the extension links to paywithtender.vercel.app and works without anything running on the computer.
const isLocal = (server) => /^http:\/\/(127\.0\.0\.1|localhost)/.test(server || '');
const forgetPairing = () => chrome.storage.local.remove(['server', 'token', 'userId', 'rdns']);
// Pairings made on spendly.lol (the product's previous address, same server and accounts behind it):
// keep the link, just move it to the current address.
const isOldAddress = (server) => /^https:\/\/(www\.)?spendly\.lol\/?$/.test(server || '');
chrome.runtime.onInstalled.addListener(async () => {
  const { server } = await chrome.storage.local.get('server');
  if (isLocal(server)) await forgetPairing();
  else if (isOldAddress(server)) await chrome.storage.local.set({ server: DEFAULT_SERVER });
});

async function settings() {
  const s = await chrome.storage.local.get(['server', 'token', 'userId', 'rdns']);
  return { server: (!s.server || isOldAddress(s.server) ? DEFAULT_SERVER : s.server).replace(/\/+$/, ''), token: s.token || '', userId: s.userId || null, rdns: s.rdns || null };
}

async function api({ method = 'GET', path, body, timeout = 15000 }) {
  const { server, token } = await settings();
  if (!token) return { ok: false, error: 'NOT_PAIRED' };
  let res;
  try {
    res = await fetch(server + path, { method, headers: { 'content-type': 'application/json', 'x-spendly-token': token }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch {
    // linked to a local server that isn't running any more: drop that link, the dashboard on paywithtender.vercel.app relinks it
    if (isLocal(server)) {
      await forgetPairing();
      return { ok: false, error: 'NOT_PAIRED' };
    }
    return { ok: false, error: 'SERVER_DOWN' };
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) return { ok: false, error: 'NOT_PAIRED' };
  return res.ok ? { ok: true, data } : { ok: false, error: data.error || `HTTP ${res.status}`, data };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'api':
        return api(msg);
      case 'pair':
        // only accepted from the Tender site itself (checked by the content script)
        await chrome.storage.local.set({ token: msg.token, server: msg.server, userId: msg.userId, rdns: msg.rdns ?? null });
        return { ok: true };
      case 'pairing': {
        const s = await settings();
        return { server: s.server, userId: s.userId, rdns: s.rdns, paired: !!s.token };
      }
      case 'openTab': {
        const t = await chrome.tabs.create({ url: msg.url, active: msg.active !== false });
        return { tabId: t.id };
      }
      case 'saveCodes': {
        const { history = [] } = await chrome.storage.local.get('history');
        history.unshift({ at: new Date().toISOString(), host: msg.host, codes: msg.codes });
        await chrome.storage.local.set({ history: history.slice(0, 50) });
        return { ok: true };
      }
      default:
        return undefined;
    }
  })().then(sendResponse);
  return true;
});
