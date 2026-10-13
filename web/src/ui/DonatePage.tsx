// Donations: plain links and QR codes only (made at build time). No payment widget or
// third-party script runs here, so this page is as private as the rest of the app.

import { useState } from 'react';
import donate from 'virtual:donate';

export function DonatePage() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };
  const none = !donate.links.length && !donate.coins.length;
  return (
    <main className="page prose donate">
      <h1>Support stoned-mango</h1>
      <p className="lead">stoned-mango is free and open source, with no ads and no tracking. If it helps you, a donation keeps it
        going.</p>
      {none && <section><p>Donation links are coming soon.</p></section>}
      {donate.links.length > 0 && (
        <section>
          <h2>Send a donation</h2>
          <ul className="donate-links">
            {donate.links.map((l) => (
              <li key={l.id}>
                <a className="button-link" href={l.url} rel="noopener noreferrer" target="_blank">{l.name}</a>
                {l.note && <span className="muted small">{l.note}</span>}
              </li>
            ))}
          </ul>
          <p className="muted small">These open the payment site in a new tab; nothing from this app is sent with them.</p>
        </section>
      )}
      {donate.coins.length > 0 && (
        <section>
          <h2>Crypto</h2>
          <div className="coins">
            {donate.coins.map((c) => (
              <div className="coin" key={c.id}>
                <img src={c.qr} alt={`QR code for the ${c.name} address`} width={160} height={160} />
                <div>
                  <h3>{c.name}</h3>
                  <code className="address">{c.address}</code>
                  <button onClick={() => void copy(c.id, c.address)}>{copied === c.id ? 'Copied ✓' : 'Copy address'}</button>
                  {c.note && <p className="muted small">{c.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
