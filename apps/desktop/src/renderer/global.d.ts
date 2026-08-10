import type { Api, FeatureFlagsApi } from '../preload';

declare global {
  interface Window {
    api: Api;
    featureFlags: FeatureFlagsApi;
  }
}

export {};
