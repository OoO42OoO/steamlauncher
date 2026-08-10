import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init as initI18n, resolveLocale } from './i18n';
import './index.css';

async function bootstrap(): Promise<void> {
  // Ask main for the OS locale + the user's saved override before mounting
  // React, so the very first paint is in the right language. If anything
  // goes wrong we fall back to English — the catch is intentional and
  // never reachable on a healthy IPC bridge.
  let osLocale = 'en';
  let override = 'auto';
  try {
    const env = await window.api.i18n.getEnv();
    osLocale = env.osLocale || 'en';
    override = env.language || 'auto';
  } catch {
    /* fall through to defaults */
  }
  const resolved = resolveLocale(osLocale, override);
  await initI18n(resolved);

  const container = document.getElementById('root');
  if (!container) throw new Error('root element missing');
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
