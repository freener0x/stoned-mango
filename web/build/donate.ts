// The Donate page's data, made at build time from web/donate.json: plain links, and QR
// codes for the crypto addresses as static images (data: URIs). No payment widget or
// third-party script ever runs on the site.

import QRCode from 'qrcode';

export interface DonateConfig {
  cashApp?: string;
  paypal?: string;
  checkout?: string;
  githubSponsors?: string;
  liberapay?: string;
  crypto?: Partial<Record<'BTC' | 'ETH' | 'SOL' | 'XMR', string>>;
  ethNetwork?: string;
}

export interface DonateLink {
  id: string;
  name: string;
  url: string;
  note?: string;
}

export interface DonateCoin {
  id: string;
  name: string;
  address: string;
  qr: string; // data:image/svg+xml URI
  note?: string;
}

const COINS: Record<string, { name: string; scheme: string; note?: (c: DonateConfig) => string }> = {
  BTC: { name: 'Bitcoin (BTC)', scheme: 'bitcoin' },
  ETH: { name: 'Ethereum (ETH)', scheme: 'ethereum', note: (c) => `Network: ${c.ethNetwork || 'Ethereum mainnet'} only. Sending on another network can lose the money.` },
  SOL: { name: 'Solana (SOL)', scheme: 'solana' },
  XMR: { name: 'Monero (XMR)', scheme: 'monero', note: () => 'Private by design: your donation stays private too.' },
};

const clean = (s?: string) => (s ?? '').trim();

export async function donateData(c: DonateConfig): Promise<{ links: DonateLink[]; coins: DonateCoin[] }> {
  const links: DonateLink[] = [];
  const cash = clean(c.cashApp).replace(/^\$/, '');
  if (cash) links.push({ id: 'cashapp', name: 'Cash App', url: `https://cash.app/$${encodeURIComponent(cash)}` });
  const paypal = clean(c.paypal);
  if (paypal) links.push({ id: 'paypal', name: 'PayPal', url: `https://paypal.me/${encodeURIComponent(paypal)}` });
  const checkout = clean(c.checkout);
  if (checkout) {
    if (!/^https:\/\//.test(checkout)) throw new Error('donate.json: "checkout" must be an https:// link');
    links.push({ id: 'checkout', name: 'Card or Apple Pay', url: checkout, note: 'A secure checkout page (cards, Apple Pay, Google Pay).' });
  }
  const sponsors = clean(c.githubSponsors);
  if (sponsors) links.push({ id: 'github', name: 'GitHub Sponsors', url: `https://github.com/sponsors/${encodeURIComponent(sponsors)}` });
  const libera = clean(c.liberapay);
  if (libera) links.push({ id: 'liberapay', name: 'Liberapay', url: `https://liberapay.com/${encodeURIComponent(libera)}` });
  const coins: DonateCoin[] = [];
  for (const [id, coin] of Object.entries(COINS)) {
    const address = clean(c.crypto?.[id as keyof NonNullable<DonateConfig['crypto']>]);
    if (!address) continue;
    if (!/^[A-Za-z0-9:]{20,120}$/.test(address)) throw new Error(`donate.json: the ${id} address doesn't look right`);
    const svg = await QRCode.toString(`${coin.scheme}:${address}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    coins.push({ id, name: coin.name, address, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, note: coin.note?.(c) });
  }
  return { links, coins };
}

/** Source of the virtual:donate module. */
export async function donateModule(c: DonateConfig): Promise<string> {
  return `export default ${JSON.stringify(await donateData(c))};\n`;
}
