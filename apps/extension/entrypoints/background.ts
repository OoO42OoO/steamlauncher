import { reportSiteTime } from '../lib/client';

/**
 * Site-time heartbeat.
 *
 * Every HEARTBEAT_SEC seconds, if the window is focused and there is an
 * active http(s) tab, report "+HEARTBEAT_SEC on <domain>" to the desktop
 * client. Desktop aggregates locally and periodically upserts into the API
 * POST /metrics/sites.
 *
 * Intentionally coarse — MVP accuracy. Does NOT require any host permission
 * beyond activeTab, which triggers only in response to extension events.
 */
const HEARTBEAT_SEC = 30;
const LAST_SITE_KEY = 'last_site';

type LastSite = { domain: string; at: number };

function hostnameFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname || null;
  } catch {
    return null;
  }
}

async function getActiveDomain(): Promise<string | null> {
  // If the last focused window is the currently-focused one, use it.
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (!win.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return hostnameFromUrl(tab?.url);
  } catch {
    return null;
  }
}

async function heartbeat(): Promise<void> {
  const domain = await getActiveDomain();
  if (!domain) return;
  const ok = await reportSiteTime({ domain, seconds: HEARTBEAT_SEC });
  if (ok) {
    await chrome.storage.local.set({
      [LAST_SITE_KEY]: { domain, at: Date.now() } satisfies LastSite,
    });
  }
}

export default defineBackground(() => {
  console.log('[bridge] background starting, site-time heartbeat every', HEARTBEAT_SEC, 's');
  // Use chrome.alarms for reliable background ticks in MV3 service workers.
  chrome.alarms.create('site-heartbeat', {
    periodInMinutes: HEARTBEAT_SEC / 60,
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'site-heartbeat') void heartbeat();
  });
});
