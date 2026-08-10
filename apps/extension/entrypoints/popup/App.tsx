import { useEffect, useState } from 'react';
import { openBalanceWebSocket, ping } from '../../lib/client';
import { tExt } from '../../lib/i18n';

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface LastSite {
  domain: string;
  at: number;
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 60) return tExt('popup.relative.seconds', { n: delta });
  if (delta < 3600) return tExt('popup.relative.minutes', { n: Math.floor(delta / 60) });
  if (delta < 86400) return tExt('popup.relative.hours', { n: Math.floor(delta / 3600) });
  return tExt('popup.relative.days', { n: Math.floor(delta / 86400) });
}

export function App() {
  const [balance, setBalance] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastSite, setLastSite] = useState<LastSite | null>(null);

  useEffect(() => {
    void ping().then((ok) => setConnected(ok));

    const closeWs = openBalanceWebSocket(
      (seconds) => setBalance(seconds),
      (ok) => setConnected(ok)
    );

    void chrome.storage.local.get('last_site').then((s) => {
      const r = s.last_site as LastSite | undefined;
      if (r) setLastSite(r);
    });

    const storageListener = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area !== 'local') return;
      if (changes.last_site) {
        setLastSite(changes.last_site.newValue as LastSite);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);

    return () => {
      closeWs();
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, []);

  return (
    <div className="popup">
      <div className="header">
        <span className="title">Steam Bridge</span>
        <span className={`dot ${connected ? 'on' : 'off'}`} />
      </div>
      <div className="balance">
        {balance === null ? '—' : formatTime(balance)}
      </div>
      <div className="label">{tExt('popup.balance_label')}</div>

      {lastSite && (
        <div className="reward">
          <div className="reward-top">{lastSite.domain}</div>
          <div className="reward-bottom">
            {tExt('popup.activity')} · {relativeTime(lastSite.at)}
          </div>
        </div>
      )}

      <div className="hint">{tExt('popup.hint')}</div>

      {!connected && <div className="offline">{tExt('popup.offline')}</div>}
    </div>
  );
}
