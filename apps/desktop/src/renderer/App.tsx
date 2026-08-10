import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  DownloadStage,
  PublicAccount,
  SessionStatus,
  RedeemResult,
  TaskRead,
} from '@steam-client/shared';
import type { SteamNewsItem } from '../main/api/steam-store';
import {
  LANGUAGE_NAMES,
  SUPPORTED_LANGUAGES,
  setLanguage,
  type SupportedLanguage,
} from './i18n';
import { UpdateToast } from './components/UpdateToast';
import { DrmPatchToast } from './components/DrmPatchToast';
import { LanguageFlag } from './components/LanguageFlag';
import { Dropdown } from './ui/Dropdown';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCheck,
  IconClock,
  IconDownload,
  IconFolder,
  IconGear,
  IconGrid,
  IconInfo,
  IconKey,
  IconLibrary,
  IconLock,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconStar,
  IconStats,
  IconTelegram,
  IconTrash,
  IconX,
} from './ui/icons';

type View =
  | 'library'
  | 'installed'
  | 'downloads'
  | 'tasks'
  | 'stats'
  | 'game-detail'
  | 'settings';

/**
 * Subset of Steam Store appdetails we render. Mirrors
 * `SteamAppDetailsData` from main/api/steam-store.ts; we duplicate the
 * shape here as a renderer-side type to avoid pulling main code through
 * the preload barrier. Fields are all optional — Steam omits anything
 * unknown for an appid and a partial response is still better than none.
 */
type SteamAppDetails = {
  type?: string;
  name: string;
  steam_appid: number;
  short_description?: string;
  detailed_description?: string;
  about_the_game?: string;
  header_image?: string;
  capsule_image?: string;
  background?: string;
  background_raw?: string;
  developers?: string[];
  publishers?: string[];
  release_date?: { coming_soon?: boolean; date?: string };
  genres?: Array<{ id: string | number; description: string }>;
  categories?: Array<{ id: string | number; description: string }>;
  pc_requirements?: { minimum?: string; recommended?: string };
  screenshots?: Array<{
    id: string | number;
    path_thumbnail?: string;
    path_full?: string;
  }>;
  movies?: Array<{
    id: string | number;
    name?: string;
    thumbnail?: string;
    webm?: { '480'?: string; max?: string };
    mp4?: { '480'?: string; max?: string };
  }>;
};

/** Where to send users who need a fresh redeem code. */
const SITE_URL = 'https://t.me/launcherfreebot';

/** Type guard the picker uses before persisting a chosen language. */
function isSupportedLanguage(s: string): s is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(s);
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Russian-language label for the current download stage. Multi-depot apps
 * (e.g. Civilization V with DLC) cycle through several depots; without this
 * hint the percent appears to jump back to 0% with no explanation.
 */
function useStageHint(): (stage: DownloadStage | null | undefined) => string | null {
  const { t } = useTranslation();
  return useCallback(
    (stage: DownloadStage | null | undefined): string | null => {
      if (!stage) return null;
      const counter =
        stage.current && stage.total && stage.total > 1
          ? t('stage.counter', { current: stage.current, total: stage.total })
          : '';
      switch (stage.phase) {
        case 'queued':
          return t('stage.queued');
        case 'connecting':
          return t('stage.connecting');
        case 'authenticating':
          return t('stage.authenticating');
        case 'fetching_manifest':
          return t('stage.fetching_manifest');
        case 'downloading': {
          const head = stage.label
            ? t('stage.downloading_with_label', { label: stage.label })
            : t('stage.downloading_no_label');
          return head + counter;
        }
        case 'validating': {
          const head = stage.label
            ? t('stage.validating_with_label', { label: stage.label })
            : t('stage.validating_no_label');
          return head + counter;
        }
        case 'finalizing':
          return t('stage.finalizing');
        case 'installing_redist': {
          const head = stage.label
            ? t('stage.installing_redist_with_label', { label: stage.label })
            : t('stage.installing_redist_no_label');
          return head + counter;
        }
      }
    },
    [t]
  );
}

/**
 * Aggregate download percent across all depots, computed from
 *   (currentDepot - 1 + percent/100) / totalDepots * 100
 *
 * DD emits a per-depot percent that resets to 0% at each depot boundary;
 * without this transform the status bar appears to "fill and reset"
 * several times during a multi-depot install (e.g. Civilization V).
 *
 * Falls back to the raw `percent` when we don't yet know the depot
 * index/total (still on the `connecting` / `authenticating` phase).
 */
function aggregateDownloadPercent(
  percent: number,
  stage: DownloadStage | null | undefined
): number {
  const total = stage?.total ?? 0;
  const current = stage?.current ?? 0;
  if (!total || !current) return Math.max(0, Math.min(100, percent));
  const agg = ((current - 1) + percent / 100) / total;
  return Math.max(0, Math.min(100, agg * 100));
}

/**
 * Format a byte count as e.g. "1.2 MB" / "740 MB" / "3.4 GB". Bytes
 * always in 1024-based units — that's what disk usage, DD's "Total
 * downloaded" line, and the on-disk dir walk all produce, so we keep
 * it consistent end-to-end.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Does the long description already open with the short one?
 *
 * Steam's `detailed_description` almost always begins with the same sentence
 * as `short_description` — sometimes after an "About This Game" heading — so
 * rendering the short one as a standfirst above it prints the lead twice and
 * reads as a bug. Compared on text, not markup, and only for a lead long
 * enough that a coincidence is implausible.
 */
function detailedRepeatsLead(lead: string, detailedHtml: string): boolean {
  const text = (raw: string) =>
    raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const head = text(lead);
  if (head.length < 24) return false;
  // A little slack at the front for a heading Steam may have put there.
  return text(detailedHtml).slice(0, head.length + 200).includes(head);
}

/**
 * Steam publishes announcement bodies as BBCode with the odd HTML tag mixed
 * in, already truncated by `maxlength`. The card wants a plain sentence: drop
 * the markup, collapse whitespace, and let CSS clamp what's left.
 */
function newsExcerpt(contents: string): string {
  return contents
    .replace(/\[\/?[^\]]*\]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Announcement date in the user's locale. Steam sends Unix seconds. */
function formatNewsDate(unixSeconds: number): string {
  if (!unixSeconds) return '';
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return '';
  }
}

/**
 * Localized one-liner for in-flight email-Guard polls and known terminal
 * download errors. Returns null when neither applies — caller falls back
 * to the generic stage hint or "Download failed" label.
 */
function useDownloadHint(): (
  hint: 'waiting_for_email' | 'received' | null | undefined,
  error: string | null | undefined,
  errorPlatforms?: ReadonlyArray<'windows' | 'mac' | 'linux'> | null
) => string | null {
  const { t } = useTranslation();
  return useCallback(
    (hint, error, errorPlatforms) => {
      if (hint === 'waiting_for_email') return t('download.guard.waiting_for_email');
      if (hint === 'received') return t('download.guard.received');
      // Auth phase failures: Steam login itself didn't succeed (bad
      // creds, throttled, account has no license for this app). Group
      // them under one short label so the user immediately knows the
      // download didn't get past the sign-in step.
      if (
        error === 'invalid_credentials' ||
        error === 'rate_limited' ||
        error === 'no_license'
      ) {
        return t('download.error.authorization');
      }
      // Auth Guard phase failures: login was accepted but the Steam
      // Guard code step couldn't be resolved (no maFile + no IMAP
      // fallback configured, TOTP generator crashed, etc.). Surface
      // as a distinct category so the user can tell apart "I can't
      // sign in" from "I can't get past the email code step".
      if (
        error === 'two_factor_required' ||
        error === 'two_factor_failed' ||
        error === 'account_unconfigured'
      ) {
        return t('download.error.auth_guard');
      }
      // The play session lapsed mid-download, so the credentials endpoint
      // refused. GameSessionDialog prompts for a fresh code; this label
      // explains the card that stopped.
      if (error === 'game_session_required') {
        return t('download.error.game_session_required');
      }
      // Host filesystem ran out of free space — surfaced by the
      // pre-flight statfs() check in main and by the dd-parser
      // when DD prints "There is not enough space on the disk." mid-run.
      if (error === 'disk_full') {
        return t('download.error.disk_full');
      }
      if (error === 'unsupported_platform') {
        return t('download.error.unsupported_platform', {
          current: t(`platform.${currentRendererPlatform()}`),
          list: formatPlatformList(t, errorPlatforms),
        });
      }
      if (error === 'account_missing_license_other_platform') {
        return t('download.error.account_missing_license_other_platform', {
          list: formatPlatformList(t, errorPlatforms),
        });
      }
      if (error === 'account_missing_license')
        return t('download.error.account_missing_license');
      if (error === 'empty_download')
        return t('download.error.empty_download');
      return null;
    },
    [t]
  );
}

function currentRendererPlatform(): 'windows' | 'mac' | 'linux' | 'unknown' {
  // navigator.platform is deprecated but consistent across Electron/Chromium;
  // sufficient for picking the localized "your platform" word in the
  // unsupported-platform message. Fallback to userAgent sniffing keeps it
  // working on engines that already removed it.
  const p = (navigator.platform || '').toLowerCase();
  const ua = navigator.userAgent.toLowerCase();
  if (p.includes('win') || ua.includes('windows')) return 'windows';
  if (p.includes('mac') || ua.includes('mac os')) return 'mac';
  if (p.includes('linux') || ua.includes('linux')) return 'linux';
  return 'unknown';
}

function formatPlatformList(
  t: (k: string) => string,
  platforms?: ReadonlyArray<'windows' | 'mac' | 'linux'> | null
): string {
  if (!platforms || platforms.length === 0) return '';
  return platforms.map((p) => t(`platform.${p}`)).join(', ');
}

function useFormatHoursMinutes(): (sec: number) => string {
  const { t } = useTranslation();
  return useCallback(
    (sec: number): string => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (h === 0) return t('time.minutes_short', { count: m });
      return t('time.hours_minutes_short', { hours: h, minutes: m });
    },
    [t]
  );
}

// ───────────────────────────── TrustBar ─────────────────────────────
/**
 * Slim progress bar showing the user's trust level relative to the assumed
 * maximum (100). Replaces the old static "Trust L{level}" badge — gives a
 * quick visual sense of progress instead of a bare number.
 */
function TrustBar({ level }: { level: number }) {
  const { t } = useTranslation();
  const max = 100;
  const pct = Math.min(100, Math.max(0, (level / max) * 100));
  return (
    <div
      className="trust-bar"
      title={t('titlebar.trust')}
      role="progressbar"
      aria-label={t('titlebar.trust_aria', { level })}
      aria-valuenow={level}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <div className="trust-bar-label">
        <span>{t('titlebar.trust')}</span>
        <span className="trust-bar-value">
          {level}/{max}
        </span>
      </div>
      <div className="trust-bar-track">
        <div className="trust-bar-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ───────────────────────────── Titlebar ─────────────────────────────
function Titlebar({
  balance,
  trustLevel,
  quickGames,
  currentAppid,
  gameSession,
  language,
  onChangeLanguage,
  onSelectGame,
  onOpenSettings,
  onLogout,
  balanceEnabled,
}: {
  balance: number | null;
  trustLevel: number | null;
  /** Resolved UI language. Lives in the chrome so it is reachable from the
   *  access screen too — a user who can't read the current language has no
   *  business having to find Settings first. */
  language: string;
  onChangeLanguage: (code: string) => void;
  /** Pinned games, shown as a quick-switch strip. Empty until the user pins
   *  something (or while signed out), and the strip simply doesn't render. */
  quickGames: PublicAccount[];
  currentAppid: number | null;
  /** Play entitlement: active + how long it lasts. null while unknown. */
  gameSession: { is_active: boolean; remaining_seconds: number } | null;
  onSelectGame: (appid: number) => void;
  onOpenSettings: () => void;
  onLogout?: () => void;
  balanceEnabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="titlebar h-[46px] flex items-center pl-3 pr-1.5 gap-1 border-b border-[var(--color-border-soft)] bg-[linear-gradient(180deg,#121b26,#0c131c)]">
      <div className="flex items-center gap-2.5 h-full pr-3 mr-1.5 border-r border-[var(--color-border-soft)]">
        <span
          className="w-[26px] h-[26px] rounded-lg grid place-items-center text-[var(--color-accent)] border border-[#17618f] bg-[linear-gradient(150deg,#0e4f80,#072a45)]"
          aria-hidden="true"
        >
          <IconPlay size={12} />
        </span>
        <span className="font-[family-name:var(--font-display)] text-[13px] font-semibold tracking-wide text-[#c9dae9] select-none">
          STEAM LAUNCHER
        </span>
      </div>
      {/* Pinned games sit in the chrome itself, Battle.net style: switching
          the game you're looking at never costs a trip through the catalog. */}
      {quickGames.map((g) => (
        <button
          key={g.appid}
          type="button"
          onClick={() => onSelectGame(g.appid)}
          title={g.game_name}
          aria-label={g.game_name}
          aria-current={g.appid === currentAppid}
          className={
            'game-tab' + (g.appid === currentAppid ? ' game-tab-active' : '')
          }
        >
          <GameCover appid={g.appid} name={g.game_name} src={g.logoUrl} />
        </button>
      ))}
      <div className="flex-1" />
      {trustLevel !== null && (
        <TrustBar level={trustLevel} />
      )}
      {/* Access is no longer a stock of purchased minutes — it's a session the
          backend renews when the user completes a task. So the chrome shows
          how long the current session has left, not a balance to spend. */}
      {gameSession && (
        <div className="session-chip" aria-label={t('titlebar.session_aria')}>
          <b style={gameSession.is_active ? undefined : { color: 'var(--color-gold)' }}>
            {gameSession.is_active
              ? formatTime(gameSession.remaining_seconds)
              : t('titlebar.session_task_due')}
          </b>
          <span>
            {gameSession.is_active
              ? t('titlebar.session_label')
              : t('titlebar.session_expired')}
          </span>
        </div>
      )}
      {onLogout && (
        <button
          onClick={onLogout}
          className="text-xs px-2 py-1 rounded-md border border-[var(--color-border)] text-slate-400 hover:text-[var(--color-bad)] hover:border-[color-mix(in_oklch,var(--color-bad)_60%,transparent)] transition"
        >
          {t('titlebar.logout')}
        </button>
      )}
      <LanguagePicker value={language} onChange={onChangeLanguage} compact />
      <button
        type="button"
        className="titlebar-button titlebar-settings"
        onClick={onOpenSettings}
        aria-label={t('titlebar.settings')}
        title={t('titlebar.settings')}
      >
        <IconGear size={16} />
      </button>
      <button
        type="button"
        className="titlebar-button titlebar-minimize"
        onClick={() => void window.api.window.minimize()}
        aria-label={t('titlebar.minimize')}
        title={t('titlebar.minimize')}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="5.5" width="9" height="1" fill="currentColor" /></svg>
      </button>
      <button
        type="button"
        className="titlebar-button titlebar-close"
        onClick={() => void window.api.window.close()}
        aria-label={t('titlebar.close')}
        title={t('titlebar.close')}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" /></svg>
      </button>
    </div>
  );
}

// ───────────────────────────── Settings Page ─────────────────────────────
function SettingsPage({
  resolvedLanguage,
  installRoot,
  autoUpdate,
  balanceEnabled,
  onChangeLanguage,
  onChooseInstallDir,
  onToggleAutoUpdate,
  onBack,
}: {
  resolvedLanguage: string;
  installRoot: string | null;
  autoUpdate: boolean;
  balanceEnabled: boolean;
  onChangeLanguage: (code: string) => void;
  onChooseInstallDir: () => void;
  onToggleAutoUpdate: (next: boolean) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [appInfo, setAppInfo] = useState<{
    app: string;
    electron: string;
    platform: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.api.app.getVersion().then((info) => {
      if (!cancelled) setAppInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-head">
        <button
          type="button"
          className="settings-back"
          onClick={onBack}
          aria-label={t('settings.back')}
        >
          ← {t('settings.back')}
        </button>
        <h1 className="ml-1.5">{t('settings.title')}</h1>
      </div>
      <div className="settings-page">
        <div className="settings-sections">
          <section className="settings-section">
            <div className="settings-section-head">
              <h2>{t('settings.language.title')}</h2>
              <p>{t('settings.language.description')}</p>
            </div>
            <LanguagePicker
              value={resolvedLanguage}
              onChange={onChangeLanguage}
            />
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>{t('settings.install_dir.title')}</h2>
              <p>{t('settings.install_dir.description')}</p>
            </div>
            <div className="settings-install-dir">
              <code className="settings-install-dir-path">
                {installRoot || t('settings.install_dir.default')}
              </code>
              <button
                type="button"
                className="settings-button"
                onClick={onChooseInstallDir}
              >
                {t('settings.install_dir.change')}
              </button>
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-head">
              <h2>{t('settings.auto_update.title')}</h2>
              <p>{t('settings.auto_update.description')}</p>
            </div>
            <div className="settings-toggle-row">
              <span className="settings-toggle-label">
                {t('settings.auto_update.label')}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={autoUpdate}
                data-checked={autoUpdate ? 'true' : 'false'}
                className="toggle-switch"
                onClick={() => onToggleAutoUpdate(!autoUpdate)}
              >
                <span className="toggle-switch-knob" />
              </button>
            </div>
          </section>

          <section className="settings-section settings-about">
            <div className="settings-section-head">
              <h2>{t('settings.about_section_label')}</h2>
            </div>
            <dl className="settings-about-list">
              <div className="settings-about-row">
                <dt>{t('settings.app_version_label')}</dt>
                <dd>{appInfo?.app ?? '—'}</dd>
              </div>
              <div className="settings-about-row">
                <dt>{t('settings.platform_label')}</dt>
                <dd>{appInfo?.platform ?? '—'}</dd>
              </div>
              <div className="settings-about-row">
                <dt>{t('settings.electron_version_label')}</dt>
                <dd>{appInfo?.electron ?? '—'}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * UI language picker. The value is the *resolved* code (what i18next is
 * actually using), so a saved 'auto' setting shows up as the OS-resolved
 * language with no extra "Auto" entry; picking one persists it explicitly.
 *
 * Built on the shared Dropdown rather than a native <select>, because
 * <option> can'''t render a flag — and rather than its own popover, because
 * two hand-rolled dropdowns meant two copies of the keyboard and
 * click-outside handling to keep in step.
 */
function LanguagePicker({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (code: string) => void;
  /** Titlebar variant: flag only, so it fits the chrome without crowding it. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const options = (SUPPORTED_LANGUAGES as readonly string[]).map((code) => ({
    value: code,
    label: LANGUAGE_NAMES[code as keyof typeof LANGUAGE_NAMES] ?? code,
    icon: <LanguageFlag code={code} />,
  }));
  return (
    <Dropdown
      value={value}
      options={options}
      onChange={onChange}
      align={compact ? 'end' : 'start'}
      ariaLabel={t('titlebar.language_aria')}
      hideLabel={compact}
      className={compact ? 'titlebar-language' : undefined}
      triggerClassName={compact ? 'px-2 py-1.5' : 'min-w-[200px] justify-between'}
    />
  );
}

// ───────────────────────────── Redeem ─────────────────────────────
type RedeemError = Exclude<RedeemResult, { ok: true }>['error'];

type RedeemView =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'error'; code: RedeemError };

/**
 * Message for a launch or install that failed outright. Most codes already
 * have copy from the download-error path; the rest fall back to whatever
 * main sent, and finally to a generic line — better a vague toast than the
 * silence this replaced.
 */
function useLaunchErrorText(): (
  err: string | undefined,
  message: string | undefined
) => string {
  const { t } = useTranslation();
  const downloadHint = useDownloadHint();
  return useCallback(
    (err, message) => {
      if (err === 'already_running') return t('game.already_running');
      if (err === 'session_check_failed') return t('errors.server_unreachable');
      const known = downloadHint(null, err ?? null, null);
      return known ?? message ?? err ?? t('downloads.failed_label');
    },
    [t, downloadHint]
  );
}

function useRedeemErrorText(): (err: string) => string {
  const { t } = useTranslation();
  return useCallback(
    (err: string): string => {
      switch (err) {
        case 'not_found':
          return t('redeem.errors.not_found');
        case 'expired':
          return t('redeem.errors.expired');
        case 'service_unavailable':
          return t('redeem.errors.service_unavailable');
        case 'network':
          return t('redeem.errors.network');
        default:
          return t('redeem.errors.unknown');
      }
    },
    [t]
  );
}

function RedeemPage({ initialCode }: { initialCode: string | null }) {
  const { t } = useTranslation();
  const redeemErrorText = useRedeemErrorText();
  const [code, setCode] = useState(initialCode ?? '');
  const [view, setView] = useState<RedeemView>({ kind: 'idle' });
  const attempted = useRef<string | null>(null);

  const submit = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setView({ kind: 'submitting' });
    const res = await window.api.auth.redeem(trimmed);
    if (res.ok) return;
    setView({ kind: 'error', code: res.error });
  }, []);

  // Auto-submit whenever the parent hands us a new deeplink code. The
  // useEffect dep is `initialCode` itself — React re-runs only on value
  // change, so no double-submit on re-renders. The `attempted` ref guards
  // against React 18 StrictMode's double-invoke in dev.
  useEffect(() => {
    if (!initialCode) return;
    if (attempted.current === initialCode) return;
    attempted.current = initialCode;
    setCode(initialCode);
    void submit(initialCode);
  }, [initialCode, submit]);

  const busy = view.kind === 'submitting';

  // Two steps, in the order the user actually performs them: open the bot,
  // then paste what it gives back.
  const steps = [
    { icon: <IconTelegram className="w-4 h-4" />, label: t('redeem.step_open_bot') },
    { icon: <IconKey className="w-4 h-4" />, label: t('redeem.step_paste_code') },
  ];

  return (
    <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
      <div className="w-full max-w-[34rem] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-8 shadow-2xl">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-14 h-14 rounded-xl flex items-center justify-center bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] border border-[color-mix(in_oklch,var(--color-accent)_35%,transparent)] text-[var(--color-accent)]">
            <IconLock className="w-7 h-7" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold leading-tight">
              {t('redeem.title')}
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {t('redeem.description')}
            </p>
          </div>
        </div>

        {/* Still an <ol> — the steps are a sequence — but the numerals are
            dropped in favour of the icon alone, which carries the badge. */}
        <ol className="mt-6 space-y-3">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-3">
              <span className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] border border-[color-mix(in_oklch,var(--color-accent)_30%,transparent)] text-[var(--color-accent)]">
                {s.icon}
              </span>
              <span className="text-sm text-slate-300">{s.label}</span>
            </li>
          ))}
        </ol>

        <div className="my-6 h-px bg-[var(--color-border)]" />

        {/* Primary CTA — the bot is where codes come from, so it stays visible
            before any code is entered, not only after a failed redeem. */}
        <button
          type="button"
          onClick={() => void window.api.shell.openExternal(SITE_URL)}
          className="relative w-full flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] px-4 py-3 text-sm font-medium hover:brightness-110 transition cursor-pointer"
        >
          <IconTelegram className="w-4 h-4" />
          <span>{t('redeem.open_site')}</span>
          <IconChevronRight className="w-4 h-4 absolute right-4 opacity-70" />
        </button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(code);
          }}
          className="mt-5 space-y-3"
        >
          <div>
            <label
              htmlFor="redeem-code"
              className="text-xs text-slate-400"
            >
              {t('redeem.code_label')}
            </label>
            <div className="relative mt-1.5">
              <IconLock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                id="redeem-code"
                className="redeem-input w-full rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] pl-10 pr-3 py-2.5 text-sm transition focus:outline-none focus:border-[var(--color-accent)] aria-[invalid=true]:border-[color-mix(in_oklch,var(--color-bad)_60%,transparent)] aria-[invalid=true]:focus:border-[var(--color-bad)]"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                inputMode="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
                disabled={busy}
                placeholder={t('redeem.code_placeholder')}
                aria-invalid={view.kind === 'error' || undefined}
                aria-describedby={view.kind === 'error' ? 'redeem-error' : undefined}
                autoFocus
              />
            </div>
          </div>
          {/* Accent while actionable, muted once disabled — mirrors the locked
              affordance of the header icon. */}
          <button
            type="submit"
            disabled={busy || !code.trim()}
            // The payoff of the whole screen: it carries the largest label on
            // the card and lights up the moment a code is actually present,
            // so "I pasted it, now what" answers itself.
            className={'unlock-btn' + (code.trim() && !busy ? ' unlock-btn-ready' : '')}
          >
            <IconLock size={16} />
            {busy ? t('redeem.submitting') : t('redeem.submit')}
          </button>
        </form>

        {view.kind === 'error' && (
          <div
            id="redeem-error"
            role="alert"
            className="mt-4 text-xs rounded-md border border-[color-mix(in_oklch,var(--color-bad)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] px-3 py-2 text-[var(--color-bad)]"
          >
            {redeemErrorText(view.code)}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <IconShieldCheck className="shrink-0 w-4 h-4 text-emerald-400/80" />
          <span>{t('redeem.no_account_note')}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Blocking prompt shown when an install or launch is refused because the user
 * has no active game session.
 *
 * A session is granted server-side once the user completes the Telegram bot's
 * task — the bot opens access directly, there is no code to bring back. So
 * this dialog only sends the user to the bot and then asks the server whether
 * it has happened yet. It lapses after a few hours, so this is the
 * every-few-hours checkpoint, not a sign-in (the user stays signed in
 * throughout, their Bearer is fine). On success the caller replays the action
 * that was blocked, so the click the user originally made still happens.
 */
function GameSessionDialog({
  onClose,
  onGranted,
}: {
  onClose: () => void;
  onGranted: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'locked' | 'unreachable'>('idle');
  // Escape and Later unmount the dialog but cannot cancel a check already in
  // flight, and the check is a live request that can take seconds. Without
  // this the verdict lands after the user has given up and launches the game
  // they just dismissed.
  const abandoned = useRef(false);
  useEffect(() => () => {
    abandoned.current = true;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // "I've done the task" — ask the server whether that's true yet. Nothing is
  // cached in main, so this always reflects the bot's most recent decision.
  const recheck = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('idle');
    let verdict: 'ok' | 'required' | 'unreachable';
    try {
      verdict = await window.api.session.check();
    } catch {
      verdict = 'unreachable';
    }
    if (abandoned.current) return;
    setBusy(false);
    if (verdict === 'ok') onGranted();
    else setStatus(verdict === 'unreachable' ? 'unreachable' : 'locked');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(4,7,10,0.88)] backdrop-blur-[3px] p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="game-session-title"
    >
      <div className="w-full max-w-[430px] rounded-[13px] border border-[var(--color-border)] bg-[var(--color-surface-3)] p-6 shadow-[0_30px_70px_-26px_#000]">
        <div className="flex items-start gap-4">
          <div className="shrink-0 w-[42px] h-[42px] rounded-xl flex items-center justify-center bg-[color-mix(in_oklch,var(--color-accent)_15%,transparent)] border border-[color-mix(in_oklch,var(--color-accent)_35%,transparent)] text-[var(--color-accent)]">
            <IconClock size={20} />
          </div>
          <div className="min-w-0">
            <h2
              id="game-session-title"
              className="font-[family-name:var(--font-display)] text-[19px] font-semibold leading-tight"
            >
              {t('gameSession.title')}
            </h2>
            <p className="mt-[7px] text-[13px] leading-[1.55] text-[var(--color-dim)]">
              {t('gameSession.description')}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void window.api.shell.openExternal(SITE_URL)}
          className="btn-play w-full justify-center mt-4"
        >
          <IconTelegram size={14} />
          {t('gameSession.open_bot')}
        </button>

        {status === 'locked' && (
          <div
            role="alert"
            className="mt-3 text-xs rounded-md border border-[color-mix(in_oklch,var(--color-gold)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-gold)_12%,transparent)] px-3 py-2 text-[var(--color-gold)]"
          >
            {t('gameSession.still_locked')}
          </div>
        )}
        {status === 'unreachable' && (
          <div
            role="alert"
            className="mt-3 text-xs rounded-md border border-[color-mix(in_oklch,var(--color-bad)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] px-3 py-2 text-[var(--color-bad)]"
          >
            {t('errors.server_unreachable')}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-play btn-play-secondary"
          >
            {t('gameSession.later')}
          </button>
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={busy}
            className="btn-play btn-play-secondary flex-1 justify-center"
          >
            <IconCheck size={14} />
            {busy ? t('gameSession.checking') : t('gameSession.done')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The button the user just pressed, while the work is still invisible.
 *
 * Keeps the same box as the control it replaces — same class, same width —
 * so nothing reflows on click; only the label and the spinner change. It is
 * disabled, which also stops the double-click that the pre-flight round trip
 * otherwise invites.
 */
function BusyButton({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <button type="button" className={className} disabled aria-busy="true">
      <span className="btn-spinner" aria-hidden="true" />
      {label}
    </button>
  );
}

/** Catalog orderings. Only what the client can actually know: names, what is
 *  on disk, and local playtime. Install size would need a per-game disk walk. */
type SortKey = 'name' | 'installed' | 'played';

type LibraryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: PublicAccount[] }
  | { kind: 'error' };

/**
 * Transient state of a Play-button click: appid being launched, the current
 * phase (DD validate / DD delta / launching the .exe), and the latest percent
 * if a delta is being downloaded. Lives in App and threads down to the
 * library card + GameDetail action — null when no launch is in flight.
 */
type LaunchPhase = 'checking' | 'updating' | 'patching' | 'launching';
type LaunchProgress = {
  appid: number;
  phase: LaunchPhase;
  percent: number;
};

/**
 * Deterministic hue from appid so each game gets a stable fallback colour.
 * Cheap 32-bit mix — no need for a real hash, we just want spread.
 */
function appidHue(appid: number): number {
  const x = (appid * 2654435761) >>> 0;
  return x % 360;
}

/**
 * Cover image for a Steam app. Falls back to a per-appid gradient with the
 * game's first two initials when nothing loads. Aspect ratio is fixed by the
 * parent — we just fill 100% × 100%.
 *
 * Two-stage source:
 *   1. `src` — the appid's `header.jpg` (correct + free for released games).
 *   2. On its failure, the Store appdetails `header_image` fetched on demand
 *      via the same IPC the detail page uses (cache-first in main). UNRELEASED
 *      titles 404 on the plain `header.jpg` path because their art lives at a
 *      hashed `store_item_assets/.../header.jpg` URL we can't build from the
 *      appid — but appdetails returns that exact URL (007 First Light, Forza
 *      Horizon 6, MECCHA CHAMELEON, Resident Evil Requiem all resolve here).
 * We only hit the network for cards whose free `header.jpg` actually failed,
 * and `loading="lazy"` defers even that until the card scrolls into view, so
 * released games and off-screen cards cost nothing.
 */
function GameCover({
  appid,
  name,
  src,
}: {
  appid: number;
  name: string;
  src: string | null;
}) {
  // 'primary' shows `src`; 'details' shows the on-demand appdetails header
  // once it lands; 'gradient' gives up. `detailsUrl` is null until fetched.
  const [phase, setPhase] = useState<'primary' | 'details' | 'gradient'>(
    src ? 'primary' : 'details'
  );
  const [detailsUrl, setDetailsUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Reset when the card is recycled onto a different game as the library
  // re-renders (download-progress ticks replace the library object).
  useEffect(() => {
    setPhase(src ? 'primary' : 'details');
    setDetailsUrl(null);
    setLoaded(false);
  }, [appid, src]);

  // Entered the details stage without a URL yet → ask main for the appdetails
  // header_image (cache-first). No usable image there → gradient.
  useEffect(() => {
    if (phase !== 'details' || detailsUrl) return;
    let cancelled = false;
    void Promise.resolve(window.api.steam?.appDetails(appid))
      .then((d) => {
        if (cancelled) return;
        const url = (d as { header_image?: string } | null)?.header_image;
        if (url) setDetailsUrl(url);
        else setPhase('gradient');
      })
      .catch(() => {
        if (!cancelled) setPhase('gradient');
      });
    return () => {
      cancelled = true;
    };
  }, [phase, detailsUrl, appid]);

  const initials = name.trim().slice(0, 2).toUpperCase() || '?';
  const hue = appidHue(appid);
  const fallbackStyle = {
    background: `linear-gradient(135deg, hsl(${hue}, 40%, 25%), hsl(${(hue + 30) % 360}, 40%, 15%))`,
  };
  const currentSrc =
    phase === 'primary' ? src : phase === 'details' ? detailsUrl : null;
  const showFallback = !loaded;
  return (
    <>
      {showFallback && (
        <div
          className="absolute inset-0 flex items-center justify-center select-none"
          style={fallbackStyle}
          aria-hidden={phase !== 'gradient'}
        >
          <span className="text-3xl font-semibold text-white/85 tracking-wider drop-shadow">
            {initials}
          </span>
        </div>
      )}
      {currentSrc && (
        <img
          key={currentSrc}
          src={currentSrc}
          alt=""
          className="w-full h-full object-cover relative"
          draggable={false}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => {
            // header.jpg failed → try the appdetails header; that failing too
            // (or a broken URL) → gradient.
            setPhase((p) => (p === 'primary' ? 'details' : 'gradient'));
          }}
        />
      )}
    </>
  );
}

// ───────────────────────────── Sidebar ─────────────────────────────
/**
 * Left rail: the games the user pinned, then the section nav.
 *
 * The pinned list is the launcher's home. The selected title expands with its
 * cover and Play button; the rest stay one compact row each with a state dot,
 * so switching between the handful of games someone actually plays is one
 * click from anywhere. Pinning happens on the catalog card's star — the rail
 * never invents its own selection.
 */
function Sidebar({
  games,
  favorites,
  currentAppid,
  railExtraAppid,
  view,
  balance,
  balanceEnabled,
  downloadCount,
  launchProgress,
  installSize,
  playedByAppid,
  pendingStart,
  user,
  onSelectGame,
  onToggleFavorite,
  onView,
  onLaunch,
  onDownload,
  onCancel,
}: {
  games: PublicAccount[];
  favorites: number[];
  currentAppid: number | null;
  /** A non-pinned game to show in the rail alongside the favourites. */
  railExtraAppid: number | null;
  view: View;
  /** Remaining seconds — only used to disable Play when the balance is out. */
  balance: number;
  balanceEnabled: boolean;
  downloadCount: number;
  launchProgress: LaunchProgress | null;
  /** Disk footprint of the expanded game, or null when unknown/not installed. */
  installSize: number | null;
  /** appid -> seconds played, from the local metrics ledger. */
  playedByAppid: Record<number, number>;
  /** appid -> the action the user just clicked, before any real state has
   *  arrived for it. */
  pendingStart: Record<number, 'download' | 'launch'>;
  /** Signed-in user. The API exposes no nickname, so the foot block shows the
   *  account id — stable, and the thing support will ask for anyway. */
  user: { id: string; trust_level: number } | null;
  onSelectGame: (appid: number) => void;
  onToggleFavorite: (appid: number) => void;
  onView: (v: View) => void;
  onLaunch: (appid: number) => void;
  onDownload: (appid: number) => void;
  onCancel: (appid: number) => void;
}) {
  const { t } = useTranslation();
  const byAppid = new Map(games.map((g) => [g.appid, g]));
  // Keep the user's pin order, and drop ids whose game left the catalog.
  const pinned = favorites
    .map((id) => byAppid.get(id))
    .filter((g): g is PublicAccount => !!g);
  const current = currentAppid !== null ? byAppid.get(currentAppid) ?? null : null;
  // The rail lists the pinned games, plus one guest: a game the user opened
  // that isn't pinned, so the selection is always visible somewhere. The
  // guest is cleared by App when it's unpinned, which is what makes
  // "Открепить" actually remove the card rather than leave it sitting there
  // in guest form.
  const guest =
    railExtraAppid !== null && !favorites.includes(railExtraAppid)
      ? byAppid.get(railExtraAppid) ?? null
      : null;
  const rail = guest ? [guest, ...pinned] : pinned;

  const stateColor = (g: PublicAccount) =>
    g.status === 'installed' || g.status === 'running'
      ? 'var(--color-ok)'
      : g.status === 'downloading'
        ? 'var(--color-accent)'
        : g.status === 'error'
          ? 'var(--color-bad)'
          : '#3a4b5c';

  // Tasks are handed out and completed in the Telegram bot, so the in-app
  // screen has nothing of its own to show yet. The route and the page are
  // left in place — only the way in is hidden.
  const navItems: Array<{ v: View; label: string; icon: ReactNode; badge?: number }> = [
    { v: 'library', label: t('nav.catalog'), icon: <IconGrid size={17} /> },
    { v: 'installed', label: t('nav.library'), icon: <IconLibrary size={17} /> },
    {
      v: 'downloads',
      label: t('nav.downloads'),
      icon: <IconDownload size={17} />,
      badge: downloadCount || undefined,
    },
    { v: 'stats', label: t('nav.stats'), icon: <IconStats size={17} /> },
  ];

  return (
    <aside
      className="w-[252px] shrink-0 min-h-0 flex flex-col border-r border-[var(--color-border-soft)] bg-[var(--color-surface-2)]"
      aria-label={t('nav.sections')}
    >
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3.5 pb-2">
        <span className="font-[family-name:var(--font-data)] text-[9.5px] tracking-[0.18em] uppercase text-[var(--color-dimmer)]">
          {t('sidebar.favorites')}
        </span>
        <button
          type="button"
          onClick={() => onView('library')}
          title={t('sidebar.add')}
          aria-label={t('sidebar.add')}
          className="ml-auto w-[22px] h-[22px] grid place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition cursor-pointer"
        >
          <IconPlus size={12} />
        </button>
      </div>

      {/* Scrolls on its own: with a dozen pins the rail used to push the
          section nav past the bottom of the window, making Downloads and
          Statistics unreachable. Default flex-shrink plus min-h-0 is the
          load-bearing bit — it keeps the list at its natural height while
          there is room and shrinks it, not the nav, once there isn't. */}
      <div className="px-2.5 pb-3.5 grid gap-[3px] border-b border-[var(--color-border-soft)] overflow-y-auto overflow-x-hidden min-h-0">
        {pinned.length === 0 && !current && (
          <p className="px-1.5 py-2 text-[11.5px] leading-relaxed text-[var(--color-dimmer)]">
            {t('sidebar.empty')}
          </p>
        )}
        {/* The game you're looking at expands here even when it isn't pinned —
            otherwise opening something from the catalog left the rail looking
            like nothing was selected. Unpinned, its second button offers to
            pin rather than to unpin. */}
        {rail.map((g) => {
          const isCurrent = g.appid === currentAppid;
          if (!isCurrent) {
            return (
              <button
                key={g.appid}
                type="button"
                onClick={() => onSelectGame(g.appid)}
                className="flex items-center gap-2.5 w-full rounded-lg px-1.5 py-1.5 text-left text-[12.5px] text-[#9fb2c4] hover:bg-[#141e2a] hover:text-[var(--color-ink)] transition cursor-pointer focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
              >
                <span className="relative w-11 h-[21px] shrink-0 rounded overflow-hidden">
                  <GameCover appid={g.appid} name={g.game_name} src={g.logoUrl} />
                </span>
                <span className="flex-1 min-w-0 truncate">{g.game_name}</span>
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: stateColor(g) }}
                  aria-hidden="true"
                />
              </button>
            );
          }
          // The rail's action mirrors the catalog card's states exactly. It
          // used to offer a bare Install/Play regardless, which meant a
          // trust-locked game got a button that silently did nothing, and a
          // download in flight showed "Install" with no percent and no way to
          // cancel.
          const installed = g.status === 'installed' || g.status === 'running';
          const isDownloading = g.status === 'downloading';
          const lp = launchProgress?.appid === g.appid ? launchProgress : null;
          const pinned = favorites.includes(g.appid);
          const playedSeconds = playedByAppid[g.appid] ?? null;
          return (
            <div
              key={g.appid}
              className="rounded-xl border border-[#21374a] bg-[#101b26] p-3 my-0.5"
            >
              <div className="relative h-[84px] rounded-lg overflow-hidden mb-3">
                <GameCover appid={g.appid} name={g.game_name} src={g.logoUrl} />
              </div>
              {/* The rail clips horizontal overflow, so this has to wrap
                  rather than run past the edge — it is the only title in the
                  app with room for two lines. */}
              <div
                className="font-[family-name:var(--font-display)] text-[17px] font-semibold leading-tight break-words"
                title={g.game_name}
              >
                {g.game_name}
              </div>
              <div className="font-[family-name:var(--font-data)] text-[10px] text-[var(--color-dimmer)] mt-1 mb-3">
                appid {g.appid}
              </div>
              {/* Size / played / status, as in the mockup. Rows appear only
                  when the value is actually known — an install that has never
                  been launched has no playtime, and size needs a disk walk
                  that only runs for the expanded game. */}
              <dl className="grid gap-1.5 mb-3">
                {installSize != null && (
                  <div className="flex justify-between gap-2 font-[family-name:var(--font-data)] text-[10.5px]">
                    <dt className="uppercase tracking-[0.06em] text-[var(--color-dimmer)]">
                      {t('sidebar.size')}
                    </dt>
                    <dd className="m-0 tabular-nums text-[#b3c4d4]">
                      {formatBytes(installSize)}
                    </dd>
                  </div>
                )}
                {playedSeconds != null && playedSeconds > 0 && (
                  <div className="flex justify-between gap-2 font-[family-name:var(--font-data)] text-[10.5px]">
                    <dt className="uppercase tracking-[0.06em] text-[var(--color-dimmer)]">
                      {t('sidebar.played')}
                    </dt>
                    <dd className="m-0 tabular-nums text-[#b3c4d4]">
                      {formatTime(playedSeconds)}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between gap-2 font-[family-name:var(--font-data)] text-[10.5px]">
                  <dt className="uppercase tracking-[0.06em] text-[var(--color-dimmer)]">
                    {t('sidebar.status')}
                  </dt>
                  <dd
                    className={
                      'm-0 ' +
                      (installed
                        ? 'text-[var(--color-ok)]'
                        : isDownloading
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-dim)]')
                    }
                  >
                    {installed
                      ? t('library.state_installed')
                      : isDownloading
                        ? t('library.state_downloading')
                        : t('library.state_not_installed')}
                  </dd>
                </div>
              </dl>
              {g.locked ? (
                <div className="py-1.5 text-center text-[11.5px] text-[var(--color-dimmer)]">
                  {t('library.locked_hint', { level: g.min_trust_level })}
                </div>
              ) : lp ? (
                <div className="py-1 text-center">
                  <div className="text-[11px] text-[var(--color-dim)] truncate">
                    {lp.phase === 'checking'
                      ? t('game.checking_updates')
                      : lp.phase === 'updating'
                        ? t('game.downloading_update')
                        : lp.phase === 'patching'
                          ? t('game.patching_drm')
                          : t('game.launching')}
                  </div>
                  {lp.phase === 'updating' && (
                    <div className="mt-1.5 progress-track">
                      <div
                        className="progress-fill progress-fill-live"
                        style={{ width: `${lp.percent}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : isDownloading ? (
                <div>
                  <div className="flex items-baseline justify-between gap-2 mb-1.5">
                    <span className="text-[11px] text-[var(--color-dim)] truncate">
                      {t('nav.downloads')}
                    </span>
                    <span className="font-[family-name:var(--font-data)] text-[11px] tabular-nums text-[var(--color-ink)]">
                      {aggregateDownloadPercent(
                        g.downloadPercent ?? 0,
                        g.downloadStage
                      ).toFixed(1)}
                      %
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill progress-fill-live"
                      style={{
                        width: `${aggregateDownloadPercent(
                          g.downloadPercent ?? 0,
                          g.downloadStage
                        )}%`,
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => onCancel(g.appid)}
                    className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[11.5px] text-[#a6b8c9] hover:border-[color-mix(in_oklch,var(--color-bad)_60%,transparent)] hover:text-[var(--color-bad)] transition cursor-pointer"
                  >
                    {t('gameDetail.cancel')}
                  </button>
                </div>
              ) : pendingStart[g.appid] ? (
                <BusyButton
                  className="btn-play w-full justify-center"
                  label={t('library.starting')}
                />
              ) : installed ? (
                <button
                  type="button"
                  onClick={() => onLaunch(g.appid)}
                  className="btn-play w-full justify-center"
                >
                  <IconPlay size={13} />
                  {t('library.play')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onDownload(g.appid)}
                  className="btn-play w-full justify-center"
                >
                  <IconDownload size={13} />
                  {t('library.install')}
                </button>
              )}
              <div className="flex gap-1.5 mt-2">
                <button
                  type="button"
                  onClick={() => onSelectGame(g.appid)}
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[11.5px] text-[#a6b8c9] hover:border-[#33475b] hover:text-[var(--color-ink)] transition cursor-pointer"
                >
                  {t('sidebar.about')}
                </button>
                {/* Locked games can't be pinned — but one already pinned keeps
                    its unpin button so it can't get stuck in the rail. */}
                {(pinned || !g.locked) && (
                  <button
                    type="button"
                    onClick={() => onToggleFavorite(g.appid)}
                    className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[11.5px] text-[#a6b8c9] hover:border-[#33475b] hover:text-[var(--color-ink)] transition cursor-pointer"
                  >
                    {pinned ? t('sidebar.unpin') : t('library.pin')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <nav className="shrink-0 p-2.5 grid gap-0.5">
        {current && (
          <button
            type="button"
            onClick={() => onSelectGame(current.appid)}
            aria-current={view === 'game-detail'}
            className={
              'nav-rail-item' + (view === 'game-detail' ? ' nav-rail-item-active' : '')
            }
          >
            <IconPlay size={17} />
            {t('nav.game')}
          </button>
        )}
        {navItems.map((item) => (
          <button
            key={item.v}
            type="button"
            onClick={() => onView(item.v)}
            aria-current={view === item.v}
            className={'nav-rail-item' + (view === item.v ? ' nav-rail-item-active' : '')}
          >
            {item.icon}
            {item.label}
            {item.badge !== undefined && (
              <span className="ml-auto font-[family-name:var(--font-data)] text-[9.5px] rounded-full bg-[#17293a] text-[#7fd0ff] px-[7px] py-0.5">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {user && (
        <div className="mt-auto shrink-0 p-3 border-t border-[var(--color-border-soft)] flex items-center gap-2.5">
          <span className="w-[34px] h-[34px] shrink-0 rounded-lg grid place-items-center font-[family-name:var(--font-display)] text-[13px] font-semibold text-[#04212f] bg-[linear-gradient(150deg,#4fd0ff,#0a84d8)]">
            {user.id.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] truncate" title={user.id}>
              {user.id}
            </div>
            <div className="font-[family-name:var(--font-data)] text-[10px] text-[var(--color-dimmer)]">
              {t('titlebar.trust')} {user.trust_level}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * Genre filter that refuses to wrap.
 *
 * Steam hands back dozens of genres for a modest catalog, and a wrapping chip
 * row ate three or four rows of the page before a single cover was visible.
 * So the bar is always one line: the most common genres stay inline, the rest
 * live in a searchable panel behind a counted button, and anything the user
 * actually picked is pinned to the front so what's filtering is never hidden.
 *
 * Selection is an intersection, matching how Steam's own tag filter narrows.
 */
function GenreFilterBar({
  options,
  counts,
  selected,
  onToggle,
  onClear,
  fill,
}: {
  /** Genre names, most-used first. */
  options: string[];
  counts: Map<string, number>;
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
  /** Progress of the background genre fill. Steam's store API is rate-limited,
   *  so main walks the library one game at a time with a politeness delay —
   *  around a minute for a large catalog on a cold cache. */
  fill?: { known: number; total: number; done: boolean };
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The panel opens by moving focus into its search field, so closing it must
  // put focus back on the button that opened it — otherwise dismissing with
  // Escape drops the user at <body> and the next Tab restarts from the top of
  // the window. Falls back to the row when the trigger itself has gone (the
  // count can reach zero while the panel is open).
  const closePanel = useCallback(() => {
    setOpen(false);
    const back = triggerRef.current ?? rootRef.current;
    back?.focus?.();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closePanel]);

  if (fill && !fill.done) {
    // Mid-fill the option list is still growing. Rendering it now would make
    // the bar churn — chips appearing one by one and the "+N" count ticking
    // for the whole minute. Show what is actually happening instead, and keep
    // sorting available since it doesn't depend on genres.
    const pct = fill.total > 0 ? Math.round((fill.known / fill.total) * 100) : 0;
    return (
      <div className="flex items-center gap-2 mb-5">
        <span
          className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-dim)]"
          role="status"
        >
          <span className="w-14 progress-track">
            <span
              className="block h-full progress-fill progress-fill-live"
              style={{ width: `${pct}%` }}
            />
          </span>
          {t('library.genre_loading', { known: fill.known, total: fill.total })}
        </span>
      </div>
    );
  }

  if (options.length === 0) {
    // Fill finished and this catalog genuinely has no genre data.
    return null;
  }

  const INLINE = 5;
  const rest = options.filter((n) => !selected.includes(n)).slice(0, INLINE);
  const hidden = options.length - selected.length - rest.length;
  const shown = query.trim()
    ? options.filter((n) => n.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const chip = 'chip ';

  return (
    <div ref={rootRef} tabIndex={-1} className="relative flex items-center gap-2 mb-5 focus:outline-none">
      <div
        role="group"
        aria-label={t('library.genre_filter_aria')}
        className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(90deg,#000_0,#000_calc(100%-26px),transparent_100%)]"
      >
        <button
          type="button"
          aria-pressed={selected.length === 0}
          onClick={onClear}
          className={
chip}
        >
          {t('library.genre_all')}
        </button>
        {/* Chosen genres first — the bar scrolls, and a filter you can't see
            is a filter you'll forget is on. */}
        {selected.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed
            onClick={() => onToggle(name)}
            className="chip chip-on"
          >
            {name}
            <IconX size={10} className="opacity-70" />
          </button>
        ))}
        {rest.map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={false}
            onClick={() => onToggle(name)}
            className="chip"
          >
            {name}
            <span className="count">{counts.get(name)}</span>
          </button>
        ))}
      </div>

      {hidden > 0 && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="chip chip-more"
        >
          {t('library.genre_more', { count: hidden })}
        </button>
      )}

      {open && (
        <div className="absolute left-0 right-0 top-full mt-2 z-30 max-w-[620px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-3)] shadow-2xl overflow-hidden">
          <div className="p-3 border-b border-[var(--color-border-soft)]">
            <label className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[var(--color-dimmer)]">
              <IconSearch size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('library.genre_search')}
                aria-label={t('library.genre_search')}
                autoFocus
                className="w-full bg-transparent border-0 outline-none text-xs text-[var(--color-ink)]"
              />
            </label>
          </div>
          <div className="max-h-60 overflow-y-auto p-2.5 grid grid-cols-[repeat(auto-fill,minmax(174px,1fr))] gap-px">
            {shown.length === 0 ? (
              <p className="p-3 text-xs text-[var(--color-dimmer)]">
                {t('library.genre_none')}
              </p>
            ) : (
              shown.map((name) => {
                const on = selected.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => onToggle(name)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-[#a7bacc] hover:bg-[#16222f] hover:text-[var(--color-ink)] cursor-pointer transition"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        'w-[15px] h-[15px] shrink-0 rounded border grid place-items-center ' +
                        (on
                          ? 'bg-[var(--color-accent)] border-[var(--color-accent)] text-[#04212f]'
                          : 'border-[#2d4256] text-transparent')
                      }
                    >
                      <IconCheckSmall />
                    </span>
                    <span className="truncate">{name}</span>
                    <span className="ml-auto font-[family-name:var(--font-data)] text-[10.5px] text-[var(--color-dimmer)]">
                      {counts.get(name)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-[var(--color-border-soft)] bg-[#101a24]">
            <span className="mr-auto font-[family-name:var(--font-data)] text-[10.5px] text-[var(--color-dimmer)]">
              {t('library.genre_selected', { count: selected.length })}
            </span>
            <button
              type="button"
              onClick={onClear}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[#b3c4d4] hover:border-[#33475b] hover:text-[var(--color-ink)] cursor-pointer transition"
            >
              {t('library.genre_reset')}
            </button>
            <button
              type="button"
              onClick={closePanel}
              className="rounded-md border border-transparent bg-[linear-gradient(180deg,var(--color-accent-lit),var(--color-accent-deep))] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent-fg)] hover:brightness-110 cursor-pointer transition"
            >
              {t('library.genre_done')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Column headers for the system-requirements block. */
function IconMonitorSmall() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </svg>
  );
}

function IconBoltSmall() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m13 2-9 12h7l-1 8 9-12h-7z" />
    </svg>
  );
}

/** Tiny tick used inside the filter checkboxes. */
function IconCheckSmall() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

/**
 * The "···" overflow on an installed catalog card.
 *
 * Holds the per-game actions that don't earn a permanent button: opening the
 * detail page, pinning, and uninstalling. Uninstall lives here rather than on
 * the card face on purpose — it is the one destructive action, and it already
 * asks for confirmation before doing anything.
 */
function CardMenu({
  game,
  pinned,
  onOpenDetail,
  onToggleFavorite,
  onUninstall,
}: {
  game: PublicAccount;
  pinned: boolean;
  onOpenDetail: (appid: number) => void;
  onToggleFavorite?: (appid: number) => void;
  onUninstall?: (appid: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const item =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs cursor-pointer transition text-[#a7bacc] hover:bg-[#16222f] hover:text-[var(--color-ink)]';

  return (
    <span ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('library.more_actions')}
        onClick={() => setOpen((v) => !v)}
        className="w-8 h-[30px] grid place-items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-dim)] hover:border-[#33475b] hover:text-[var(--color-ink)] transition cursor-pointer leading-none"
      >
        ···
      </button>
      {open && (
        // Opens upward: the card sits in a grid and a downward menu would be
        // clipped by the row below.
        <div
          role="menu"
          className="absolute right-0 bottom-[calc(100%+6px)] z-30 min-w-[186px] p-1.5 grid gap-px rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-3)] shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              onOpenDetail(game.appid);
            }}
          >
            <IconInfo size={14} />
            {t('sidebar.about')}
          </button>
          {onToggleFavorite && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                onToggleFavorite(game.appid);
              }}
            >
              <IconStar size={14} filled={pinned} />
              {pinned ? t('library.unpin') : t('library.pin')}
            </button>
          )}
          {game.status === 'installed' || game.status === 'running' ? (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                void window.api.install.openFolder(game.appid);
              }}
            >
              <IconFolder size={14} />
              {t('library.open_folder')}
            </button>
          ) : null}
          {onUninstall && (
            <>
              <div className="h-px bg-[var(--color-border-soft)] my-0.5" />
              <button
                type="button"
                role="menuitem"
                className={
                  item + ' hover:bg-[#2a1512] hover:text-[var(--color-bad)]'
                }
                onClick={() => {
                  setOpen(false);
                  onUninstall(game.appid);
                }}
              >
                <IconTrash size={14} />
                {t('game.uninstall')}
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// ───────────────────────────── Library ─────────────────────────────
function LibraryPage({
  state,
  balance,
  balanceEnabled,
  launchProgress,
  onLaunch,
  onDownload,
  onCancel,
  onRetry,
  onOpenDetail,
  favorites = [],
  onToggleFavorite,
  onUninstall,
  playedByAppid = {},
  sizeByAppid = {},
  pendingStart = {},
  genreFilter,
  setGenreFilter,
  genreFill,
  installedOnly = false,
  genreMap = {},
}: {
  state: LibraryState;
  balance: number;
  balanceEnabled: boolean;
  launchProgress: LaunchProgress | null;
  onLaunch: (appid: number) => void;
  onDownload: (appid: number) => void;
  onCancel: (appid: number) => void;
  onRetry: () => void;
  onOpenDetail: (appid: number) => void;
  /** Pinned appids — drives the star on each card. */
  favorites?: number[];
  onToggleFavorite?: (appid: number) => void;
  onUninstall?: (appid: number) => void;
  /** appid -> seconds played; drives the "most played" sort order. */
  playedByAppid?: Record<number, number>;
  /** Disk footprint per installed appid; missing while the probe is running. */
  sizeByAppid?: Record<number, number>;
  /** appid -> the action the user just clicked, before any real state has
   *  arrived for it. */
  pendingStart?: Record<number, 'download' | 'launch'>;
  /** How far the background genre fill has got, so the filter bar can wait
   *  for it instead of assembling itself chip by chip. */
  genreFill?: { known: number; total: number; done: boolean };
  /** "Библиотека" mode: show only games that are on disk (installed or
   *  currently running). The full catalog stays on the default view. */
  installedOnly?: boolean;
  /** appid → localized genre names; missing appid = not fetched yet. */
  genreMap?: Record<number, string[]>;
  /** Selected genre names. Multi-select: two genres narrow to their
   *  intersection, the way Steam's tag filter behaves. Owned by App so a
   *  genre clicked on the game page can select it on the way here. */
  genreFilter: string[];
  setGenreFilter: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const { t } = useTranslation();
  const stageHint = useStageHint();
  const downloadHint = useDownloadHint();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus the search input when the list is ready. The input only exists in
  // the 'loaded' state, and this component is REUSED across the catalog and
  // library tabs (switching installedOnly doesn't remount it) — so a plain
  // mount-only effect leaves the field unfocused after switching tabs, and
  // after an uninstall (whose refreshLibrary briefly flips to the loading
  // view, unmounting the input). Keying on state.kind + installedOnly
  // restores focus in all of those cases.
  useEffect(() => {
    if (state.kind === 'loaded') searchRef.current?.focus();
  }, [state.kind, installedOnly]);

  if (state.kind === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        {t('library.loading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">{t('library.error_title')}</div>
          <p className="text-xs mb-3">{t('library.error_hint')}</p>
          <button
            onClick={onRetry}
            className="text-xs px-3 py-1.5 rounded-md border border-[var(--color-border)] hover:border-[var(--color-accent)] transition"
          >
            {t('library.retry')}
          </button>
        </div>
      </div>
    );
  }
  const games = installedOnly
    ? state.data.filter(
        (g) => g.status === 'installed' || g.status === 'running'
      )
    : state.data;
  if (games.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">
            {installedOnly
              ? t('library.installed_empty_title')
              : t('library.empty_title')}
          </div>
          <p className="text-xs">
            {installedOnly
              ? t('library.installed_empty_hint')
              : t('library.empty_hint')}
          </p>
        </div>
      </div>
    );
  }
  // Genre chips (catalog only). The option list is the union of genres
  // across games we know so far, most-frequent first — while the background
  // fill is running it simply grows chip by chip; an empty list renders
  // nothing at all, so a cold cache shows the toolbar exactly as before.
  const genreCounts = new Map<string, number>();
  if (!installedOnly) {
    for (const g of games) {
      for (const name of genreMap[g.appid] ?? []) {
        genreCounts.set(name, (genreCounts.get(name) ?? 0) + 1);
      }
    }
  }
  const genreOptions = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  // Selection survives re-renders but auto-degrades if a label vanishes
  // (a language switch renames every genre).
  const canonicalGenre = new Map(
    genreOptions.map((name) => [name.toLocaleLowerCase(), name])
  );
  const activeGenres = genreFilter
    .map((n) => canonicalGenre.get(n.toLocaleLowerCase()))
    .filter((n): n is string => n !== undefined);
  const byGenre =
    activeGenres.length > 0
      ? games.filter((g) => {
          const own = genreMap[g.appid] ?? [];
          return activeGenres.every((n) => own.includes(n));
        })
      : games;

  // Pure client-side filter — instant feedback, no debounce. Matches on
  // name (case-insensitive) and stringified appid for cases where users
  // type digits to disambiguate similarly-named games.
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matched = trimmed
    ? byGenre.filter(
        (g) =>
          g.game_name.toLowerCase().includes(needle) ||
          String(g.appid).includes(trimmed)
      )
    : byGenre;

  // Sort is applied last so it orders exactly what the user is looking at.
  // Every order falls back to the name so the grid never reshuffles between
  // renders for games the comparator considers equal.
  const onDisk = (g: PublicAccount) =>
    g.status === 'installed' || g.status === 'running' ? 0 : 1;
  const byName = (a: PublicAccount, b: PublicAccount) =>
    a.game_name.localeCompare(b.game_name);
  const filtered = [...matched].sort((a, b) => {
    if (sort === 'installed') return onDisk(a) - onDisk(b) || byName(a, b);
    if (sort === 'played') {
      return (playedByAppid[b.appid] ?? 0) - (playedByAppid[a.appid] ?? 0) || byName(a, b);
    }
    return byName(a, b);
  });
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-head">
        <div>
          <span className="kicker">
            {installedOnly
              ? t('library.installed_kicker', { count: games.length })
              : t('library.catalog_kicker', { count: games.length })}
          </span>
          <h1>
            {installedOnly
              ? t('library.installed_heading')
              : t('library.catalog_heading')}
          </h1>
        </div>
        {/* Search and sort travel together: as separate flex children the
            sort wrapped onto its own row the moment the window narrowed,
            leaving a lone dropdown under the field. */}
        <div className="ml-auto flex items-center gap-2.5 min-w-0 flex-1 justify-end">
        <label className="search-field">
          <IconSearch size={14} className="shrink-0" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('library.search_placeholder')}
            aria-label={t('library.search_placeholder')}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Dropdown
          value={sort}
          onChange={(v) => setSort(v)}
          ariaLabel={t('library.sort_aria')}
          align="end"
          className="shrink-0"
          triggerClassName="py-[7px]"
          options={[
            { value: 'name' as SortKey, label: t('library.sort_name') },
            { value: 'installed' as SortKey, label: t('library.sort_installed') },
            { value: 'played' as SortKey, label: t('library.sort_played') },
          ]}
        />
        </div>
      </div>
      <div className="page-content">
      <GenreFilterBar
        options={genreOptions}
        counts={genreCounts}
        selected={activeGenres}
        onToggle={(name) =>
          setGenreFilter((prev) =>
            prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
          )
        }
        onClear={() => setGenreFilter([])}
        fill={genreFill}
      />
      {filtered.length === 0 ? (
        <div className="empty-state text-xs">
          {trimmed
            ? t('library.search_no_results', { query: trimmed })
            : t('library.genre_no_results')}
        </div>
      ) : (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(206px,1fr))] gap-3.5">
        {filtered.map((g) => {
          const isInstalled = g.status === 'installed';
          const isDownloading = g.status === 'downloading';
          const isError = g.status === 'error';
          // balance_enabled=false: the "out of time" affordance disappears
          // entirely — Play is always armed and we never block the user.
          // Active launch flow on THIS card — DD -validate is still running,
          // or we've just transitioned into the steam:// open. While set,
          // the Play button is replaced with a status label (and a percent
          // bar identical to the install card when DD is pulling delta).
          const lp =
            launchProgress && launchProgress.appid === g.appid
              ? launchProgress
              : null;
          const bytes = sizeByAppid[g.appid];
          const sizeLabel = bytes != null ? formatBytes(bytes) : null;
          return (
            <div
              key={g.appid}
              className={
                'group rounded-[10px] overflow-hidden border transition ' +
                (g.locked
                  ? 'border-[var(--color-border-soft)] bg-[var(--color-surface)] opacity-55'
                  : 'border-[var(--color-border-soft)] bg-[var(--color-surface-2)] hover:-translate-y-0.5 hover:border-[#2f4557] hover:shadow-[0_18px_30px_-20px_#000]')
              }
            >
              <div className="relative">
                {/* State reads as a hairline over the art before any label is
                    parsed: green installed, blue working, red failed. */}
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-0.5 z-10"
                  style={{
                    background: isInstalled
                      ? 'var(--color-ok)'
                      : isDownloading
                        ? 'var(--color-accent)'
                        : isError
                          ? 'var(--color-bad)'
                          : 'transparent',
                  }}
                />
                {onToggleFavorite && !g.locked && (
                  <button
                    type="button"
                    onClick={() => onToggleFavorite(g.appid)}
                    title={
                      favorites.includes(g.appid)
                        ? t('library.unpin')
                        : t('library.pin')
                    }
                    aria-label={
                      favorites.includes(g.appid)
                        ? t('library.unpin')
                        : t('library.pin')
                    }
                    aria-pressed={favorites.includes(g.appid)}
                    className={
                      'absolute top-2 right-2 z-10 w-7 h-7 grid place-items-center rounded-lg border transition cursor-pointer ' +
                      'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ' +
                      (favorites.includes(g.appid)
                        ? 'opacity-100 text-[var(--color-gold)] border-[#6a5220] bg-[#1b1408]/85'
                        : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--color-dim)] border-[#24384a] bg-[#060a0f]/75 hover:text-[var(--color-ink)] hover:border-[var(--color-accent)]')
                    }
                  >
                    <IconStar size={14} filled={favorites.includes(g.appid)} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenDetail(g.appid)}
                  aria-label={g.game_name}
                  className="block w-full aspect-[460/215] bg-[#0a1119] flex items-center justify-center relative overflow-hidden cursor-pointer p-0 border-0"
                >
                <GameCover appid={g.appid} name={g.game_name} src={g.logoUrl} />
                {isDownloading && (
                  <div
                    className="absolute inset-x-0 bottom-0 h-1 bg-black/40 progress-track rounded-none"
                    role="progressbar"
                    aria-valuenow={aggregateDownloadPercent(
                      g.downloadPercent ?? 0,
                      g.downloadStage
                    )}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="progress-fill progress-fill-live"
                      style={{
                        width: `${aggregateDownloadPercent(
                          g.downloadPercent ?? 0,
                          g.downloadStage
                        )}%`,
                      }}
                    />
                  </div>
                )}
                {lp && lp.phase === 'updating' && (
                  <div
                    className="absolute inset-x-0 bottom-0 h-1 bg-black/40 progress-track rounded-none"
                    role="progressbar"
                    aria-valuenow={lp.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="progress-fill progress-fill-live"
                      style={{ width: `${lp.percent}%` }}
                    />
                  </div>
                )}
                </button>
                {g.locked && (
                  <div className="lock-veil">
                    <IconLock size={18} />
                    {t('library.locked_hint', { level: g.min_trust_level })}
                  </div>
                )}
              </div>
              <div className="px-3 pt-2.5 pb-3 grid gap-2">
                <div
                  className="font-[family-name:var(--font-display)] text-sm font-semibold leading-[1.2] truncate"
                  title={g.game_name}
                >
                  {g.game_name}
                </div>
                {/* State line: a coloured dot plus the word for what this game
                    is doing. Reads at a glance without parsing the buttons. */}
                <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-[family-name:var(--font-data)] text-[9.5px] uppercase tracking-[0.12em] min-w-0">
                  {g.locked ? (
                    <span className="text-[var(--color-dimmer)]">
                      {t('library.state_locked')}
                    </span>
                  ) : (
                    <>
                      <span
                        aria-hidden="true"
                        className="w-1.5 h-1.5 rounded-full"
                        style={{
                          background: isInstalled
                            ? 'var(--color-ok)'
                            : isDownloading
                              ? 'var(--color-accent)'
                              : isError
                                ? 'var(--color-bad)'
                                : '#3a4b5c',
                        }}
                      />
                      <span
                        className={
                          isInstalled
                            ? 'text-[var(--color-ok)]'
                            : isDownloading
                              ? 'text-[var(--color-accent)]'
                              : isError
                                ? 'text-[var(--color-bad)]'
                                : 'text-[var(--color-dim)]'
                        }
                      >
                        {isInstalled
                          ? t('library.state_installed')
                          : isDownloading
                            ? `${t('library.state_downloading')} ${aggregateDownloadPercent(
                                g.downloadPercent ?? 0,
                                g.downloadStage
                              ).toFixed(0)}%`
                            : isError
                              ? t('library.state_error')
                              : t('library.state_not_installed')}
                      </span>
                    </>
                  )}
                </div>
                {sizeLabel && (
                  <span className="font-[family-name:var(--font-data)] text-[10.5px] tabular-nums text-[var(--color-dimmer)] shrink-0">
                    {sizeLabel}
                  </span>
                )}
                </div>
                {isDownloading && (
                  <div className="progress-track">
                    <div
                      className="progress-fill progress-fill-live"
                      style={{
                        width: `${aggregateDownloadPercent(
                          g.downloadPercent ?? 0,
                          g.downloadStage
                        )}%`,
                      }}
                    />
                  </div>
                )}
                {!g.locked && (
                <div className="flex items-center gap-2">
                  {pendingStart[g.appid] && !lp ? (
                    <BusyButton
                      className="btn-m btn-m-primary flex-1"
                      label={t('library.starting')}
                    />
                  ) : lp ? (
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-slate-500 truncate">
                        {lp.phase === 'checking'
                          ? t('game.checking_updates')
                          : lp.phase === 'updating'
                            ? t('game.downloading_update')
                            : lp.phase === 'patching'
                              ? t('game.patching_drm')
                              : t('game.launching')}
                      </div>
                      {lp.phase === 'updating' && (
                        <div className="text-xs text-slate-400 tabular-nums">
                          {lp.percent.toFixed(1)}%
                        </div>
                      )}
                    </div>
                  ) : isInstalled ? (
                    <>
                      <button onClick={() => onLaunch(g.appid)} className="btn-m btn-m-primary flex-1">
                        {t('library.play')}
                      </button>
                      <CardMenu
                        game={g}
                        pinned={favorites.includes(g.appid)}
                        onOpenDetail={onOpenDetail}
                        onToggleFavorite={onToggleFavorite}
                        onUninstall={onUninstall}
                      />
                    </>
                  ) : isDownloading ? (
                    <button
                      onClick={() => onCancel(g.appid)}
                      aria-label={t('library.cancel_aria')}
                      className="btn-m btn-m-danger flex-1"
                    >
                      {t('gameDetail.cancel')}
                    </button>
                  ) : isError ? (
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      {(() => {
                        const label =
                          downloadHint(
                            null,
                            g.downloadError,
                            g.downloadErrorPlatforms
                          ) ?? t('downloads.failed_label');
                        return (
                          <div
                            className="text-[10px] text-[var(--color-bad)] truncate"
                            title={label}
                          >
                            {label}
                          </div>
                        );
                      })()}
                      <button onClick={() => onDownload(g.appid)} className="btn-m btn-m-primary">
                        {t('library.retry')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => onDownload(g.appid)}
                      className="btn-m flex-1"
                    >
                      {t('library.install')}
                    </button>
                  )}
                </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
      </div>
    </div>
  );
}

// ───────────────────────────── Downloads ─────────────────────────────
/**
 * Filtered view of the library showing only items that are mid-download or
 * recently failed. Reuses LibraryState — no separate fetch — so the cards
 * here always agree with the library cards underneath.
 */
function DownloadsPage({
  state,
  onCancel,
  onRetry,
  onRefreshLibrary,
}: {
  state: LibraryState;
  onCancel: (appid: number) => void;
  onRetry: (appid: number) => void;
  onRefreshLibrary: () => void;
}) {
  const { t } = useTranslation();
  const stageHint = useStageHint();
  const downloadHint = useDownloadHint();
  if (state.kind === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        {t('library.loading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">{t('library.error_title')}</div>
          <button
            onClick={onRefreshLibrary}
            className="text-xs px-3 py-1.5 rounded-md border border-[var(--color-border)] hover:border-[var(--color-accent)] transition"
          >
            {t('library.retry')}
          </button>
        </div>
      </div>
    );
  }
  const active = state.data.filter(
    (g) => g.status === 'downloading' || g.status === 'error'
  );
  if (active.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">{t('downloads.empty_title')}</div>
          <p className="text-xs">{t('downloads.empty_hint')}</p>
        </div>
      </div>
    );
  }
  const downloading = active.filter((g) => g.status === 'downloading');
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-head">
        <div>
          <span className="kicker">
            {t('downloads.kicker', { count: downloading.length })}
          </span>
          <h1>{t('downloads.heading')}</h1>
        </div>
        {downloading.length > 0 && (
          <button
            type="button"
            className="btn-m ml-auto"
            onClick={() => downloading.forEach((g) => onCancel(g.appid))}
          >
            {t('downloads.stop_all')}
          </button>
        )}
      </div>
      <div className="page-content">
      <div className="rows">
        {active.map((g) => {
          const isDownloading = g.status === 'downloading';
          const percent = g.downloadPercent ?? 0;
          // Single bar spanning the whole multi-depot install — DD's raw
          // percent resets to 0 at each depot boundary, but the user
          // cares about the whole-game ETA, not the per-depot one.
          const aggregatePct = isDownloading
            ? aggregateDownloadPercent(percent, g.downloadStage)
            : 0;
          // Bytes label below the bar — "X MB / Y MB" when we have both,
          // "X MB" alone when we only know downloaded so far. Hidden in
          // the very first ticks before the first 1.5 s sample arrives.
          // Show only the amount downloaded so far. We deliberately drop the
          // "/ total" — the only total available mid-download is a running
          // estimate (or appinfo's max-depot size), both of which overshoot
          // the real install and made the card read like "1.97 GB / 21 GB"
          // for a ~2 GB game. The percent is shown separately and is exact.
          const bytesLabel =
            isDownloading && g.downloadBytesDownloaded !== null
              ? formatBytes(g.downloadBytesDownloaded)
              : null;
          // Prefer the email-Guard fallback hint over the generic stage
          // when a poll is in flight; otherwise fall through to the stage.
          const dh = downloadHint(
            g.guardHint,
            g.downloadError,
            g.downloadErrorPlatforms
          );
          const hint = dh ?? stageHint(g.downloadStage);
          // Map known downloader error codes to localized labels in the
          // failed state. Unknown errors fall back to the generic message.
          const failedLabel =
            downloadHint(null, g.downloadError, g.downloadErrorPlatforms) ??
            t('downloads.failed_label');
          return (
            // Row layout from the mockup: cover, then name over a live bar
            // and its stage line, with the numbers held to the right edge and
            // the action last. The cover matters — with several downloads
            // queued, the art is what you actually recognise.
            <div
              key={g.appid}
              className={
                'list-row ' +
                (isDownloading
                  ? ''
                  : 'border-[color-mix(in_oklch,var(--color-bad)_35%,var(--color-border-soft))]!')
              }
            >
              <div className="relative w-[84px] h-10 shrink-0 rounded-md overflow-hidden">
                <GameCover appid={g.appid} name={g.game_name} src={g.logoUrl} />
              </div>
              <div className="flex-1 min-w-0 grid gap-1.5">
                <div className="row-name truncate" title={g.game_name}>
                  {g.game_name}
                </div>
                {isDownloading && (
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-valuenow={aggregatePct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="progress-fill progress-fill-live"
                      style={{ width: `${aggregatePct}%` }}
                    />
                  </div>
                )}
                <div
                  className={
                    'row-sub truncate ' +
                    (isDownloading ? '' : 'text-[var(--color-bad)]!')
                  }
                  title={isDownloading ? hint ?? undefined : failedLabel}
                >
                  {isDownloading
                    ? [hint, bytesLabel].filter(Boolean).join(' · ')
                    : failedLabel}
                </div>
              </div>
              <div className="row-num shrink-0">
                {isDownloading ? `${aggregatePct.toFixed(1)}%` : '—'}
              </div>
              {isDownloading ? (
                <button
                  onClick={() => onCancel(g.appid)}
                  className="btn-m btn-m-danger shrink-0"
                >
                  {t('gameDetail.cancel')}
                </button>
              ) : (
                <button
                  onClick={() => onRetry(g.appid)}
                  className="btn-m btn-m-primary shrink-0"
                >
                  {t('library.retry')}
                </button>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

type TasksState =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: TaskRead[] }
  | { kind: 'error' };

// ───────────────────────────── Tasks ─────────────────────────────
function TasksPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<TasksState>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const list = await window.api.tasks.list();
      setState({ kind: 'loaded', data: list });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openTaskUrl = useCallback((task: TaskRead) => {
    if (task.description && /^https?:\/\//i.test(task.description)) {
      void window.api.shell.openExternal(task.description);
    }
  }, []);

  const completeTask = useCallback(async (task: TaskRead) => {
    setBusyId(task.id);
    const res = await window.api.tasks.complete(task.id);
    setBusyId(null);
    if (res.ok) {
      setState((prev) =>
        prev.kind === 'loaded'
          ? {
              kind: 'loaded',
              data: prev.data.map((x) =>
                x.id === task.id ? { ...x, status: 'completed' } : x
              ),
            }
          : prev
      );
    } else if (window.api.debug.loggingEnabled) {
      console.warn('[tasks] complete failed:', res.error);
    }
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        {t('tasks.loading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">{t('tasks.error_title')}</div>
          <p className="text-xs mb-3">{t('tasks.error_hint')}</p>
          <button
            onClick={refresh}
            className="text-xs px-3 py-1.5 rounded-md border border-[var(--color-border)] hover:border-[var(--color-accent)] transition"
          >
            {t('library.retry')}
          </button>
        </div>
      </div>
    );
  }
  const tasks = state.data;
  const pending = tasks.filter((task) => task.status === 'pending');
  const done = tasks.filter((task) => task.status === 'completed');

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-head">
        <div>
          <span className="kicker">{t('tasks.kicker')}</span>
          <h1>{t('tasks.heading')}</h1>
        </div>
      </div>
      <div className="page-content max-w-[840px]">
        <h3 className="sec-title">{t('tasks.active_section')}</h3>
        {pending.length === 0 ? (
          <div className="empty-state text-xs">{t('tasks.active_empty')}</div>
        ) : (
          <div className="rows">
            {pending.map((task) => (
              <div key={task.id} className="list-row">
                <div className="flex-1 min-w-0 grid gap-1">
                  <div className="row-name truncate">{task.title}</div>
                  {task.description && (
                    <div className="row-sub truncate">{task.description}</div>
                  )}
                </div>
                {task.description && /^https?:\/\//i.test(task.description) && (
                  <button onClick={() => openTaskUrl(task)} className="btn-m shrink-0">
                    {t('tasks.open')}
                  </button>
                )}
                <button
                  onClick={() => completeTask(task)}
                  disabled={busyId === task.id}
                  className="btn-m btn-m-primary shrink-0"
                >
                  {busyId === task.id ? t('tasks.completing') : t('tasks.complete')}
                </button>
              </div>
            ))}
          </div>
        )}

        {done.length > 0 && (
          <>
            <h3 className="sec-title mt-7">{t('tasks.completed_section')}</h3>
            <div className="rows">
              {done.map((task) => (
                <div key={task.id} className="list-row opacity-55">
                  <div className="row-name line-through truncate">{task.title}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type StatsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; data: Array<{ appid: number; name: string; seconds: number }> }
  | { kind: 'error' };

// ───────────────────────────── Stats ─────────────────────────────
function StatsPage() {
  const { t } = useTranslation();
  const formatHoursMinutes = useFormatHoursMinutes();
  const [state, setState] = useState<StatsState>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const rows = await window.api.stats.gameTotals();
      setState({ kind: 'loaded', data: rows });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.kind === 'loading') {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">
        {t('stats.loading')}
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">{t('stats.error_title')}</div>
          <button
            onClick={refresh}
            className="mt-3 text-xs px-3 py-1.5 rounded-md border border-[var(--color-border)] hover:border-[var(--color-accent)] transition"
          >
            {t('library.retry')}
          </button>
        </div>
      </div>
    );
  }
  const rows = state.data;
  if (rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-slate-400 max-w-md">
          <div className="text-sm font-medium mb-2">{t('stats.empty_title')}</div>
          <p className="text-xs">{t('stats.empty_hint')}</p>
        </div>
      </div>
    );
  }
  const total = rows.reduce((a, r) => a + r.seconds, 0);
  // Bars are relative to the most-played title, not to the total: with a long
  // tail every bar would round to nothing and the column would read as empty.
  const peak = Math.max(...rows.map((r) => r.seconds), 1);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="page-head">
        <div>
          <span className="kicker">{t('stats.kicker')}</span>
          <h1>{t('stats.heading')}</h1>
        </div>
      </div>
      <div className="page-content max-w-[840px]">
        <div className="stat-hero">
          <b>{formatHoursMinutes(total)}</b>
          <span>{t('stats.total_played')}</span>
        </div>
        <div className="rows">
          {rows.map((r) => (
            <div key={r.appid} className="list-row">
              <div className="relative w-[84px] h-10 shrink-0 rounded-md overflow-hidden">
                <GameCover appid={r.appid} name={r.name} src={null} />
              </div>
              <div className="flex-1 min-w-0 grid gap-1.5">
                <div className="row-name truncate" title={r.name}>
                  {r.name}
                </div>
                <div className="stat-bar">
                  <span style={{ width: `${(r.seconds / peak) * 100}%` }} />
                </div>
              </div>
              <div className="row-num shrink-0">{formatHoursMinutes(r.seconds)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────── SafeHtml ─────────────────────────────
/**
 * Minimal sanitizer for the HTML Steam returns in `detailed_description`
 * and `pc_requirements.minimum`. Steam content is mostly `<p>`, `<br>`,
 * `<strong>`, `<em>`, `<a>`, `<img>`, `<ul>`, `<li>` — we strip everything
 * dangerous. Not as bulletproof as DOMPurify, but the source is trusted-ish
 * and we explicitly avoided adding a new dependency.
 *
 * Stripped: <script>, <iframe>, <object>, <embed>, <style>, <link>, <form>,
 * <input>, <button>, <select>, <textarea> (entire blocks). All `on*=` event
 * attributes. `href="javascript:..."` URLs are neutralised to `href="#"`.
 */

/**
 * Try to lift the system-requirements list into a structured
 * `[{ label, value }]` shape so we can render it as a real table.
 *
 * Steam's `pc_requirements.minimum` / `.recommended` is HTML of the form
 *
 *     <ul>
 *       <li><strong>OS:</strong> Windows 10</li>
 *       <li><strong>Processor:</strong> Intel i5</li>
 *       ...
 *     </ul>
 *
 * The `<strong>` prefix carries the row label; everything that follows
 * (still inside the `<li>`) is the value. The parser returns `null`
 * when the structure isn't recognisable — caller falls back to the
 * raw SafeHtml rendering without left padding.
 *
 * "Recognisable" = at least two rows where the label looks like a
 * proper noun (starts with a capital, no whitespace inside, ends with
 * `:`). Filters out Steam's occasional decorative text that contains
 * <strong> but isn't actually a requirement row.
 */
type ReqRow = { label: string; value: string };

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRequirements(html: string): ReqRow[] | null {
  // Iterate every <li>…</li>. Greedy across newlines so a multi-line
  // value (Steam occasionally wraps on long lines) still falls into
  // the same row.
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  const rows: ReqRow[] = [];
  let match: RegExpExecArray | null;
  while ((match = liRe.exec(html)) !== null) {
    const inner = match[1] ?? '';
    // Capture the leading <strong>…</strong> as the label.
    const strongRe = /<strong\b[^>]*>([\s\S]*?)<\/strong>/i;
    const sm = strongRe.exec(inner);
    if (!sm) continue;
    const label = stripTags(sm[1] ?? '').replace(/:$/, '').trim();
    if (!label) continue;
    // Value = everything in the <li> AFTER the <strong> block. If the
    // strong consumes the entire <li> (Steam's "Additional Notes"
    // pattern), the value is just the same label so the row still
    // renders sensibly.
    const value = stripTags(inner.slice(sm.index + sm[0].length));
    rows.push({
      label,
      value: value || stripTags(sm[1] ?? '').replace(/:$/, '').trim(),
    });
  }
  // Two-row minimum: a single requirement is unusual and is more
  // likely a parser accident than real sysreq data.
  if (rows.length < 2) return null;
  // Labels must look like labels rather than prose, so a <strong> inside
  // Steam's marketing copy doesn't get mistaken for a requirements table.
  //
  // This used to reject any label containing a space, which threw away the
  // whole table whenever ONE row was "Additional Notes" or "Video Card" —
  // Half-Life parsed as raw HTML while Left 4 Dead 2 rendered correctly. It
  // was worse in localized copy, where "Оперативная память" made almost every
  // game fall back. A short, few-word, non-sentence label is the real test.
  const valid = rows.every(
    (r) =>
      r.label.length > 0 &&
      r.label.length <= 40 &&
      /^\S/.test(r.label) &&
      r.label.split(/\s+/).length <= 4 &&
      !/[.!?]$/.test(r.label)
  );
  return valid ? rows : null;
}
function SafeHtml({ html }: { html: string }) {
  const cleaned = html
    // Drop dangerous block tags entirely (including their inner content).
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    // Strip remaining standalone tag forms for the same elements + form
    // controls. Ranges of opening / closing tags without enforced content.
    .replace(
      /<\/?(?:script|iframe|object|embed|style|link|form|input|button|select|textarea)\b[^>]*>/gi,
      ''
    )
    // Strip on* event handler attributes.
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    // Neutralise javascript: URLs in href attributes.
    .replace(/href\s*=\s*"javascript:[^"]*"/gi, 'href="#"')
    .replace(/href\s*=\s*'javascript:[^']*'/gi, "href='#'");
  return (
    <div className="safe-html" dangerouslySetInnerHTML={{ __html: cleaned }} />
  );
}

/**
 * Structured system-requirements table. Renders a clean two-column
 * "OS / Windows 10" grid when the parser lifts a sensible structure
 * from the HTML; otherwise renders the raw HTML but without the
 * default <ul> left-padding (Steam's bullet glyphs look wrong in a
 * dark UI without the original list-marker CSS).
 */
function RequirementsBlock({ html }: { html: string }) {
  const rows = parseRequirements(html);
  if (rows) {
    return (
      <table className="game-detail-reqs-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  // Fallback: render the HTML, but strip the <ul> left padding so the
  // markers sit flush with the heading. We can't safely rewrite the
  // HTML, so the surrounding `.game-detail-reqs-fallback` class hides
  // the padding via descendant selector instead.
  return (
    <div className="game-detail-reqs-fallback">
      <SafeHtml html={html} />
    </div>
  );
}

// ───────────────────────────── GameDetailPage ─────────────────────────────
/**
 * Steam-Store-style detail view for a library entry. Hero banner with the
 * game's background art, action button (install / play / cancel) reusing
 * the same handlers as the library card, then trailers, screenshots,
 * description, genres, and PC requirements. No reviews, awards, prices,
 * or store recommendations — explicitly out of scope.
 */
/**
 * Screenshot strip that pages instead of wrapping.
 *
 * Steam returns a dozen-plus shots; a fixed grid could only ever show the
 * first few, and wrapping them pushed the description off the screen. This is
 * a snap-scrolling track with arrows that disable at each end, so the strip
 * costs one row no matter how many shots a game ships. Clicking still opens
 * the existing lightbox, which owns keyboard paging.
 */
function ScreenshotCarousel({
  shots,
  onOpen,
}: {
  shots: Array<{ id: string | number; path_thumbnail?: string; path_full?: string }>;
  onOpen: (index: number) => void;
}) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const sync = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setAtStart(el.scrollLeft < 8);
    setAtEnd(el.scrollLeft > el.scrollWidth - el.clientWidth - 8);
  }, []);

  useEffect(() => {
    sync();
    const el = trackRef.current;
    if (!el) return;
    // Re-check on resize too: the visible count changes with the window, so
    // "at the end" can become false without any scrolling.
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sync, shots.length]);

  const page = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <div className="relative">
      <div
        ref={trackRef}
        onScroll={sync}
        className="flex gap-2.5 overflow-x-auto snap-x snap-mandatory pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {shots.map((s, idx) => {
          const thumb = s.path_thumbnail || s.path_full;
          if (!thumb) return null;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onOpen(idx)}
              // Without this every thumbnail announces as a bare "button", and
              // a game with twenty screenshots becomes twenty identical stops.
              aria-label={t('gameDetail.screenshot_n', { n: idx + 1 })}
              className="shrink-0 basis-[calc((100%-30px)/4)] snap-start aspect-video rounded-lg overflow-hidden border border-[var(--color-border-soft)] hover:border-[var(--color-accent)] transition cursor-pointer p-0"
            >
              <img
                src={thumb}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
          );
        })}
      </div>
      {/* Both arrows always render. Unmounting the one at the end of the strip
          destroyed the element the user was standing on, dumping focus to
          <body> mid-way through paging; aria-disabled keeps it in the tab
          order while making it inert. */}
      <button
        type="button"
        onClick={() => page(-1)}
        aria-label={t('gameDetail.prev_screenshot')}
        aria-disabled={atStart}
        className="absolute -left-2.5 top-1/2 -mt-[17px] w-[34px] h-[34px] grid place-items-center rounded-full border border-[var(--color-border)] bg-[#0b131b]/90 backdrop-blur text-[var(--color-ink)] hover:border-[var(--color-accent)] transition cursor-pointer aria-disabled:opacity-0 aria-disabled:pointer-events-none"
      >
        <IconChevronLeft size={15} />
      </button>
      <button
        type="button"
        onClick={() => page(1)}
        aria-label={t('gameDetail.next_screenshot')}
        aria-disabled={atEnd}
        className="absolute -right-2.5 top-1/2 -mt-[17px] w-[34px] h-[34px] grid place-items-center rounded-full border border-[var(--color-border)] bg-[#0b131b]/90 backdrop-blur text-[var(--color-ink)] hover:border-[var(--color-accent)] transition cursor-pointer aria-disabled:opacity-0 aria-disabled:pointer-events-none"
      >
        <IconChevronRight size={15} />
      </button>
    </div>
  );
}

function GameDetailPage({
  account,
  balance,
  balanceEnabled,
  launchProgress,
  favorite = false,
  onBack,
  onLaunch,
  onDownload,
  onCancel,
  onUninstall,
  onToggleFavorite,
  onOpenGenre,
  catalogGenres,
  pending = false,
}: {
  account: PublicAccount;
  balance: number;
  balanceEnabled: boolean;
  launchProgress: LaunchProgress | null;
  /** Whether this game is pinned to the sidebar rail. */
  favorite?: boolean;
  onBack: () => void;
  onLaunch: (appid: number) => void;
  onDownload: (appid: number) => void;
  onCancel: (appid: number) => void;
  onUninstall: (appid: number) => void;
  onToggleFavorite?: (appid: number) => void;
  /** Show the catalog filtered to this genre. */
  onOpenGenre?: (name: string) => void;
  /** The user clicked Play or Install and nothing visible has happened yet. */
  pending?: boolean;
  /** Genre labels the catalog can actually filter by, lowercased. Steam's
   *  appdetails and the catalog's own genre service don't always word a
   *  genre the same way, and a pill the catalog can't match would navigate
   *  to an unfiltered list — a dead link. Those render as plain pills. */
  catalogGenres?: Set<string>;
}) {
  const { t, i18n } = useTranslation();
  const stageHint = useStageHint();
  const downloadHint = useDownloadHint();
  const [data, setData] = useState<SteamAppDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Index into the hero-source fallback list; advanced by the <img>'s
  // onError. Reset whenever the game (or its just-arrived appdetails)
  // changes so a new banner starts from the best source.
  const [heroIdx, setHeroIdx] = useState(0);
  // Steam announcements. Decoration: an empty list (no news, or a failed
  // fetch — main can'''t tell them apart either) just hides the section.
  const [news, setNews] = useState<SteamNewsItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    setNews([]);
    void window.api.steam?.news(account.appid).then((items) => {
      if (!cancelled) setNews(items);
    });
    return () => {
      cancelled = true;
    };
  }, [account.appid]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    setHeroIdx(0);
    void window.api.steam
      ?.appDetails(account.appid, i18n.language)
      .then((res) => {
        if (cancelled) return;
        setData((res as SteamAppDetails) ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account.appid, i18n.language]);

  // Close the lightbox with Escape; ← / → step through the screenshot
  // list when there are siblings. Matches the lightbox arrow buttons so
  // keyboard-only users get the same navigation as mouse users.
  useEffect(() => {
    if (lightbox === null) return;
    const total = data?.screenshots?.length ?? 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLightbox(null);
        return;
      }
      if (total <= 1) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setLightbox((idx) =>
          idx === null ? null : (idx - 1 + total) % total
        );
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setLightbox((idx) =>
          idx === null ? null : (idx + 1) % total
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, data?.screenshots?.length]);

  const isInstalled = account.status === 'installed';
  const isDownloading = account.status === 'downloading';
  const isError = account.status === 'error';
  // Mirror LibraryPage: when the balance subsystem is disabled, the Play
  // button is never gated by remaining seconds.
  // Hero banner sources, best-size first. Steam's 1920×620 library_hero
  // (built from the appid) is the right size for this banner; older titles
  // (e.g. Republic Commando) 404 on it, so we fall through the appdetails
  // art. header_image is only 460×215 and upscales into a pixelated blur —
  // it's the last resort. An <img> + onError walks this list so a 404 or a
  // broken URL drops to the next candidate instead of leaving a stretched
  // low-res background.
  const heroSources = [
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${account.appid}/library_hero.jpg`,
    data?.background_raw,
    data?.background,
    // First screenshot before header_image — for old titles with no hero
    // art (e.g. Republic Commando) a full-res screenshot looks far better
    // than the 460×215 header upscaled into a pixelated blur.
    data?.screenshots?.[0]?.path_full,
    data?.header_image,
    account.logoUrl,
  ].filter((s): s is string => !!s);
  const heroSrc = heroSources[heroIdx];

  const renderAction = () => {
    // The click has landed but nothing visible has happened yet — see
    // pendingStart in App. Only the primary control changes; the row keeps
    // its other buttons and its geometry.
    const busy = pending && !(launchProgress && launchProgress.appid === account.appid);
    if (account.locked) {
      return (
        <div className="text-xs text-slate-400">
          {t('library.locked_hint', { level: account.min_trust_level })}
        </div>
      );
    }
    if (isInstalled) {
      const lp =
        launchProgress && launchProgress.appid === account.appid
          ? launchProgress
          : null;
      if (lp) {
        return (
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <div className="text-[11px] text-slate-300 truncate">
                {lp.phase === 'checking'
                  ? t('game.checking_updates')
                  : lp.phase === 'updating'
                    ? t('game.downloading_update')
                    : lp.phase === 'patching'
                      ? t('game.patching_drm')
                      : t('game.launching')}
              </div>
              {lp.phase === 'updating' && (
                <div className="text-sm tabular-nums text-slate-200">
                  {lp.percent.toFixed(1)}%
                </div>
              )}
            </div>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-2">
          {busy ? (
            <BusyButton className="btn-play" label={t('library.starting')} />
          ) : (
            <button onClick={() => onLaunch(account.appid)} className="btn-play">
              <IconPlay size={14} />
              {t('library.play')}
            </button>
          )}
          <button
            onClick={() => onUninstall(account.appid)}
            className="btn-play btn-play-secondary btn-play-danger"
            title={t('game.uninstall')}
          >
            {t('game.uninstall')}
          </button>
        </div>
      );
    }
    if (isDownloading) {
      const pct = account.downloadPercent ?? 0;
      const aggPct = aggregateDownloadPercent(pct, account.downloadStage);
      // Amount downloaded only — no "/ total": the mid-download total is an
      // overshooting estimate (see the DownloadsPage note), and the exact
      // percent is already shown alongside.
      const bytesLabel =
        account.downloadBytesDownloaded !== null
          ? formatBytes(account.downloadBytesDownloaded)
          : null;
      const dh = downloadHint(
        account.guardHint,
        account.downloadError,
        account.downloadErrorPlatforms
      );
      const sh = stageHint(account.downloadStage);
      const hint = dh ?? sh;
      return (
        // Fixed-width block so a changing file name (validation / download
        // stage label) truncates inside the flex-1 left column instead of
        // resizing the row and shoving the Cancel button left↔right. Cancel
        // stays pinned to the right of the % / byte readout.
        <div className="flex items-center gap-3 w-72 max-w-full">
          <div className="flex-1 min-w-0">
            {hint && (
              <div className="text-[11px] text-slate-300 truncate" title={hint}>
                {hint}
              </div>
            )}
            <div className="text-sm tabular-nums text-slate-200">
              {aggPct.toFixed(1)}%
            </div>
            {bytesLabel && (
              <div className="text-[10px] font-mono tabular-nums text-slate-500 truncate">
                {bytesLabel}
              </div>
            )}
          </div>
          <button
            onClick={() => onCancel(account.appid)}
            className="btn-play btn-play-secondary btn-play-danger shrink-0"
          >
            {t('gameDetail.cancel')}
          </button>
        </div>
      );
    }
    if (isError) {
      const label =
        downloadHint(
          null,
          account.downloadError,
          account.downloadErrorPlatforms
        ) ?? t('downloads.failed_label');
      return (
        <div className="flex flex-col gap-2 items-start">
          <div className="text-xs text-[var(--color-bad)]" title={label}>
            {label}
          </div>
          {busy ? (
            <BusyButton className="btn-play" label={t('library.starting')} />
          ) : (
            <button onClick={() => onDownload(account.appid)} className="btn-play">
              {t('library.retry')}
            </button>
          )}
        </div>
      );
    }
    if (busy) {
      return (
        <BusyButton
          className="btn-play btn-play-secondary"
          label={t('library.starting')}
        />
      );
    }
    return (
      <button
        onClick={() => onDownload(account.appid)}
        className="btn-play btn-play-secondary"
      >
        <IconDownload size={14} />
        {t('gameDetail.download')}
      </button>
    );
  };

  const fallbackName = account.game_name;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="game-detail-hero">
        {heroSrc && (
          <img
            className="game-detail-hero-img"
            src={heroSrc}
            alt=""
            // A 404 (old title with no library_hero) or broken URL falls
            // through to the next, lower-res source rather than leaving a
            // blank/stretched banner.
            onError={() => setHeroIdx((i) => i + 1)}
          />
        )}
        <button
          type="button"
          className="game-detail-back"
          onClick={onBack}
          aria-label={t('gameDetail.back')}
        >
          ← {t('gameDetail.back')}
        </button>
        <div className="game-detail-hero-content">
          <span className="kicker">
            {isInstalled
              ? t('library.state_installed')
              : isDownloading
                ? t('library.state_downloading')
                : isError
                  ? t('library.state_error')
                  : account.locked
                    ? t('library.state_locked')
                    : t('library.state_not_installed')}
          </span>
          <h1>{data?.name ?? fallbackName}</h1>
          {data?.genres && data.genres.length > 0 && (
            <div className="game-detail-tags">
              {data.genres.map((g) =>
                onOpenGenre && catalogGenres?.has(g.description.toLocaleLowerCase()) ? (
                  <button
                    key={g.id}
                    type="button"
                    className="tag tag-link"
                    onClick={() => onOpenGenre(g.description)}
                    title={t('gameDetail.browse_genre', { genre: g.description })}
                  >
                    {g.description}
                  </button>
                ) : (
                  <span key={g.id} className="tag">
                    {g.description}
                  </span>
                )
              )}
            </div>
          )}
          <div className="game-detail-meta">
            {data?.developers && data.developers.length > 0 && (
              <span>
                {t('gameDetail.developer')}: {data.developers.join(', ')}
              </span>
            )}
            {data?.publishers && data.publishers.length > 0 && (
              <span>
                {t('gameDetail.publisher')}: {data.publishers.join(', ')}
              </span>
            )}
            {data?.release_date?.date && (
              <span>
                {t('gameDetail.released')}: {data.release_date.date}
              </span>
            )}
          </div>
          <div className="game-detail-action">
            {renderAction()}
            {onToggleFavorite && (!account.locked || favorite) && (
              <button
                type="button"
                onClick={() => onToggleFavorite(account.appid)}
                aria-pressed={favorite}
                title={favorite ? t('library.unpin') : t('library.pin')}
                className={
                  'btn-play btn-play-secondary' + (favorite ? ' btn-play-on' : '')
                }
              >
                <IconStar
                  size={14}
                  filled={favorite}
                  className={favorite ? 'text-[var(--color-gold)]' : undefined}
                />
                {favorite ? t('library.unpin') : t('library.pin')}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="game-detail">

        {loading && (
          <div className="text-sm text-slate-400 py-6">
            {t('gameDetail.loading')}
          </div>
        )}

        {!loading && !data && (
          <p className="text-sm text-slate-400 py-6">
            {t('gameDetail.unavailable')}
          </p>
        )}


        {(data?.short_description || data?.detailed_description) && (
          <section className="game-detail-description">
            <h2>{t('gameDetail.about')}</h2>
            {data.short_description &&
              !(
                data.detailed_description &&
                detailedRepeatsLead(data.short_description, data.detailed_description)
              ) && <p className="game-detail-short">{data.short_description}</p>}
            {data.detailed_description && (
              <SafeHtml html={data.detailed_description} />
            )}
          </section>
        )}

        {data?.screenshots && data.screenshots.length > 0 && (
          <section className="game-detail-media">
            <h2>{t('gameDetail.screenshots')}</h2>
            <ScreenshotCarousel
              shots={data.screenshots}
              onOpen={(idx) => setLightbox(idx)}
            />
          </section>
        )}

        {(() => {
          // Resolve a playable source per movie first, then hide the whole
          // section when none remain — a non-empty `movies` array whose
          // entries all lack an mp4/webm URL used to render a bare
          // "Trailers" heading with no videos under it.
          const playable = (data?.movies ?? [])
            .map((m) => ({
              m,
              src: m.mp4?.['480'] || m.webm?.['480'] || m.mp4?.max || m.webm?.max,
            }))
            .filter((x): x is { m: (typeof x)['m']; src: string } => !!x.src);
          if (playable.length === 0) return null;
          return (
            <section className="game-detail-media">
              <h2>{t('gameDetail.trailers')}</h2>
              <div className="game-detail-videos">
                {playable.map(({ m, src }) => (
                  <video
                    key={m.id}
                    poster={m.thumbnail}
                    controls
                    preload="metadata"
                    src={src}
                  />
                ))}
              </div>
            </section>
          );
        })()}


        {data?.pc_requirements?.minimum && (
          <section className="game-detail-reqs">
            <h2>{t('gameDetail.system_requirements')}</h2>
            {/* Minimum and recommended side by side — the only question
                anyone asks of this block is "which one am I?", and that needs
                the two sets adjacent rather than stacked. Recommended is
                dropped silently when Steam doesn't publish it. */}
            <div className="req-columns">
              <div className="req-column">
                <div className="req-column-head">
                  <IconMonitorSmall />
                  {t('gameDetail.req_minimum')}
                </div>
                <RequirementsBlock html={data.pc_requirements.minimum} />
              </div>
              {data.pc_requirements.recommended && (
                <div className="req-column req-column-recommended">
                  <div className="req-column-head">
                    <IconBoltSmall />
                    {t('gameDetail.req_recommended')}
                  </div>
                  <RequirementsBlock html={data.pc_requirements.recommended} />
                </div>
              )}
            </div>
          </section>
        )}

        {news.length > 0 && (
          <section className="game-detail-news">
            <h2>{t('gameDetail.news')}</h2>
            <div className="news-grid">
              {news.map((item) => (
                <button
                  key={item.gid}
                  type="button"
                  className="news-card"
                  onClick={() => void window.api.shell.openExternal(item.url)}
                >
                  <div className="news-body">
                    <div className="news-kick">
                      {[item.feedlabel, formatNewsDate(item.date)]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    <div className="news-title">{item.title}</div>
                    <div className="news-text">{newsExcerpt(item.contents)}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>

      {lightbox !== null &&
        data?.screenshots &&
        data.screenshots[lightbox] && (() => {
          const total = data.screenshots.length;
          const current = data.screenshots[lightbox];
          const src =
            current?.path_full || current?.path_thumbnail || '';
          if (!src) return null;
          const showArrows = total > 1;
          return (
            <div
              className="game-detail-lightbox"
              onClick={() => setLightbox(null)}
              role="dialog"
              aria-modal="true"
            >
              <button
                type="button"
                className="game-detail-lightbox-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(null);
                }}
                aria-label={t('gameDetail.close_lightbox')}
                title={t('gameDetail.close_lightbox')}
              >
                ✕
              </button>
              {showArrows && (
                <button
                  type="button"
                  className="game-detail-lightbox-arrow game-detail-lightbox-arrow-left"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightbox((idx) =>
                      idx === null ? null : (idx - 1 + total) % total
                    );
                  }}
                  aria-label={t('gameDetail.prev_screenshot')}
                  title={t('gameDetail.prev_screenshot')}
                >
                  <IconChevronLeft size={26} />
                </button>
              )}
              <img
                src={src}
                alt=""
                onClick={(e) => e.stopPropagation()}
              />
              {showArrows && (
                <button
                  type="button"
                  className="game-detail-lightbox-arrow game-detail-lightbox-arrow-right"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightbox((idx) =>
                      idx === null ? null : (idx + 1) % total
                    );
                  }}
                  aria-label={t('gameDetail.next_screenshot')}
                  title={t('gameDetail.next_screenshot')}
                >
                  <IconChevronRight size={26} />
                </button>
              )}
              {showArrows && (
                <div className="game-detail-lightbox-counter">
                  {lightbox + 1} / {total}
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}

// ───────────────────────────── App ─────────────────────────────
export function App() {
  const { i18n, t } = useTranslation();
  const launchErrorText = useLaunchErrorText();
  const [session, setSession] = useState<SessionStatus>({ state: 'signed_out' });
  const [library, setLibrary] = useState<LibraryState>({ kind: 'loading' });
  const [balance, setBalance] = useState(0);
  const [initialCode, setInitialCode] = useState<string | null>(null);
  const [view, setView] = useState<View>('library');
  // Where the currently open game-detail page was entered from — any section,
  // not just the two grids, since the sidebar rail and the titlebar strip can
  // open a game from Downloads, Tasks or Stats too. Drives the back button.
  const [detailFromView, setDetailFromView] = useState<Exclude<View, 'game-detail'>>(
    'library'
  );
  const [selectedAppid, setSelectedAppid] = useState<number | null>(null);
  const [installRoot, setInstallRoot] = useState<string | null>(null);
  const [autoUpdate, setAutoUpdate] = useState<boolean>(true);
  // Pinned appids, in the user's order. Main owns the list (settings.json);
  // we mirror it here and always re-seed from what main returns after a
  // toggle, so two fast clicks can't leave the rail out of sync.
  const [favorites, setFavorites] = useState<number[]>([]);
  // A game the user opened that isn't pinned. It rides along in the rail so
  // the current selection is visible, and is dropped the moment the user
  // unpins — otherwise "Открепить" left the card sitting there unchanged.
  const [railExtraAppid, setRailExtraAppid] = useState<number | null>(null);
  const [launchProgress, setLaunchProgress] = useState<LaunchProgress | null>(null);
  // Set when main signals "delta available" mid-update-check; cleared when
  // the user answers the modal (or a new launch click overwrites it).
  const [updatePrompt, setUpdatePrompt] = useState<{ appid: number } | null>(null);
  // Install/launch refused for want of an active game session. Holds the
  // action that was blocked so it can be replayed verbatim once the user
  // redeems a fresh code from the bot.
  const [sessionGate, setSessionGate] = useState<
    { action: 'launch' | 'download'; appid: number } | null
  >(null);
  // Mirrors main-process feature-flags. Default true matches current behavior
  // until the boot-time IPC roundtrip resolves; we never start blocking the
  // user pre-resolution.
  const [balanceEnabled, setBalanceEnabled] = useState<boolean>(true);
  // Where to return when the user closes Settings. We track the last
  // non-settings view so the back button works consistently whether
  // the user opened settings from the redeem screen (signed_out) or
  // from any in-app section.
  const [preSettingsView, setPreSettingsView] = useState<View>('library');
  // The Tasks tab is hidden when balance is off (tasks earn game time —
  // nothing to earn without the balance subsystem). Boot default is `true`
  // until the API answers, so if it resolves/flips to false while we're on
  // the Tasks page, fall back to the library rather than stranding the user
  // on a page whose nav button just vanished.
  useEffect(() => {
    if (!balanceEnabled) {
      setView((v) => (v === 'tasks' ? 'library' : v));
      setPreSettingsView((v) => (v === 'tasks' ? 'library' : v));
    }
  }, [balanceEnabled]);
  // Genre labels per appid for the catalog filter. Seeded from main's
  // store cache (instant) and topped up by background broadcasts as the
  // fill progresses. A missing appid means "not known yet" — the UI
  // treats that as unfiltered, so a cold cache just shows the catalog
  // exactly as before, with chips appearing as data arrives.
  const [genreMap, setGenreMap] = useState<Record<number, string[]>>({});
  // Which locale `genreMap` currently holds. Genre labels are localized, so
  // the map is merged while the language is unchanged and replaced when it
  // switches — see the genres effect below.
  const genreLocaleRef = useRef<string | null>(null);
  // Playtime per game, from the local metrics ledger — the same source the
  // Stats page reads. Refreshed with the library so a session just finished
  // shows up without a restart.
  const [playedByAppid, setPlayedByAppid] = useState<Record<number, number>>({});
  // Disk footprint per installed game — the catalog card and the rail both
  // read it. Probing walks the install tree, so we only ever ask about games
  // that are actually on disk.
  const [sizeByAppid, setSizeByAppid] = useState<Record<number, number>>({});
  // Failsafe for the genre fill — see genreFill below.
  const [genreFillTimedOut, setGenreFillTimedOut] = useState(false);
  // Lives here rather than in LibraryPage so a genre tag on the game page can
  // select it and navigate in one go.
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  /** Last failed launch or install, shown as a dismissable toast. */
  const [launchError, setLaunchError] = useState<string | null>(null);
  // appid → what the user just clicked, held from the click until the real
  // state arrives. Everything before that first signal is now a network
  // round-trip (the session gate, then the pool account and a DD login), so
  // without this the button sits there looking untouched and the click reads
  // as having missed.
  const [pendingStart, setPendingStart] = useState<Record<number, 'download' | 'launch'>>(
    {}
  );
  const markPending = useCallback((appid: number, kind: 'download' | 'launch') => {
    setPendingStart((prev) => ({ ...prev, [appid]: kind }));
  }, []);
  const clearPending = useCallback((appid: number) => {
    setPendingStart((prev) => {
      if (!(appid in prev)) return prev;
      const next = { ...prev };
      delete next[appid];
      return next;
    });
  }, []);
  // Long enough to read twice, short enough not to become furniture — the
  // same lifetime the DRM warning uses.
  useEffect(() => {
    if (!launchError) return;
    const id = setTimeout(() => setLaunchError(null), 8_000);
    return () => clearTimeout(id);
  }, [launchError]);
  // Play entitlement. Not a wallet: the backend renews it when the user
  // completes a task, and the chrome shows how long the current one has left.
  const [gameSession, setGameSession] = useState<{
    is_active: boolean;
    remaining_seconds: number;
    /** When the server told us, so the seconds since can be counted off. */
    fetchedAt: number;
  } | null>(null);

  useEffect(() => {
    if (library.kind !== 'loaded') return;
    setPendingStart((prev) => {
      let next = prev;
      for (const key of Object.keys(prev)) {
        const appid = Number(key);
        if (prev[appid] !== 'download') continue;
        const game = library.data.find((g) => g.appid === appid);
        if (game && game.status !== 'not_installed') {
          if (next === prev) next = { ...prev };
          delete next[appid];
        }
      }
      return next;
    });
  }, [library]);

  const refreshLibrary = useCallback(async () => {
    setLibrary({ kind: 'loading' });
    try {
      const data = await window.api.library.list();
      setLibrary({ kind: 'loaded', data });
    } catch {
      setLibrary({ kind: 'error' });
    }
  }, []);

  // Same idea as libraryAppidsKey below, narrowed to what's on disk: the
  // size probe must re-run when a game finishes installing or is removed,
  // but not on every progress tick.
  const installedAppidsKey =
    library.kind === 'loaded'
      ? library.data
          .filter((g) => g.status === 'installed' || g.status === 'running')
          .map((g) => g.appid)
          .join(',')
      : '';

  // Stable appid key so the genre request doesn't re-fire on every
  // download-progress tick (those replace the `library` object).
  const libraryAppidsKey =
    library.kind === 'loaded'
      ? library.data.map((g) => g.appid).join(',')
      : '';

  useEffect(() => {
    if (!libraryAppidsKey) return;
    const appids = libraryAppidsKey.split(',').map(Number);
    let cancelled = false;
    // Merge within a locale, replace across one. `known` is the cache-only
    // answer; genres resolved through PICS only ever arrive by broadcast and
    // live nowhere else, so replacing wholesale on every library refresh
    // (and a refresh fires on sign-in, uninstall and install:removed) wiped
    // them — the active genre filter visibly switched itself off and back on
    // a second later. Language switches still start clean, since old-language
    // chips must not survive.
    const locale = i18n.language;
    void window.api.steam.genres(appids, locale).then(({ known }) => {
      if (cancelled) return;
      setGenreMap((prev) =>
        genreLocaleRef.current === locale ? { ...prev, ...known } : known
      );
      genreLocaleRef.current = locale;
    });
    return () => {
      cancelled = true;
    };
  }, [libraryAppidsKey, i18n.language]);

  useEffect(() => {
    if (!libraryAppidsKey) return;
    setGenreFillTimedOut(false);
    const id = setTimeout(() => setGenreFillTimedOut(true), 90_000);
    return () => clearTimeout(id);
  }, [libraryAppidsKey]);

  // Playtime totals, refreshed whenever the library identity changes (which
  // includes sign-in and every uninstall) — and whenever the window regains
  // focus, which is what alt-tabbing back out of a game looks like. The play
  // session closes when the game's process exits, an event the renderer never
  // hears, so without the focus refresh "most played" and the rail's played
  // row stay on the numbers from before you played.
  const [playtimeEpoch, setPlaytimeEpoch] = useState(0);
  useEffect(() => {
    const bump = () => setPlaytimeEpoch((n) => n + 1);
    window.addEventListener('focus', bump);
    return () => window.removeEventListener('focus', bump);
  }, []);

  useEffect(() => {
    if (!libraryAppidsKey) return;
    let cancelled = false;
    void window.api.stats
      .gameTotals()
      .then((rows) => {
        if (cancelled) return;
        const map: Record<number, number> = {};
        for (const r of rows) map[r.appid] = r.seconds;
        setPlayedByAppid(map);
      })
      .catch(() => {
        // Stats are decoration here — a failure just leaves the row hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [libraryAppidsKey, playtimeEpoch]);

  useEffect(() => {
    const off = window.api.steam.onGenresUpdate((u) => {
      // Stale-locale guard: ignore stragglers from a fill that started
      // before a language switch.
      if (u.locale !== i18n.language) return;
      setGenreMap((m) => ({ ...m, [u.appid]: u.genres }));
    });
    return off;
  }, [i18n.language]);

  useEffect(() => {
    void window.api.auth.status().then(setSession);
    void window.api.ledger.balance().then(setBalance);
    void window.api.settings.get().then((s) => {
      setInstallRoot(s.installRoot);
      setAutoUpdate(s.autoUpdate);
      setFavorites(s.favorites ?? []);
    });
    void window.featureFlags.get().then((f) => setBalanceEnabled(f.balanceEnabled));
    const offFlags = window.featureFlags.onChange((f) =>
      setBalanceEnabled(f.balanceEnabled)
    );
    const offAuth = window.api.auth.onStatus(setSession);
    const offDL = window.api.download.onProgress((e) => {
      // The session can lapse after the pre-flight check passed — the download
      // then dies on a 403 from the credentials endpoint. Same prompt, and the
      // replay restarts the download (DepotDownloader resumes from disk).
      if (e.done && e.error === 'game_session_required') {
        setSessionGate({ action: 'download', appid: e.appid });
      }
      setLibrary((prev) =>
        prev.kind === 'loaded'
          ? {
              kind: 'loaded',
              data: prev.data.map((g) =>
                g.appid !== e.appid
                  ? g
                  : {
                      ...g,
                      status: e.done
                        ? e.error
                          ? 'error'
                          : 'installed'
                        : 'downloading',
                      downloadPercent: e.done ? (e.error ? null : 100) : e.percent,
                      // Drop the stage on terminal events; otherwise preserve
                      // the last stage when the percent event omits it.
                      downloadStage: e.done ? null : e.stage ?? g.downloadStage,
                      // Latest error reason for the download card (e.g.
                      // "two_factor_required", "account_unconfigured").
                      // Cleared on successful completion or when a new
                      // download starts.
                      downloadError: e.done ? e.error ?? null : null,
                      // Companion to platform-aware error keys. Cleared
                      // alongside downloadError when a fresh download starts.
                      downloadErrorPlatforms: e.done
                        ? e.errorPlatforms ?? null
                        : null,
                      // guardHint is transient: each event either sets it
                      // (poll started / code received) or clears it.
                      guardHint: e.done ? null : e.guardHint ?? null,
                      // Cumulative bytes so far. Cleared on completion —
                      // once the install is "installed" / "error" the
                      // download card no longer needs the running tally.
                      downloadBytesDownloaded: e.done
                        ? null
                        : e.bytesDownloaded ?? g.downloadBytesDownloaded,
                      // Running estimate of total install size. Cleared on
                      // completion for the same reason.
                      downloadBytesTotal: e.done
                        ? null
                        : e.bytesTotal ?? g.downloadBytesTotal,
                    }
              ),
            }
          : prev
      );
    });
    const offLaunch = window.api.game.onLaunchProgress((e) => {
      setLaunchProgress(
        e.phase === 'idle'
          ? null
          : { appid: e.appid, phase: e.phase, percent: e.percent }
      );
    });
    const offUpdate = window.api.game.onUpdateAvailable((e) => {
      setUpdatePrompt({ appid: e.appid });
    });
    const offRemoved = window.api.install.onRemoved(() => {
      void refreshLibrary();
    });
    void window.api.deeplink.takeCode().then((c) => {
      if (c) setInitialCode(c);
    });
    const offRedeem = window.api.deeplink.onRedeem(({ code }) => setInitialCode(code));
    return () => {
      offAuth();
      offDL();
      offLaunch();
      offUpdate();
      offRemoved();
      offRedeem();
      offFlags();
    };
  }, [refreshLibrary]);

  const handleUpdateDecision = useCallback(
    async (install: boolean) => {
      const current = updatePrompt;
      if (!current) return;
      setUpdatePrompt(null);
      await window.api.game.sendUpdateDecision(current.appid, install);
    },
    [updatePrompt]
  );

  // Auto-dismiss the prompt if main has already moved past the update
  // check (e.g. DD finished before the user clicked). Without this the
  // modal would stay open over the actually-launching game.
  useEffect(() => {
    if (launchProgress?.phase === 'launching' || launchProgress === null) {
      setUpdatePrompt(null);
    }
  }, [launchProgress]);

  useEffect(() => {
    if (session.state === 'signed_in') {
      void refreshLibrary();
    } else {
      setLibrary({ kind: 'loading' });
      setView('library');
      // The picked game belongs to the session that just ended. Left set, it
      // wins over the pinned-game fallback for currentAppid, so the next
      // sign-in opened the rail on whatever the previous user had selected.
      setSelectedAppid(null);
    }
  }, [session.state, refreshLibrary]);

  // Balance updates are pushed via IPC from main (ledger.onBalanceChange
  // → sendToRenderer). No more WebSocket in the renderer — the local
  // server stays on-only for the extension.
  useEffect(() => {
    const off = window.api.ledger.onBalanceUpdate(setBalance);
    return off;
  }, []);

  const handleLaunch = useCallback(
    async (appid: number) => {
      setLaunchError(null);
      markPending(appid, 'launch');
      try {
      let r = await window.api.game.launch(appid);
      // No live game session — send the user to the bot and replay after.
      if (!r.ok && r.error === 'game_session_required') {
        setLaunchProgress(null);
        setSessionGate({ action: 'launch', appid });
        return;
      }
      // The gate could not be checked at all. Nothing starts: we cannot tell
      // whether this user may play, and guessing "yes" is the wrong guess.
      if (!r.ok && r.error === 'session_check_failed') {
        setLaunchProgress(null);
        setLaunchError(t('errors.server_unreachable'));
        return;
      }
      // DD -validate refused or crashed mid-check. Ask the user whether to
      // skip the safety net and launch a possibly stale install. Native
      // confirm is enough — it's a single yes/no choice and keeping it out
      // of the styled UI saves a modal we'd otherwise only use here.
      if (!r.ok && r.error === 'update_check_failed') {
        const proceed = window.confirm(t('game.launch_without_check_confirm'));
        if (!proceed) {
          setLaunchProgress(null);
          return;
        }
        r = await window.api.game.launch(appid, { skipUpdateCheck: true });
      }
      setLaunchProgress(null);
      if (!r.ok) {
        // Until now a failed launch only reached the console, and only with
        // diagnostics on: the user clicked Play and nothing happened.
        if (window.api.debug.loggingEnabled) console.warn('[launch] failed:', r.error);
        setLaunchError(launchErrorText(r.error, r.message));
      }
      const b = await window.api.ledger.balance();
      setBalance(b);
      } finally {
        clearPending(appid);
      }
    },
    [t, launchErrorText, markPending, clearPending]
  );

  const handleDownload = useCallback(
    async (appid: number) => {
      setLaunchError(null);
      markPending(appid, 'download');
      const r = await window.api.download.start(appid);
      if (!r.ok) clearPending(appid);
      if (!r.ok && r.error === 'game_session_required') {
        setSessionGate({ action: 'download', appid });
        return;
      }
      if (!r.ok && r.error === 'session_check_failed') {
        setLaunchError(t('errors.server_unreachable'));
        return;
      }
      if (!r.ok) {
        if (window.api.debug.loggingEnabled) console.warn('[download] failed:', r.error);
        setLaunchError(launchErrorText(r.error, undefined));
      }
    },
    [t, launchErrorText, markPending, clearPending]
  );

  const handleCancel = useCallback(async (appid: number) => {
    await window.api.download.cancel(appid);
  }, []);

  const handleUninstall = useCallback(
    async (appid: number) => {
      // Native confirm: a single yes/no, mirrors the pattern used for
      // "launch without update check" — keeps us from shipping a styled
      // modal just for this one prompt.
      if (!window.confirm(t('game.uninstall_confirm'))) return;
      // Hard-cap the IPC round-trip. fs.rm on Windows can hang for
      // minutes on a held file handle (Explorer preview, AV scanner);
      // we don't want the renderer waiting in `await` until the OS
      // reports the main window as unresponsive. 25 s is generous for
      // a normal uninstall and short enough that a hang gets surfaced
      // as a clear dialog instead of a frozen window.
      const UNINSTALL_TIMEOUT_MS = 25_000;
      let r: { success: boolean; error?: string };
      try {
        r = await Promise.race([
          window.api.install.remove(appid),
          new Promise<{ success: false; error: string }>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: false,
                  error: `timeout_after_${UNINSTALL_TIMEOUT_MS}ms`,
                }),
              UNINSTALL_TIMEOUT_MS
            )
          ),
        ]);
      } catch (err) {
        // The IPC channel itself rejected (handler threw an unhandled
        // error before main added the catch-all). Surface as a generic
        // failure instead of letting the unhandled rejection freeze us.
        r = { success: false, error: (err as Error).message };
      }
      if (!r.success) {
        if (r.error === 'game_running') {
          window.alert(t('game.uninstall_blocked_running'));
        } else {
          window.alert(t('game.uninstall_failed', { reason: r.error ?? '' }));
        }
        return;
      }
      window.alert(t('game.uninstall_success'));
      // Re-fetch the library so the card flips from "Play" back to
      // "Install". The 'install:removed' broadcast also triggers this,
      // but an explicit refresh here keeps the flow synchronous from
      // the user's perspective.
      await refreshLibrary();
    },
    [refreshLibrary, t]
  );

  const handleLogout = useCallback(async () => {
    await window.api.auth.logout();
  }, []);

  const handleChooseInstallDir = useCallback(async () => {
    const r = await window.api.settings.chooseInstallDir();
    if (r.ok && r.installRoot) setInstallRoot(r.installRoot);
  }, []);

  const handleToggleAutoUpdate = useCallback(async (next: boolean) => {
    setAutoUpdate(next);
    await window.api.settings.setAutoUpdate(next);
  }, []);

  const handleChangeLanguage = useCallback(async (next: string) => {
    await window.api.settings.setLanguage(next);
    // Apply immediately so the UI doesn't wait for a restart. The picker
    // only emits codes from SUPPORTED_LANGUAGES, but guard anyway in case
    // a future caller passes something else.
    if (isSupportedLanguage(next)) await setLanguage(next);
  }, []);

  /**
   * Library card cover click → open the in-app Steam-Store-style detail.
   * The accountId points us to the PublicAccount row in `library`, which
   * gives us appid + status + downloadStage etc. without an extra fetch.
   */
  const handleOpenDetail = useCallback((appid: number) => {
    setSelectedAppid(appid);
    setRailExtraAppid(appid);
    setView((prev) => {
      // Remember the section the game was opened from so Back returns there.
      // Opening one game from another's detail page keeps the original
      // origin, and 'settings' is excluded because the shell is hidden there
      // and Back should land somewhere navigable.
      if (prev !== 'game-detail' && prev !== 'settings') setDetailFromView(prev);
      return 'game-detail';
    });
  }, []);

  // When the user navigates via titlebar (Library / Tasks / etc.) drop the
  // selected appid so the back-button doesn't strand us on a stale entry.
  const handleSetView = useCallback((next: View) => {
    if (next !== 'game-detail') setSelectedAppid(null);
    setView(next);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setView((prev) => {
      if (prev !== 'settings') setPreSettingsView(prev);
      return 'settings';
    });
  }, []);

  const handleCloseSettings = useCallback(() => {
    setView(preSettingsView);
  }, [preSettingsView]);

  // Re-read the session on demand: after a redeem, after finishing a task, and
  // whenever a gated action was refused. Cheap enough to poll slowly so the
  // countdown doesn't sit frozen while the window stays open.
  const refreshGameSession = useCallback(async () => {
    try {
      const next = await window.api.session.game();
      setGameSession(next ? { ...next, fetchedAt: Date.now() } : null);
    } catch {
      setGameSession(null);
    }
  }, []);

  // The chip is a countdown, but the server is only asked once a minute, so
  // the number used to sit still and then jump a minute at a time. The poll
  // stays the source of truth; this just counts off the seconds in between.
  const [sessionTick, setSessionTick] = useState(0);
  useEffect(() => {
    if (!gameSession?.is_active) return;
    const id = setInterval(() => setSessionTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [gameSession?.is_active]);

  const liveGameSession = useMemo(() => {
    if (!gameSession) return null;
    if (!gameSession.is_active) return gameSession;
    const elapsed = Math.floor((Date.now() - gameSession.fetchedAt) / 1000);
    return {
      ...gameSession,
      remaining_seconds: Math.max(0, gameSession.remaining_seconds - elapsed),
    };
    // sessionTick is the whole point: it is what re-runs this every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameSession, sessionTick]);

  useEffect(() => {
    if (session.state !== 'signed_in') {
      setGameSession(null);
      return;
    }
    void refreshGameSession();
    const id = setInterval(() => void refreshGameSession(), 60_000);
    return () => clearInterval(id);
  }, [session.state, refreshGameSession]);

  const handleToggleFavorite = useCallback(async (appid: number) => {
    // Re-seed from what main persisted rather than flipping locally: the
    // returned list is the truth the sidebar, tabs and stars all render from.
    const next = await window.api.settings.toggleFavorite(appid);
    setFavorites(next);
    // Unpinned: stop showing it in the rail as a guest, so the card actually
    // disappears. Pinning does the reverse — the guest slot is now redundant.
    setRailExtraAppid((prev) => (prev === appid ? null : prev));
  }, []);

  const selectedAccount =
    library.kind === 'loaded' && selectedAppid !== null
      ? library.data.find((g) => g.appid === selectedAppid) ?? null
      : null;

  const signedIn = session.state === 'signed_in';
  const trustLevel = signedIn ? session.user.trust_level : null;

  const libraryGames = library.kind === 'loaded' ? library.data : [];
  // Pinned ids can outlive the game leaving the catalog, so resolve through
  // the library and keep the user's ordering.
  const pinnedGames = favorites
    .map((id) => libraryGames.find((g) => g.appid === id))
    .filter((g): g is PublicAccount => !!g);
  // What the rail and the quick-switch strip consider "the game you're on":
  // an explicit pick wins, otherwise the first pinned title.
  // What the catalog's chips are labelled with, which is not always how
  // Steam's appdetails words the same genre — see catalogGenres.
  const catalogGenres = useMemo(() => {
    const out = new Set<string>();
    for (const names of Object.values(genreMap)) {
      for (const name of names) out.add(name.toLocaleLowerCase());
    }
    return out;
  }, [genreMap]);

  // Clicking a genre on the game page is "show me more like this": it
  // replaces the selection rather than adding to it, since an intersection
  // with whatever was left selected is rarely what the click meant.
  const handleOpenGenre = useCallback(
    (name: string) => {
      setGenreFilter([name]);
      handleSetView('library');
    },
    [handleSetView]
  );

  const currentAppid = selectedAppid ?? pinnedGames[0]?.appid ?? null;

  // Probe the installed games one at a time in the background. Sequential on
  // purpose: each probe is a directory walk, and firing a dozen at once would
  // pin the main process for as long as the slowest one takes.
  useEffect(() => {
    if (!installedAppidsKey) {
      setSizeByAppid({});
      return;
    }
    const appids = installedAppidsKey.split(',').map(Number);
    let cancelled = false;
    void (async () => {
      for (const appid of appids) {
        if (cancelled) return;
        try {
          const bytes = await window.api.install.size(appid);
          if (cancelled) return;
          if (bytes != null) {
            setSizeByAppid((prev) => ({ ...prev, [appid]: bytes }));
          }
        } catch {
          /* not installed / unreadable — the row stays hidden */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installedAppidsKey]);

  // Genre fill progress. A game counts as resolved once main has broadcast an
  // answer for it — including an empty one, which is what a game with no genre
  // data returns. The deadline is a failsafe: if main stops broadcasting (a
  // crashed fill, an API that never answers), the bar still opens with
  // whatever arrived rather than waiting forever.
  const genresKnown = libraryGames.filter(
    (g) => genreMap[g.appid] !== undefined
  ).length;
  const genreFill = {
    known: genresKnown,
    total: libraryGames.length,
    done:
      libraryGames.length === 0 ||
      genresKnown >= libraryGames.length ||
      genreFillTimedOut,
  };

  const downloadCount = libraryGames.filter(
    (g) => g.status === 'downloading'
  ).length;

  // The shell (quick tabs + sidebar) belongs to the signed-in app. Settings
  // is reachable pre-auth, so it keeps the chrome minimal: brand, gear, close.
  const showShell = signedIn && view !== 'settings';

  return (
    <div className="h-full flex flex-col">
      <Titlebar
        balance={signedIn ? balance : null}
        trustLevel={signedIn ? trustLevel : null}
        quickGames={showShell ? pinnedGames : []}
        currentAppid={currentAppid}
        gameSession={signedIn ? liveGameSession : null}
        language={i18n.language}
        onChangeLanguage={handleChangeLanguage}
        onSelectGame={handleOpenDetail}
        onOpenSettings={handleOpenSettings}
        onLogout={signedIn ? handleLogout : undefined}
        balanceEnabled={balanceEnabled}
      />
      <div className="flex-1 flex min-h-0">
        {showShell && (
          <Sidebar
            games={libraryGames}
            favorites={favorites}
            currentAppid={currentAppid}
            railExtraAppid={railExtraAppid}
            view={view}
            balance={balance}
            balanceEnabled={balanceEnabled}
            downloadCount={downloadCount}
            launchProgress={launchProgress}
            installSize={currentAppid !== null ? sizeByAppid[currentAppid] ?? null : null}
            playedByAppid={playedByAppid}
            pendingStart={pendingStart}
            user={signedIn ? session.user : null}
            onSelectGame={handleOpenDetail}
            onToggleFavorite={handleToggleFavorite}
            onView={handleSetView}
            onLaunch={handleLaunch}
            onDownload={handleDownload}
            onCancel={handleCancel}
          />
        )}
        {/* min-h-0 is load-bearing: without it a flex child refuses to shrink
            below its content, so the inner `overflow-y-auto` never scrolls and
            a tall page (the game detail view) runs off the bottom of the
            window instead. */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {view === 'settings' ? (
            <SettingsPage
              resolvedLanguage={i18n.language}
              installRoot={installRoot}
              autoUpdate={autoUpdate}
              balanceEnabled={balanceEnabled}
              onChangeLanguage={handleChangeLanguage}
              onChooseInstallDir={handleChooseInstallDir}
              onToggleAutoUpdate={handleToggleAutoUpdate}
              onBack={handleCloseSettings}
            />
          ) : !signedIn ? (
            <RedeemPage initialCode={initialCode} />
          ) : view === 'downloads' ? (
            <DownloadsPage
              state={library}
              onCancel={handleCancel}
              onRetry={handleDownload}
              onRefreshLibrary={refreshLibrary}
            />
          ) : view === 'tasks' ? (
            <TasksPage />
          ) : view === 'stats' ? (
            <StatsPage />
          ) : view === 'game-detail' && selectedAccount ? (
            <GameDetailPage
              account={selectedAccount}
              balance={balance}
              balanceEnabled={balanceEnabled}
              launchProgress={launchProgress}
              favorite={favorites.includes(selectedAccount.appid)}
              onBack={() => handleSetView(detailFromView)}
              onLaunch={handleLaunch}
              onDownload={handleDownload}
              onCancel={handleCancel}
              onUninstall={handleUninstall}
              onToggleFavorite={handleToggleFavorite}
              onOpenGenre={handleOpenGenre}
              catalogGenres={catalogGenres}
              pending={!!pendingStart[selectedAccount.appid]}
            />
          ) : (
            <LibraryPage
              state={library}
              balance={balance}
              balanceEnabled={balanceEnabled}
              launchProgress={launchProgress}
              favorites={favorites}
              onLaunch={handleLaunch}
              onDownload={handleDownload}
              onCancel={handleCancel}
              onRetry={refreshLibrary}
              onOpenDetail={handleOpenDetail}
              onToggleFavorite={handleToggleFavorite}
              onUninstall={handleUninstall}
              playedByAppid={playedByAppid}
              sizeByAppid={sizeByAppid}
              pendingStart={pendingStart}
              genreFilter={genreFilter}
              setGenreFilter={setGenreFilter}
              genreFill={genreFill}
              installedOnly={view === 'installed'}
              genreMap={genreMap}
            />
          )}
        </div>
      </div>
      <UpdateToast />
      <DrmPatchToast />
      {launchError && (
        <div className="update-toast" role="alert">
          <div className="update-toast-row">
            <span className="text-[var(--color-bad)] shrink-0">
              <IconInfo size={15} />
            </span>
            <div className="update-toast-text update-toast-text-error">
              {launchError}
            </div>
            <button
              type="button"
              className="drm-toast-collapse"
              onClick={() => setLaunchError(null)}
              aria-label={t('gameSession.later')}
            >
              <IconX size={12} />
            </button>
          </div>
        </div>
      )}
      {sessionGate && (
        <GameSessionDialog
          onClose={() => setSessionGate(null)}
          onGranted={() => {
            const pending = sessionGate;
            setSessionGate(null);
            if (!pending) return;
            // Replay the click the gate intercepted. main never caches a
            // negative verdict, so this re-checks against the session the bot
            // has just opened.
            if (pending.action === 'launch') void handleLaunch(pending.appid);
            else void handleDownload(pending.appid);
          }}
        />
      )}
      {updatePrompt && (
        <div
          className="game-update-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="game-update-modal-title"
        >
          <div className="game-update-modal-card">
            <h2 id="game-update-modal-title">{t('game.update_available')}</h2>
            <div className="game-update-modal-actions">
              <button
                type="button"
                className="game-update-modal-skip"
                onClick={() => void handleUpdateDecision(false)}
              >
                {t('game.update_skip')}
              </button>
              <button
                type="button"
                className="game-update-modal-install"
                onClick={() => void handleUpdateDecision(true)}
                autoFocus
              >
                {t('game.update_install')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
