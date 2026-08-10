import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Visual states the toast walks through, driven by the IPC events fired
 * by main/updater.ts. `hidden` is the resting state — the component is
 * always mounted, but renders nothing when hidden so we don't have to
 * juggle conditional mounting in App.tsx.
 *
 *   hidden → checking → available → downloading → downloaded
 *
 * Both "no update available" and any error collapse straight back to
 * `hidden` — a background check that finds nothing or fails is a non-event
 * for the user, and (crucially) an error must clear the `checking` spinner
 * so it can't hang forever.
 *
 * available collapses straight into downloading because autoDownload is
 * on. We still surface the available state briefly so the user sees
 * "{{version}} found, downloading…".
 */
type ToastState =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | {
      kind: 'downloading';
      version: string;
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | { kind: 'downloaded'; version: string };

function formatBytesPerSecond(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

function formatEta(remainingBytes: number, bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const sec = remainingBytes / bytesPerSecond;
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

/**
 * Always-mounted toast that surfaces electron-updater progress in the
 * top-right corner of the window. Slides in from the top and renders
 * nothing in the resting state, so App.tsx can keep it permanently in
 * the tree without any layout impact.
 */
export function UpdateToast() {
  const { t } = useTranslation();
  const [state, setState] = useState<ToastState>({ kind: 'hidden' });

  useEffect(() => {
    const offChecking = window.api.updater.onChecking(() => {
      setState({ kind: 'checking' });
    });
    const offAvailable = window.api.updater.onAvailable(({ version }) => {
      setState({ kind: 'available', version });
    });
    const offNotAvailable = window.api.updater.onNotAvailable(() => {
      // Don't bother the user with "no update found" — that's the common
      // path. Hide the toast instead. (Skip the auto-hide timer so we
      // don't pop "checking" then immediately blank out either.)
      setState({ kind: 'hidden' });
    });
    const offProgress = window.api.updater.onDownloadProgress((p) => {
      setState((prev) => {
        const version =
          prev.kind === 'available' || prev.kind === 'downloading'
            ? prev.version
            : '';
        return {
          kind: 'downloading',
          version,
          percent: p.percent,
          bytesPerSecond: p.bytesPerSecond,
          transferred: p.transferred,
          total: p.total,
        };
      });
    });
    const offDownloaded = window.api.updater.onDownloaded(({ version }) => {
      setState({ kind: 'downloaded', version });
    });
    const offError = window.api.updater.onError(() => {
      // A failed check/download is a background non-event for the user — just
      // dismiss the toast (crucially, clear the "checking…" spinner so it
      // doesn't hang forever) instead of surfacing an error. Details are in
      // the main log. electron-updater retries on the next interval tick.
      setState({ kind: 'hidden' });
    });
    return () => {
      offChecking();
      offAvailable();
      offNotAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, []);

  if (state.kind === 'hidden') return null;

  return (
    <div className="update-toast" role="status" aria-live="polite">
      {state.kind === 'checking' && (
        <div className="update-toast-row">
          <Spinner />
          <span className="update-toast-text">{t('updater.checking')}</span>
        </div>
      )}

      {state.kind === 'available' && (
        <div className="update-toast-row">
          <Spinner />
          <span className="update-toast-text">
            {t('updater.available', { version: state.version })}
          </span>
        </div>
      )}

      {state.kind === 'downloading' && (
        <div className="update-toast-stack">
          <div className="update-toast-row">
            <span className="update-toast-text">
              {t('updater.downloading', {
                version: state.version || '',
              })}
            </span>
            <span className="update-toast-percent">
              {state.percent.toFixed(0)}%
            </span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuenow={Math.round(state.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="progress-fill progress-fill-live"
              style={{ width: `${state.percent}%` }}
            />
          </div>
          <div className="update-toast-meta">
            <span>
              {t('updater.speed')}: {formatBytesPerSecond(state.bytesPerSecond)}
            </span>
            <span>
              {t('updater.eta')}:{' '}
              {formatEta(
                Math.max(0, state.total - state.transferred),
                state.bytesPerSecond
              )}
            </span>
          </div>
        </div>
      )}

      {state.kind === 'downloaded' && (
        <div className="update-toast-stack">
          <span className="update-toast-text">
            {t('updater.downloaded', { version: state.version })}
          </span>
          <div className="update-toast-actions">
            <button
              type="button"
              className="update-toast-button update-toast-button-primary"
              onClick={() => void window.api.updater.installAndRestart()}
            >
              {t('updater.restart')}
            </button>
            <button
              type="button"
              className="update-toast-button"
              onClick={() => setState({ kind: 'hidden' })}
            >
              {t('updater.later')}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

function Spinner() {
  return (
    <span
      className="update-toast-spinner"
      aria-hidden="true"
      role="presentation"
    />
  );
}
