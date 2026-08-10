import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  // Default is .output (hidden in most file managers).
  // Use a non-dot folder so the user can browse to it for "Load unpacked".
  outDir: 'releases',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Steam Client Bridge',
    description: 'Tracks task completion and site time for the Steam Client.',
    // activeTab: extension only reads the URL of the tab the user interacts
    // with, not every page. <all_urls> was removed per security audit.
    // nativeMessaging: required for chrome.runtime.sendNativeMessage to the
    // desktop's `com.steam_client.token` host (replaces the old hardcoded
    // SERVER_TOKEN constant — see apps/extension/lib/config.ts).
    permissions: ['storage', 'alarms', 'tabs', 'nativeMessaging'],
    host_permissions: [
      'http://127.0.0.1:38721/*',
      'ws://127.0.0.1:38721/*',
    ],
    action: {
      default_title: 'Steam Client Bridge',
    },
  },
});
