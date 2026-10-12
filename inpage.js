// Tender — runs in the PAGE's world (not the extension's) because that's where the user's wallet
// (MetaMask, Rabby, Coinbase…) lives. It only answers requests from Tender's content script and asks
// the wallet; the user approves every signature or transaction in their wallet's own window.
(() => {
  if (window.__spendlyInpage) return;
  window.__spendlyInpage = true;

  const providers = new Map(); // rdns -> provider
  window.addEventListener('eip6963:announceProvider', (e) => providers.set(e.detail.info.rdns, e.detail.provider));
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  const pick = (rdns) => (rdns && providers.get(rdns)) || window.ethereum || providers.values().next().value;
  const hex = (n) => '0x' + Number(n).toString(16);
  const utf8Hex = (s) => '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // Networks a conversion may need (added to the wallet if missing)
  const CHAINS = {
    1: { chainId: '0x1', chainName: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://ethereum-rpc.publicnode.com'], blockExplorerUrls: ['https://etherscan.io'] },
    8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
    42161: { chainId: '0xa4b1', chainName: 'Arbitrum One', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://arb1.arbitrum.io/rpc'], blockExplorerUrls: ['https://arbiscan.io'] },
    137: { chainId: '0x89', chainName: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: ['https://polygon-rpc.com'], blockExplorerUrls: ['https://polygonscan.com'] },
    4663: { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: ['https://robinhoodchain.blockscout.com'] },
  };

  async function ensureAccount(p, address) {
    const accounts = (await p.request({ method: 'eth_requestAccounts' })).map((a) => a.toLowerCase());
    if (!accounts.includes(address.toLowerCase())) throw new Error(`Select the account ${short(address)} in your wallet, then try again.`);
  }

  async function ensureChain(p, chainId) {
    if (!chainId) return;
    const current = parseInt(await p.request({ method: 'eth_chainId' }), 16);
    if (current === chainId) return;
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(chainId) }] });
    } catch (e) {
      if ((e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message)) && CHAINS[chainId]) {
        await p.request({ method: 'wallet_addEthereumChain', params: [CHAINS[chainId]] });
      } else throw e;
    }
  }

  // eth_signTypedData_v4 wants EIP712Domain listed in the types
  function withDomainType(td) {
    const order = [
      ['name', 'string'],
      ['version', 'string'],
      ['chainId', 'uint256'],
      ['verifyingContract', 'address'],
      ['salt', 'bytes32'],
    ];
    const domainType = order.filter(([k]) => td.domain[k] !== undefined).map(([name, type]) => ({ name, type }));
    return { ...td, types: { EIP712Domain: domainType, ...td.types } };
  }

  // ---- Solana wallets (Phantom, Solflare, Backpack…) through the Wallet Standard
  const stdWallets = new Set();
  const api = { register: (...ws) => (ws.forEach((w) => stdWallets.add(w)), () => ws.forEach((w) => stdWallets.delete(w))) };
  window.addEventListener('wallet-standard:register-wallet', (e) => {
    try {
      e.detail(api);
    } catch {
      /* a wallet that doesn't follow the standard */
    }
  });
  try {
    window.dispatchEvent(Object.assign(new Event('wallet-standard:app-ready'), { detail: api }));
  } catch {
    /* ignore */
  }

  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58(bytes) {
    let n = 0n;
    for (const b of bytes) n = n * 256n + BigInt(b);
    let out = '';
    while (n > 0n) {
      out = B58[Number(n % 58n)] + out;
      n /= 58n;
    }
    for (const b of bytes) {
      if (b !== 0) break;
      out = '1' + out;
    }
    return out;
  }
  const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function solanaSend(req) {
    const able = [...stdWallets].filter((w) => w.features?.['solana:signAndSendTransaction'] && w.features?.['standard:connect']);
    if (!able.length) throw new Error('No Solana wallet found on this page. Install Phantom (or your Solana wallet), then reload.');
    // the wallet the funds are in first (by name), then any other
    const sorted = [...able.filter((w) => req.walletName && w.name.toLowerCase().includes(req.walletName.toLowerCase())), ...able];
    for (const w of sorted) {
      let account = w.accounts.find((a) => a.address === req.address);
      if (!account) {
        const { accounts } = await w.features['standard:connect'].connect();
        account = (accounts ?? w.accounts).find((a) => a.address === req.address);
      }
      if (!account) continue;
      const [out] = await w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, transaction: fromBase64(req.solanaTx), chain: 'solana:mainnet' });
      return base58(out.signature);
    }
    throw new Error(`Select the Solana account ${short(req.address)} in your wallet, then try again.`);
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || ev.data?.source !== 'spendly-cs' || ev.data.type !== 'wallet') return;
    const { id, req } = ev.data;
    const reply = (msg) => window.postMessage({ source: 'spendly-inpage', id, ...msg }, location.origin);
    try {
      if (req.kind === 'solana_tx') return reply({ result: await solanaSend(req) });
      const p = pick(req.rdns);
      if (!p) throw new Error('No wallet found on this page. Install MetaMask (or your wallet), then reload.');
      await ensureAccount(p, req.address);
      let result;
      if (req.kind === 'personal_sign') {
        result = await p.request({ method: 'personal_sign', params: [utf8Hex(req.message), req.address] });
      } else if (req.kind === 'typed_data') {
        await ensureChain(p, req.chainId);
        result = await p.request({ method: 'eth_signTypedData_v4', params: [req.address, JSON.stringify(withDomainType(req.typedData))] });
      } else if (req.kind === 'send_tx') {
        await ensureChain(p, req.chainId);
        result = await p.request({ method: 'eth_sendTransaction', params: [{ from: req.address, to: req.tx.to, data: req.tx.data, value: req.tx.value }] });
      } else throw new Error(`Unknown request: ${req.kind}`);
      reply({ result });
    } catch (e) {
      reply({ error: e?.code === 4001 ? 'declined in the wallet' : e?.message || String(e) });
    }
  });
})();
