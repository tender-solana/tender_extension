// Tender — content script.
//  · On the Tender site: pairs the extension with the signed-in account.
//  · On a supported store's checkout: the Tender panel → plan → "Yes, pay" → the server pays the store
//    with credit from the store; every signature is approved in the user's own wallet (relayed to inpage.js) → applied.
(() => {
  if (window.__spendlyLoaded) return;
  window.__spendlyLoaded = true;
  const VERSION = '0.4.5';

  const host = location.hostname;
  // the Tender site's hosts; scripts/build-extension.ts swaps in the public host for the store build
  const SITE_HOSTS = ['paywithtender.vercel.app'];
  const isLocal = SITE_HOSTS.includes(host);
  const isTest = isLocal && /^(127\.0\.0\.1|localhost)$/.test(host) && location.pathname.startsWith('/test/');

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (msg) => chrome.runtime.sendMessage(msg);
  const api = (method, path, body) => send({ type: 'api', method, path, body });
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (v, cur) => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' }).format(v);
  const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

  // ================================================================ Tender site: pairing
  if (isLocal && !isTest) {
    const hello = async () => {
      const p = await send({ type: 'pairing' });
      window.postMessage({ source: 'spendly-ext', type: 'hello', version: VERSION, pairedUser: p?.paired ? p.userId : null }, location.origin);
    };
    document.documentElement.dataset.spendlyExtension = VERSION;
    window.addEventListener('message', async (e) => {
      if (e.source !== window || e.origin !== location.origin || e.data?.source !== 'spendly-site') return;
      if (e.data.type === 'ping') hello();
      if (e.data.type === 'pair' && typeof e.data.token === 'string' && e.data.server === location.origin) {
        await send({ type: 'pair', token: e.data.token, server: e.data.server, userId: e.data.userId, rdns: e.data.rdns });
        window.postMessage({ source: 'spendly-ext', type: 'paired', pairedUser: e.data.userId }, location.origin);
      }
    });
    hello();
    return;
  }

  // ================================================================ stores
  const brandOf = () => {
    if (isTest) return 'amazon';
    if (/(^|\.)amazon\./.test(host)) return 'amazon';
    if (/(^|\.)nike\.com$/.test(host)) return 'nike';
    if (/(^|\.)adidas\./.test(host)) return 'adidas';
    if (/(^|\.)zalando\./.test(host)) return 'zalando';
    if (/(^|\.)ikea\.com$/.test(host)) return 'ikea';
    if (/(^|\.)airbnb\./.test(host)) return 'airbnb';
    if (/(^|\.)apple\.com$/.test(host)) return 'apple';
    if (/(^|\.)sephora\./.test(host)) return 'sephora';
    return null;
  };
  const brand = brandOf();
  if (!brand) return;

  const CHECKOUT = {
    amazon: /\/(gp\/buy|checkout|gp\/checkoutportal)\b|\/test\/amazon-checkout/,
    nike: /\/checkout/,
    adidas: /\/(delivery|payment|checkout)\b/,
    zalando: /\/checkout/,
    ikea: /\/(checkout|order|ordercapture)\b|^\/[a-z]{2}\/[a-z]{2}\/(checkout|order)/,
    airbnb: /\/(book|payments\/book|checkout)\b/,
    apple: /\/shop\/checkout\b/,
    sephora: /\/(checkout|kasse|cassa|pago)\b/i,
  };
  const isCheckout = () => CHECKOUT[brand].test(location.pathname);
  // sephora.com serves the US and Canada; the country lives in its site_locale cookie, not always in the URL.
  // The server tells the two apart by a /ca prefix, so add it when the cookie says Canada.
  const storePath = () => {
    const p = location.pathname;
    if (brand === 'sephora' && /(^|;\s*)site_locale=ca(;|$)/i.test(document.cookie) && !/^\/ca(\/|$)/.test(p)) return `/ca${p}`;
    return p;
  };
  const isAmazonRedeem = () => brand === 'amazon' && /\/gc\/redeem|\/test\/amazon-redeem/.test(location.pathname);

  // ---------------------------------------------------------------- wallet bridge (→ inpage.js, page world)
  function walletRequest(req) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now();
      const timer = setTimeout(() => {
        removeEventListener('message', onMsg);
        reject(new Error('No answer from the wallet.'));
      }, 5 * 60_000);
      const onMsg = (e) => {
        if (e.source !== window || e.data?.source !== 'spendly-inpage' || e.data.id !== id) return;
        clearTimeout(timer);
        removeEventListener('message', onMsg);
        e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result);
      };
      addEventListener('message', onMsg);
      window.postMessage({ source: 'spendly-cs', type: 'wallet', id, req }, location.origin);
    });
  }

  // ---------------------------------------------------------------- prices & totals
  function parsePrice(text) {
    const m = String(text).replace(/[  ]/g, ' ').match(/\d{1,3}(?:[ .,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
    if (!m) return NaN;
    let s = m[0].replace(/ /g, '');
    const last = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    s = last >= 0 && s.length - last - 1 <= 2 ? s.slice(0, last).replace(/[.,]/g, '') + '.' + s.slice(last + 1) : s.replace(/[.,]/g, '');
    return Number(s);
  }
  const TOTAL_LABEL = /^(montant total|total de la commande|total commande|montant dû|order total|grand total|total \(ttc\)|total à payer|gesamtsumme|gesamtbetrag|total del pedido|importe total|totale ordine|totale|total|subtotal)\s*:?$/i;
  // label and amount in one string, e.g. Apple's "Voir le récapitulatif de la commande : 149,00 €"
  const SUMMARY_INLINE = /(récapitulatif de la commande|order summary|bag total|bestellübersicht|bestellzusammenfassung|resumen del pedido|riepilogo dell'ordine|overzicht van je bestelling|bestellingsoverzicht|order total|montant total|total)[^:\d]{0,25}:\s*([^:]*\d[^:]*)$/i;
  const CURRENCY = /[€$£]|\b(EUR|USD|GBP|CAD)\b/;
  function detectInlineTotal() {
    const els = [...document.querySelectorAll('button, a, h1, h2, h3, h4, p, span, div, [aria-label]')].filter((el) => el.children.length <= 4 && visible(el));
    for (const el of els) {
      for (const t of [textOf(el), el.getAttribute('aria-label') || '']) {
        if (!t || t.length > 140) continue;
        const m = t.match(SUMMARY_INLINE);
        if (m && CURRENCY.test(m[2])) {
          const v = parsePrice(m[2]);
          if (v > 0) return v;
        }
      }
    }
    return NaN;
  }
  function detectTotal() {
    const selectors = ['#subtotals-marketplace-table .grand-total-price', '.grand-total-price', '[data-testid="order-summary-grand-total"] .a-offscreen', '[data-attr="orderTotal"]', '[data-testid*="total" i] [data-testid*="price" i]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && visible(el)) {
        const v = parsePrice(textOf(el));
        if (v > 0) return v;
      }
    }
    const inline = detectInlineTotal();
    if (inline > 0) return inline;
    const labels = [...document.querySelectorAll('td, th, span, div, dt, p, h3, h4')].filter((el) => el.children.length <= 2 && visible(el) && TOTAL_LABEL.test(textOf(el)));
    for (const label of labels.reverse()) {
      const row = label.closest('tr, li, .a-row, [class*="row"], dl, div');
      const cands = row ? [...row.querySelectorAll('*')].filter((e) => e !== label && !e.children.length && /\d/.test(textOf(e))) : [];
      for (const c of cands.reverse()) {
        const v = parsePrice(textOf(c));
        if (v > 0) return v;
      }
    }
    return NaN;
  }

  // ---------------------------------------------------------------- applying codes
  const GC_TEXT = /(carte[s]? cadeau|chèque[s]?-cadeau|code promo|gift ?card|promotion(al)? code|gutschein|tarjeta regalo|buono regalo|codice promozionale|cadeaukaart|voucher|bon d'achat)/i;
  const APPLY_TEXT = /^(appliquer|apply|einlösen|anwenden|aplicar|applica|toepassen|valider|redeem|utiliser)$/i;
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const findInputs = () => [...document.querySelectorAll('input[type="text"], input[type="tel"], input:not([type])')].filter(visible);
  function findCodeInput() {
    const ins = findInputs();
    return (
      ins.find((i) => /claim|gcpromo|gift.?card|giftcard|voucher|promo|gutschein|cadeau/i.test(`${i.name} ${i.id} ${i.getAttribute('aria-label') || ''} ${i.placeholder || ''}`)) ||
      ins.find((i) => /code/i.test(`${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`) && GC_TEXT.test(textOf(i.closest('form, section, div') || document.body).slice(0, 500)))
    );
  }
  const findPinInput = () => findInputs().find((i) => /\bpin\b/i.test(`${i.name} ${i.id} ${i.getAttribute('aria-label') || ''} ${i.placeholder || ''}`));
  // a link that loads another page (e.g. Nike's footer "Cartes cadeaux" → gift card shop) must never be clicked
  const leavesPage = (e) => {
    if (e.tagName !== 'A') return false;
    const href = e.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return false;
    try {
      const u = new URL(href, location.href);
      return u.pathname !== location.pathname || u.origin !== location.origin;
    } catch {
      return true;
    }
  };
  function findExpander() {
    const els = [...document.querySelectorAll('a, button, span[role="button"], [role="button"], .a-expander-prompt, summary')].filter(
      (e) => visible(e) && GC_TEXT.test(textOf(e)) && textOf(e).length < 90 && !e.closest('footer, nav, header, [role="contentinfo"], [role="navigation"]') && !leavesPage(e),
    );
    return els.sort((a, b) => textOf(a).length - textOf(b).length)[0];
  }
  function findApplyButton(input) {
    let scope = input;
    for (let i = 0; i < 5 && scope; i++) {
      scope = scope.parentElement;
      if (!scope) break;
      const btn = [...scope.querySelectorAll('input[type="submit"], button, input[type="button"], span.a-button input')].find((b) => visible(b) && (APPLY_TEXT.test(textOf(b)) || /apply|claimcode/i.test(`${b.name} ${b.id}`)));
      if (btn) return btn;
    }
  }
  const visibleError = () => {
    const err = [...document.querySelectorAll('.a-alert-error, .a-color-error, [role="alert"], .error, [data-spendly-error]')].find((e) => visible(e) && textOf(e).length > 3);
    return err ? textOf(err).slice(0, 200) : '';
  };

  async function revealInput() {
    let input = findCodeInput();
    if (!input) {
      const ex = findExpander();
      if (ex) {
        ex.click();
        for (let i = 0; i < 10 && !input; i++) {
          await wait(400);
          input = findCodeInput();
        }
      }
    }
    return input;
  }

  // Amazon: fill + click Apply, verified on the live site; fallback = redeem page (adds to the account balance)
  async function applyAmazon(code) {
    const input = await revealInput();
    if (!input) return { ok: false, error: 'payment code field not found' };
    input.scrollIntoView({ block: 'center' });
    setNativeValue(input, code);
    const btn = findApplyButton(input);
    if (!btn) return { ok: false, error: 'Apply button not found' };
    const before = visibleError();
    btn.click();
    for (let i = 0; i < 20; i++) {
      await wait(500);
      const err = visibleError();
      if (err && err !== before) return { ok: false, error: err };
      if (!document.contains(input) || input.value === '') return { ok: true };
    }
    return { ok: true, uncertain: true };
  }
  const redeemUrl = (code) => (isTest ? `${location.origin}/test/amazon-redeem.html?claimCode=${encodeURIComponent(code)}#spendly` : `${location.origin}/gc/redeem?claimCode=${encodeURIComponent(code)}#spendly`);

  // Nike, Apple, Sephora: fill the code (and PIN), click the store's own Apply button and watch the result.
  // If the button can't be found, it degrades to the assisted flow (filled in, the user clicks).
  const AUTO_BRANDS = new Set(['nike', 'apple', 'sephora']);
  async function applyAuto(card) {
    let input = await revealInput();
    // Apple names the gift card code field "PIN"
    if (!input && brand === 'apple') input = findPinInput();
    if (!input) return applyAssisted(card);
    input.scrollIntoView({ block: 'center' });
    setNativeValue(input, card.code || '');
    const pin = findPinInput();
    if (pin && pin !== input && card.pin) setNativeValue(pin, card.pin);
    const btn = findApplyButton(input);
    if (!btn) return { ok: true, uncertain: true, note: 'filled in, click "Apply" on the page' };
    const before = visibleError();
    btn.click();
    for (let i = 0; i < 20; i++) {
      await wait(500);
      const err = visibleError();
      if (err && err !== before) return { ok: false, error: err };
      if (!document.contains(input) || input.value === '') return { ok: true };
    }
    return { ok: true, uncertain: true, note: 'check that the payment shows on the order' };
  }

  // Other stores: fill the code (and PIN) — the user clicks the store's own Apply button
  async function applyAssisted(card) {
    const input = await revealInput();
    if (!input) return { ok: false, error: 'open the gift card / voucher section of the payment page, then click "Fill in again"' };
    input.scrollIntoView({ block: 'center' });
    setNativeValue(input, card.code || '');
    const pin = findPinInput();
    if (pin && card.pin) setNativeValue(pin, card.pin);
    return { ok: true, uncertain: true, note: 'filled in, click "Apply" on the page' };
  }

  async function handleRedeemPage() {
    if (!location.hash.includes('spendly')) return;
    const code = new URLSearchParams(location.search).get('claimCode');
    let input;
    for (let i = 0; i < 20 && !input; i++) {
      input = document.querySelector('#gc-redemption-input, input[name="claimCode"], input[name="ppw-claimCode"]');
      if (!input) await wait(500);
    }
    if (!input) return;
    if (code && !input.value) setNativeValue(input, code);
    const btn =
      ['#gc-redemption-apply-button input', 'input[name="applyToBalance"]', '#gc-redemption-apply-button button', '#gc-redemption-apply-button'].map((s) => document.querySelector(s)).find((e) => e && visible(e)) ||
      [...document.querySelectorAll('input[type="submit"], button, span.a-button input')].find((b) => /(ajouter à (mon|votre) solde|apply to (your )?balance|appliquer|einlösen|aplicar|applica)/i.test(textOf(b)));
    if (!btn) return;
    btn.click();
    await wait(2500);
    const t = document.createElement('div');
    t.className = 'spendly-toast';
    const err = visibleError();
    t.textContent = err ? `Tender: ${err}` : 'Tender: added to your account balance. You can close this tab and reload the payment page.';
    document.body.appendChild(t);
  }

  // ================================================================ panel
  let panel; // the card at the bottom right
  let launcher; // the small pill it folds into
  let busy = false;
  let paid = false; // this page's order was paid
  let store = null; // from the server: label, brandId, apply, currency

  const curSymbol = (cur) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? '';
  const head = () =>
    `<div class="sp-head"><span class="sp-name">tender<b>.</b></span>${store ? `<span class="sp-store">${esc(store.label)}</span>` : ''}<button class="sp-min" title="Minimise" aria-label="Minimise"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>`;

  function mount() {
    if (panel && document.contains(panel)) return;
    panel = document.createElement('div');
    panel.id = 'spendly-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Tender');
    document.body.appendChild(panel);
    renderStart();
  }
  function minimise() {
    if (!panel) return;
    panel.hidden = true;
    if (!launcher || !document.contains(launcher)) {
      launcher = document.createElement('div');
      launcher.id = 'spendly-launcher';
      launcher.innerHTML = '<button class="sp-open"><span class="sp-dot"></span><span data-l></span></button><button class="sp-off" title="Hide on this page" aria-label="Hide on this page">×</button>';
      launcher.querySelector('.sp-open').onclick = open;
      launcher.querySelector('.sp-off').onclick = () => launcher.remove();
      document.body.appendChild(launcher);
    }
    launcher.hidden = false;
    launcher.querySelector('[data-l]').textContent = busy ? 'Paying… open Tender' : paid ? 'Paid with Tender' : 'Pay with Tender';
  }
  function open() {
    if (launcher) launcher.hidden = true;
    if (panel && document.contains(panel)) panel.hidden = false;
    else mount();
  }
  function frame(body) {
    panel.innerHTML = head() + `<div class="sp-body">${body}</div>`;
    panel.querySelector('.sp-min').onclick = minimise;
  }
  const errorText = (r) =>
    r.error === 'NOT_PAIRED'
      ? "The extension isn't linked yet: open your Tender dashboard and connect your wallet, it links itself."
      : r.error === 'SERVER_DOWN'
        ? "Couldn't reach Tender: check your connection, then try again."
        : r.error;

  // ---------------------------------------------------------------- start
  function renderStart(message) {
    const total = detectTotal();
    const found = Number.isFinite(total);
    frame(`
      <p class="sp-title">Pay this order with your wallet</p>
      <label class="sp-amount"><span>${esc(curSymbol(store?.currency))}</span><input id="sp-total" inputmode="decimal" autocomplete="off" value="${found ? total.toFixed(2) : ''}" placeholder="0.00" aria-label="Order total" /></label>
      <p class="sp-hint">${found ? 'Order total, read from this page. You can change it.' : "Couldn't read the order total: type it in."}</p>
      ${message ? `<div class="sp-msg">${message}</div>` : ''}
      <button class="sp-btn" data-plan>Pay with my wallet</button>
      <button class="sp-link" data-have>Use a code I already have</button>`);
    const input = panel.querySelector('#sp-total');
    input.addEventListener('keydown', (e) => e.key === 'Enter' && onPlan());
    panel.querySelector('[data-plan]').onclick = onPlan;
    panel.querySelector('[data-have]').onclick = renderHaveCode;
    // some checkouts (Apple) render the order summary after the panel opens: keep looking for ~10 s,
    // unless the user starts typing
    if (!found) {
      let typed = false;
      input.addEventListener('input', () => (typed = true), { once: true });
      let tries = 0;
      const retry = setInterval(() => {
        if (typed || !document.contains(input) || ++tries > 20) return clearInterval(retry);
        const t = detectTotal();
        if (!Number.isFinite(t)) return;
        clearInterval(retry);
        input.value = t.toFixed(2);
        panel.querySelector('.sp-hint').textContent = 'Order total, read from this page. You can change it.';
      }, 500);
    }
  }

  function renderHaveCode() {
    frame(`
      <p class="sp-title">Use a code you already have</p>
      <input id="sp-code" class="sp-input" autocomplete="off" placeholder="XXXX-XXXXXX-XXXX" aria-label="Code" />
      ${brand !== 'amazon' ? '<input id="sp-pin" class="sp-input" autocomplete="off" placeholder="PIN (if any)" aria-label="PIN" />' : ''}
      <div class="sp-actions"><button class="sp-btn sp-ghost" data-back>Back</button><button class="sp-btn" data-apply>Apply</button></div>`);
    panel.querySelector('[data-back]').onclick = () => renderStart();
    panel.querySelector('[data-apply]').onclick = () => {
      const code = panel.querySelector('#sp-code').value.trim();
      if (code) applyAll([{ code, pin: panel.querySelector('#sp-pin')?.value.trim() }]);
    };
  }

  let lastTotal = 0;
  async function onPlan(payWith) {
    const total = typeof payWith === 'string' ? lastTotal : parsePrice(panel.querySelector('#sp-total').value);
    if (!(total > 0)) return renderStart('<span class="sp-bad">Type the order total first.</span>');
    lastTotal = total;
    frame('<p class="sp-title">Checking the best price…</p><p class="sp-sub">Live price for this store, discounts included.</p><span class="sp-bar"><i></i></span>');
    const r = await api('POST', '/api/ext/plan', { host, path: storePath(), total, payWith: typeof payWith === 'string' ? payWith : undefined });
    if (!r.ok) return renderStart(`<span class="sp-bad">${esc(errorText(r))}</span>`);
    renderConfirm(r.data);
  }

  // ---------------------------------------------------------------- confirm
  // Live price vs face value: shows the discount when there is one, or the store fee (never hidden)
  function priceLine(plan) {
    const p = plan.pricing;
    if (!p) return '';
    if (p.deltaPct <= -0.5) return `<div class="sp-line sp-save"><span>Discount found</span><b>−${Math.abs(p.deltaPct).toFixed(1)}%, you save $${Math.abs(p.deltaUsd).toFixed(2)}</b></div>`;
    if (p.deltaPct >= 0.5) return `<div class="sp-line sp-dim"><span>Includes store fee</span><span>+${p.deltaPct.toFixed(1)}%</span></div>`;
    return '<div class="sp-line sp-dim"><span>Price checked</span><span>no fee, no markup</span></div>';
  }

  // amounts in a coin: stablecoins to the cent, ETH / SOL with enough digits to mean something
  const coinAmount = (v, coin) => (coin === 'USDC' || coin === 'USDT' ? v.toFixed(2) : v < 1 ? v.toPrecision(3) : v.toFixed(3));

  function renderConfirm(plan) {
    const cur = plan.store.currency;
    const chosen = plan.payOptions?.find((o) => o.coin === plan.payWith);
    const lines = [];
    if (plan.creditUsed > 0) lines.push(`<div class="sp-line"><span>Credit on your ${esc(plan.store.brandName)} account</span><b>−${money(plan.creditUsed, cur)}</b></div>`);
    plan.reuse.forEach((r) => lines.push(`<div class="sp-line"><span>Earlier store credit</span><b>−${money(r.use, cur)}</b></div>`));
    if (plan.buy.length) lines.push(`<div class="sp-line"><span>Paid with your wallet</span><b>${money(plan.buyFace, cur)}</b></div>`);
    if (plan.leftover > 0) lines.push(`<div class="sp-line sp-dim"><span>Kept for your next order</span><span>${money(plan.leftover, cur)}</span></div>`);
    const f = plan.funding;
    const how = !plan.buy.length
      ? 'Nothing to pay: your credit covers this order.'
      : f?.mode === 'convert'
        ? f.source.vm === 'svm'
          ? `Your ${esc(f.source.symbol)} on Solana is converted to the exact amount (${esc(f.source.walletName)} confirms), then paid from ${esc(plan.payer?.name ?? 'your wallet')}.`
          : `Your ${esc(f.source.symbol)} on ${esc(f.source.chain)} is converted to the exact amount, then paid. Your wallet asks you to confirm each step.`
        : f
          ? `Paid in USDC on ${esc(f.network.label)}, no network fee. Your wallet asks for 1 or 2 signatures.`
          : '';
    frame(`
      ${plan.mock ? '<div class="sp-sim">Simulation: no real payment</div>' : ''}
      <div class="sp-big">${money(plan.total, cur)}</div>
      <div class="sp-lines">${lines.join('')}</div>
      ${
        plan.buy.length && plan.payOptions?.length
          ? `<div class="sp-label">Pay with</div><div class="sp-coins" role="radiogroup" aria-label="Pay with">${plan.payOptions
              .map(
                (o) =>
                  `<button class="sp-coin${o.coin === plan.payWith ? ' on' : ''}" role="radio" aria-checked="${o.coin === plan.payWith}" data-coin="${o.coin}" ${o.available ? '' : 'disabled'} title="${esc(o.reason || '')}"><b>${o.coin}</b><small>${o.available ? esc(o.estimate?.chain ?? '') : 'Not enough'}</small></button>`,
              )
              .join('')}</div>`
          : ''
      }
      ${plan.buy.length ? `<div class="sp-line sp-cost"><span>You pay</span><b>≈ ${chosen?.estimate ? `${coinAmount(chosen.estimate.amount, chosen.coin)} ${chosen.coin}` : `${plan.estimatedUsdc.toFixed(2)} USDC`}</b></div>${priceLine(plan)}${plan.spendlyFee ? `<div class="sp-line sp-dim"><span>Tender fee (${plan.spendlyFee.pct}%)</span><span>${money(plan.spendlyFee.usd, 'USD')}</span></div>` : ''}` : ''}
      ${plan.payer && plan.buy.length ? `<div class="sp-line sp-dim"><span>From</span><span>${esc(plan.payer.name)} · ${esc(short(plan.payer.address))}</span></div>` : ''}
      ${how ? `<p class="sp-note">${how}</p>` : ''}
      ${plan.canPay ? '' : `<div class="sp-msg sp-bad">${plan.reasons.map(esc).join('<br>')}</div>`}
      <div class="sp-actions">
        <button class="sp-btn sp-ghost" data-cancel>Back</button>
        <button class="sp-btn" data-yes ${plan.canPay ? '' : 'disabled'}>${plan.buy.length ? 'Yes, pay' : 'Use my credit'}</button>
      </div>`);
    panel.querySelector('[data-cancel]').onclick = () => renderStart();
    panel.querySelector('[data-yes]').onclick = () => onPay(plan);
    panel.querySelectorAll('[data-coin]').forEach((b) => (b.onclick = () => b.dataset.coin !== plan.payWith && onPlan(b.dataset.coin)));
  }

  // ---------------------------------------------------------------- paying: a step list driven by the server's log
  function stepsFor(plan) {
    const steps = [{ k: 'lock', label: 'Price locked' }];
    if (plan.funding?.mode === 'convert') steps.push({ k: 'convert', label: `${plan.funding.source.symbol} converted to USDC` });
    steps.push({ k: 'pay', label: 'Payment sent' }, { k: 'deliver', label: 'Received by the store' }, { k: 'apply', label: 'Applied to your order' });
    return steps;
  }
  function reached(job) {
    const has = (tag, re) => job.logs.some((l) => l.tag === tag && (!re || re.test(l.msg)));
    const r = { lock: has('order', /price locked|SIMULATION/), pay: has('pay'), deliver: has('deliver') || job.state === 'done' };
    r.convert = r.pay || has('convert', /USDC received|arrived/i);
    r.lock = r.lock || r.convert;
    return r;
  }
  function paintSteps(list, done) {
    let activeSet = false;
    list.querySelectorAll('li').forEach((li) => {
      const isDone = !!done[li.dataset.k];
      li.className = isDone ? 'on' : !activeSet ? ((activeSet = true), 'now') : '';
    });
  }

  async function onPay(plan) {
    if (busy) return;
    busy = true;
    const steps = stepsFor(plan);
    frame(`
      <p class="sp-title">Paying…</p>
      <p class="sp-sub">Keep this tab open. You can minimise this window.</p>
      <ol class="sp-steps">${steps.map((s) => `<li data-k="${s.k}">${esc(s.label)}</li>`).join('')}</ol>
      <div class="sp-wallet" hidden></div>
      <details class="sp-details"><summary>Details</summary><div class="sp-log"></div></details>`);
    const list = panel.querySelector('.sp-steps');
    const logEl = panel.querySelector('.sp-log');
    const walletEl = panel.querySelector('.sp-wallet');
    paintSteps(list, {});
    const r = await api('POST', '/api/ext/checkout', { host, path: storePath(), total: plan.total, expectedUsdc: plan.estimatedUsdc, payWith: plan.payWith });
    if (!r.ok) {
      busy = false;
      return renderStart(`<span class="sp-bad">${esc(errorText(r))}</span>`);
    }
    const jobId = r.data.jobId;
    let shown = 0;
    let handled = null;
    for (;;) {
      const s = await api('GET', `/api/ext/checkout/${jobId}`);
      if (s.ok) {
        const job = s.data;
        for (const l of job.logs.slice(shown)) {
          const line = document.createElement('div');
          line.className = `sp-l sp-${l.level}`;
          line.textContent = l.msg;
          logEl.appendChild(line);
        }
        shown = job.logs.length;
        logEl.scrollTop = logEl.scrollHeight;
        paintSteps(list, reached(job));

        // a signature / transaction to approve in the user's wallet
        if (job.pending && job.pending.id !== handled) {
          handled = job.pending.id;
          const req = job.pending;
          if (panel.hidden) open();
          walletEl.hidden = false;
          walletEl.innerHTML = `<b>Confirm in your wallet</b><span>${esc(req.label)}</span>`;
          walletRequest(req)
            .then((result) => api('POST', `/api/ext/checkout/${jobId}/answer`, { requestId: req.id, result }))
            .catch((e) => api('POST', `/api/ext/checkout/${jobId}/answer`, { requestId: req.id, error: e.message }))
            .finally(() => (walletEl.hidden = true));
        }
        if (job.state === 'error') {
          busy = false;
          if (panel.hidden) open();
          return renderDone([], { ok: false, title: 'Payment stopped', text: `${esc(job.error)}<br><span class="sp-dim">Nothing leaves your wallet without your approval. If a payment had already gone through, the credit is kept in your Tender dashboard.</span>` });
        }
        if (job.state === 'done') {
          busy = false;
          const codes = job.result.codes.filter((c) => c.code || c.link);
          if (codes.length) send({ type: 'saveCodes', host, codes });
          if (!codes.length) return renderDone([], { ok: true, title: 'Done', text: 'Your credit covers this order: check the total, then place your order.' });
          return applyAll(codes, list);
        }
      }
      await wait(1200);
    }
  }

  async function applyAll(codes, list) {
    if (list) {
      paintSteps(list, { lock: 1, convert: 1, pay: 1, deliver: 1 });
      panel.querySelector('.sp-title').textContent = 'Applying it to your order…';
    } else frame('<p class="sp-title">Applying it to your order…</p><span class="sp-bar"><i></i></span>');
    const results = [];
    for (const c of codes) {
      let res;
      if (brand === 'amazon') {
        res = await applyAmazon(c.code);
        if (!res.ok) {
          await send({ type: 'openTab', url: redeemUrl(c.code), active: false });
          res = { ok: true, uncertain: true, note: 'added to your Amazon balance in a new tab: reload this page' };
        }
      } else res = AUTO_BRANDS.has(brand) ? await applyAuto(c) : await applyAssisted(c);
      results.push({ code: c.code, ...res });
    }
    const allOk = results.every((r) => r.ok && !r.uncertain);
    const notes = results.map((r) => (r.ok ? (r.uncertain ? esc(r.note || 'check the page') : 'Applied to your order.') : esc(r.error))).filter((v, i, a) => a.indexOf(v) === i);
    if (panel.hidden) open();
    renderDone(codes, allOk ? { ok: true, title: 'Paid', text: 'Check the total, then place your order.' } : { ok: true, title: 'Paid, one last step', text: notes.join('<br>') }, !allOk);
  }

  function renderDone(codes, { ok, title, text }, showCodes = false) {
    if (ok) paid = true;
    const icon = ok
      ? '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M6.5 12.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 7v6M12 16.5v.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    frame(`
      <div class="sp-result ${ok ? 'sp-ok' : 'sp-err'}"><span class="sp-badge">${icon}</span><div><p class="sp-title">${esc(title)}</p><p class="sp-sub">${text}</p></div></div>
      ${
        codes.length
          ? `<details class="sp-details" ${showCodes ? 'open' : ''}><summary>Payment codes</summary><div class="sp-codes">${codes
              .map((c) => `<div class="sp-code"><code>${esc(c.code || c.link || '')}</code>${c.pin ? `<span class="sp-dim">PIN ${esc(c.pin)}</span>` : ''}<button class="sp-copy" data-v="${esc(c.code || c.link || '')}">Copy</button></div>`)
              .join('')}</div><p class="sp-dim">Also saved in your Tender dashboard.</p></details>`
          : ''
      }
      ${brand !== 'amazon' && codes.length ? '<button class="sp-btn sp-ghost" data-refill>Fill in again</button>' : ''}
      <button class="sp-btn ${ok ? '' : 'sp-ghost'}" data-close>${ok ? 'Done' : 'Back'}</button>`);
    panel.querySelectorAll('.sp-copy').forEach(
      (b) =>
        (b.onclick = async () => {
          await navigator.clipboard.writeText(b.dataset.v);
          b.textContent = 'Copied';
        }),
    );
    panel.querySelector('[data-refill]')?.addEventListener('click', () => applyAll(codes));
    panel.querySelector('[data-close]').onclick = () => (ok ? minimise() : renderStart());
  }

  // ================================================================ boot
  // the toolbar popup asks what's going on in this tab
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'spendly-state') sendResponse({ store, checkout: isCheckout() && !!store, panelOpen: !!(panel && document.contains(panel) && !panel.hidden) });
    if (msg?.type === 'spendly-open') {
      open();
      sendResponse({ ok: true });
    }
  });

  if (isAmazonRedeem()) {
    handleRedeemPage();
    return;
  }
  const check = async () => {
    if (busy || !isCheckout() || (panel && document.contains(panel))) return;
    const r = await api('POST', '/api/ext/match', { host, path: storePath() });
    if (r.ok && !r.data.store) return; // not a supported country of this brand
    store = r.ok ? r.data.store : null;
    mount();
    if (!r.ok) renderStart(`<span class="sp-bad">${esc(errorText(r))}</span>`);
  };
  check();
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      check();
    }
  }, 1000);
})();
