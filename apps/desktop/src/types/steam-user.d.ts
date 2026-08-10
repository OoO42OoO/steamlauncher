// Ambient declaration for steam-user (no official @types package).
// Keep minimal; we only use the subset below.
declare module 'steam-user' {
  import { EventEmitter } from 'node:events';

  interface LogOnDetails {
    accountName?: string;
    password?: string;
    refreshToken?: string;
    twoFactorCode?: string;
    rememberPassword?: boolean;
    machineName?: string;
  }

  interface AppInfo {
    appid: number;
    name?: string;
    icon?: string;
    logo?: string;
    logo_small?: string;
    clienticon?: string;
  }

  interface SteamUserOptions {
    dataDirectory?: string | null;
    autoRelogin?: boolean;
    singleSentryfile?: boolean;
    machineIdType?: number;
    machineIdFormat?: unknown;
    enablePicsCache?: boolean;
    picsCacheAll?: boolean;
    changelistUpdateInterval?: number;
    [key: string]: unknown;
  }

  class SteamUser extends EventEmitter {
    constructor(options?: SteamUserOptions);
    logOn(details: LogOnDetails): void;
    logOff(): void;
    getUserOwnedApps(
      steamID: unknown,
      opts: unknown,
      cb: (err: Error | null, apps: { apps: AppInfo[] }) => void
    ): void;
    getProductInfo(
      apps: number[],
      packages: number[],
      inclTokens: boolean,
      cb: (
        err: Error | null,
        res: { apps: Record<string, { appinfo: Record<string, unknown> }> }
      ) => void
    ): void;
    steamID: unknown;
    relog(): void;
    // Convenience: steam-user emits many events; we treat them as untyped.
  }

  export = SteamUser;
}

declare module 'steam-totp' {
  export function generateAuthCode(sharedSecret: string, timeOffset?: number): string;
  export function getTimeOffset(
    cb: (err: Error | null, offset: number, latency: number) => void
  ): void;
  export function time(offset?: number): number;
}
