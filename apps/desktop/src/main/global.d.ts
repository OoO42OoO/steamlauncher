declare namespace Electron {
  interface App {
    isQuitting?: boolean;
  }
}

// Inlined by electron.vite.config.ts from the build environment. Empty
// string when the build had nothing to inline — see src/main/endpoints.ts.
declare const __API_BASE_URL__: string;
declare const __UPDATES_FEED_URL__: string;
