// Tender toolbar popup: link status, this tab, paying wallet, store credit, recent payments.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
const money = (v, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' }).format(v);
const logo = (brand) => `<img class="logo" src="assets/brands/${esc(brand)}.svg" alt="" />`;
const BRANDS = ['amazon', 'apple', 'nike', 'sephora', 'adidas', 'zalando', 'ikea', 'airbnb'];
const view = $('view');

// a message to the service worker that never hangs the popup
const ask = (msg, ms = 20000) =>
  Promise.race([chrome.runtime.sendMessage(msg), new Promise((r) => setTimeout(() => r({ ok: false, error: 'SERVER_DOWN' }), ms))]).catch(() => ({ ok: false, error: 'SERVER_DOWN' }));
const api = (path, opts = {}) => ask({ type: 'api', path, ...opts }, (opts.timeout ?? 15000) + 1000);

function pill(cls, text) {
  $('pill').className = `pill ${cls}`;
  $('pill').querySelector('span').textContent = text;
}

// a stable two-colour avatar from the wallet address
function avatar(address) {
  let h = 0;
  for (const ch of address || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const a = h % 360;
  const b = (a + 50 + ((h >> 9) % 90)) % 360;
  return `<span class="avatar" style="background: radial-gradient(circle at 30% 28%, hsl(${a} 85% 72%), hsl(${a} 70% 50%) 45%, hsl(${b} 70% 38%))"></span>`;
}

function when(iso) {
  const d = new Date(iso);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `Today, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------- this tab
async function tabCard() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* no tab access */
  }
  let url;
  try {
    url = new URL(tab?.url || '');
  } catch {
    /* chrome:// page, new tab… */
  }

  // the content script knows best: store, checkout page, panel state
  let state = null;
  if (tab?.id && url?.protocol.startsWith('http')) {
    state = await Promise.race([chrome.tabs.sendMessage(tab.id, { type: 'spendly-state' }).catch(() => null), new Promise((r) => setTimeout(() => r(null), 800))]);
  }
  let store = state?.store ?? null;
  // the Tender site itself only counts as a store on its test pages
  const local = /^(127\.0\.0\.1|localhost|paywithtender\.vercel\.app)$/.test(url?.hostname ?? '');
  if (!store && url?.protocol.startsWith('http') && (!local || url.pathname.startsWith('/test/'))) {
    const r = await api('/api/ext/match', { method: 'POST', body: { host: url.hostname, path: url.pathname } });
    if (r.ok) store = r.data.store;
  }

  if (!store) {
    return `<section class="card in">
      <div class="tab">
        <span class="tab-logo"><span class="glyph"></span></span>
        <div><b>Shop on a supported store</b><p>Tender shows up by itself at checkout.</p></div>
      </div>
      <div class="brands">${BRANDS.map((b) => `<span title="${b}">${logo(b)}</span>`).join('')}</div>
    </section>`;
  }

  const brand = store.brandId;
  if (state?.checkout) {
    return `<section class="card in">
      <div class="tab">
        <span class="tab-logo ready">${logo(brand)}</span>
        <div><b>Ready to pay on ${esc(store.label)}</b><p>${state.panelOpen ? 'The Tender panel is at the bottom right of the page.' : 'Open the panel to pay this order with your wallet.'}</p></div>
      </div>
      ${state.panelOpen ? '' : `<button class="btn primary tab-action" data-show="${tab.id}">Pay this order with my wallet</button>`}
    </section>`;
  }
  return `<section class="card in">
    <div class="tab">
      <span class="tab-logo">${logo(brand)}</span>
      <div><b>${esc(store.label)} is supported</b><p>Fill your cart, then go to checkout: Tender offers to pay there.</p></div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- full states
function notLinked(server, expired) {
  pill('', expired ? 'Link expired' : 'Not linked');
  view.innerHTML = `<section class="state in">
    <h1>${expired ? 'Link Tender again' : 'Link Tender to your wallet'}</h1>
    <p>It takes one free signature, no transaction.</p>
    <ol>
      <li>Open your Tender dashboard.</li>
      <li>Connect your wallet (MetaMask, Rabby, Coinbase Wallet…).</li>
      <li>The extension links itself. Reopen this window.</li>
    </ol>
    <a class="btn primary" href="${esc(server)}/app" target="_blank">Connect my wallet →</a>
  </section>`;
  $('dash').closest('.bottom').hidden = true;
}

function offline() {
  pill('bad', 'Offline');
  view.innerHTML = `<section class="state in">
    <h1>Tender can't be reached</h1>
    <p>Check your connection, then try again. Running Tender locally? Start it with "Lancer Tender".</p>
    <button class="btn ghost" data-retry>Try again</button>
  </section>`;
  $('dash').closest('.bottom').hidden = true;
}

// ---------------------------------------------------------------- main
async function load() {
  view.innerHTML = '<div class="skeleton"><span></span><span></span><span class="short"></span></div>';
  $('dash').closest('.bottom').hidden = false;
  const pairing = (await ask({ type: 'pairing' }, 4000)) || {};
  const server = pairing.server || 'https://paywithtender.vercel.app';
  $('dash').href = `${server}/app`;
  $('help').href = `${server}/#how`;

  if (!pairing.paired) {
    const up = await fetch(`${server}/api/catalog`, { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);
    return up ? notLinked(server, false) : offline();
  }

  const [r, tabHtml] = await Promise.all([api('/api/ext/overview'), tabCard()]);
  if (!r.ok) return r.error === 'SERVER_DOWN' ? offline() : notLinked(server, true);
  const o = r.data;
  pill(o.mock ? 'sim' : 'ok', o.mock ? 'Simulation' : 'Linked');

  const walletHtml = o.payer
    ? `<section class="card in">
        <h2>Pays your orders</h2>
        <div class="wallet">
          <div class="wallet-who">${avatar(o.payer.address)}<div><b>${esc(o.payer.name)}</b><small class="num">${esc(short(o.payer.address))}</small></div></div>
          <div class="wallet-bal" id="bal"><span class="shimmer"></span></div>
        </div>
      </section>`
    : `<section class="card in"><h2>Pays your orders</h2><p class="empty">Add an Ethereum wallet (MetaMask, Rabby…) in your dashboard to pay.</p></section>`;

  const creditHtml = `<section class="card in">
    <h2>Store credit</h2>
    ${
      o.credit.length
        ? `<div class="rows">${o.credit
            .slice(0, 4)
            .map((c) => `<div class="row"><span class="ico">${logo(c.icon)}</span><span>${esc(c.storeLabel)}<small>Used first on your next order</small></span><span class="amt num">${money(c.balance, c.currency)}</span></div>`)
            .join('')}</div>`
        : '<p class="empty">Nothing yet. When an order leaves some credit, it shows up here and is used on your next order.</p>'
    }
  </section>`;

  const ordersHtml = o.orders.length
    ? `<section class="card in">
        <h2>Recent payments</h2>
        <div class="rows">${o.orders
          .slice(0, 3)
          .map(
            (x) =>
              `<div class="row"><span class="ico">${logo(x.icon)}</span><span>${esc(x.storeLabel)}<small>${esc(when(x.at))}${x.state === 'simulated' ? ' · simulation' : ''}</small></span><span class="amt num${x.state === 'error' ? ' err' : ''}">${x.state === 'error' ? 'Failed' : money(x.total, x.currency)}${x.usdcPaid ? `<small>${x.usdcPaid.toFixed(2)} USDC</small>` : ''}</span></div>`,
          )
          .join('')}</div>
      </section>`
    : '';

  view.innerHTML = tabHtml + walletHtml + creditHtml + ordersHtml;

  if (o.payer) {
    const b = await api('/api/ext/balance', { timeout: 25000 });
    const el = $('bal');
    if (!el) return;
    if (b.ok) {
      const top = b.data.top.filter((a) => a.usd >= 0.01).map((a) => a.symbol);
      el.innerHTML = `<b class="num">${money(b.data.payerUsd)}</b><small>${top.length ? esc([...new Set(top)].join(', ')) : 'Empty wallet'}</small>`;
    } else el.innerHTML = '<small>Balance unavailable</small>';
  }
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-retry]')) return load();
  const show = e.target.closest('[data-show]');
  if (show) {
    await chrome.tabs.sendMessage(Number(show.dataset.show), { type: 'spendly-open' }).catch(() => {});
    window.close();
  }
});

load();
