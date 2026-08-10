import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Read deployment configuration out of a local .env.
 *
 * Vite's own env loading only reaches `import.meta.env` with a VITE_ prefix;
 * this config runs in Node and needs the raw values. Without this a plain
 * `pnpm package:win` would quietly produce an installer with no hostname in
 * it — the one failure mode this whole arrangement exists to avoid. An
 * exported variable still wins, so CI can override the file.
 */
function fromDotEnv(name: string): string | undefined {
  for (const file of [resolve(__dirname, '.env'), resolve(__dirname, '../../.env')]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

const endpoint = (name: string): string => process.env[name] ?? fromDotEnv(name) ?? '';

export default defineConfig({
  main: {
    // @steam-client/shared is a workspace package authored in TS; it must
    // be bundled into main (not marked external), otherwise Node ESM can't
    // resolve its relative imports at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['@steam-client/shared'] })],
    // Service hostnames are deployment configuration and are deliberately
    // absent from the source tree. They come from the build environment and
    // are inlined here; src/main/endpoints.ts is the only reader. A build
    // without API_BASE_URL produces an app that says so loudly rather than
    // one that fails obscurely against a hostname nobody wrote down.
    define: {
      __API_BASE_URL__: JSON.stringify(endpoint('API_BASE_URL')),
      __UPDATES_FEED_URL__: JSON.stringify(endpoint('STEAM_CLIENT_UPDATES_URL')),
    },
    build: {
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@steam-client/shared'] })],
    build: {
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          // Emit as CommonJS so the BrowserWindow can load it with
          // sandbox:true. package.json has "type":"module" globally, so we
          // must use the .cjs extension explicitly.
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    // Prevent Vite from inlining process.env.* into the renderer bundle.
    define: {
      'process.env': '{}',
    },
    build: {
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
});
