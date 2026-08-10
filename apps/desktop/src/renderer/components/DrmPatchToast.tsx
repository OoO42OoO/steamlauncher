import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Surfaces the main process's boot-time DRM patch sweep so the user knows
 * why the app is busy for a few seconds on first launch after the patcher
 * landed (and on any boot where a previously-skipped install needs to be
 * caught up). Also catches the launch-time `game:drm_warning` to warn that
 * a failed patch may force Steam to be running.
 *
 * Visual lifecycle:
 *   hidden → patching{total,current} → done → hidden (after 2.5s)
 *   hidden ← warning ← (auto-hide 8s)
 *
 * The two states are independent — a launch-time warning can fire while
 * the boot sweep is still in flight, so we render them in parallel
 * (warning stacked below the progress card).
 */
type SweepState =
  | { kind: 'hidden' }
  | { kind: 'patching'; total: number; current: number; name: string | null }
  | { kind: 'done'; total: number };

type WarnState =
  | { kind: 'hidden' }
  | { kind: 'warning'; appid: number; reason: string };

export function DrmPatchToast() {
  const { t } = useTranslation();
  const [sweep, setSweep] = useState<SweepState>({ kind: 'hidden' });
  const [warn, setWarn] = useState<WarnState>({ kind: 'hidden' });
  // A patch sweep over a big library runs for a while, and the card sits on
  // top of the catalog the whole time. Collapsed, it keeps only the title and
  // a hairline of progress so the user can get on with browsing.
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const offProgress = window.api.drmBoot.onProgress(({ total, current, name }) => {
      setSweep({ kind: 'patching', total, current, name });
    });
    const offDone = window.api.drmBoot.onDone(({ total }) => {
      setSweep({ kind: 'done', total });
    });
    const offWarn = window.api.game.onDrmWarning(({ appid, reason }) => {
      setWarn({ kind: 'warning', appid, reason });
    });
    return () => {
      offProgress();
      offDone();
      offWarn();
    };
  }, []);

  // Auto-dismiss the done state. We keep it briefly so the user gets a
  // confirmation that the sweep actually finished, then collapse back to
  // the resting hidden state.
  useEffect(() => {
    if (sweep.kind !== 'done') return;
    const id = setTimeout(() => setSweep({ kind: 'hidden' }), 2_500);
    return () => clearTimeout(id);
  }, [sweep.kind]);

  // Warnings linger longer — DRM-on-Steam is a real impact on UX and the
  // user should have time to read the message before it disappears.
  useEffect(() => {
    if (warn.kind !== 'warning') return;
    const id = setTimeout(() => setWarn({ kind: 'hidden' }), 8_000);
    return () => clearTimeout(id);
  }, [warn.kind]);

  if (sweep.kind === 'hidden' && warn.kind === 'hidden') return null;

  const sweepPercent =
    sweep.kind === 'patching' && sweep.total > 0
      ? Math.min(100, Math.round((sweep.current / sweep.total) * 100))
      : sweep.kind === 'done'
        ? 100
        : 0;

  return (
    <div className="drm-toast-stack" role="status" aria-live="polite">
      {sweep.kind === 'patching' && (
        <div className={'update-toast drm-toast' + (collapsed ? ' drm-toast-collapsed' : '')}>
          <div className="update-toast-stack">
            <div className="update-toast-row">
              <span className="update-toast-spinner" aria-hidden="true" />
              <span className="update-toast-text">
                {t('drmBoot.patching', { count: sweep.total })}
              </span>
              <span className="update-toast-percent">
                {sweep.current}/{sweep.total}
              </span>
              <button
                type="button"
                className="drm-toast-collapse"
                onClick={() => setCollapsed((v) => !v)}
                aria-expanded={!collapsed}
                aria-label={collapsed ? t('drmBoot.expand') : t('drmBoot.collapse')}
                title={collapsed ? t('drmBoot.expand') : t('drmBoot.collapse')}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
            {/* Collapsed keeps the bar: progress is the one thing worth
                seeing at a glance while it's out of the way. */}
            <div className="progress-track" aria-hidden="true">
              <div
                className="progress-fill progress-fill-live"
                style={{ width: `${sweepPercent}%` }}
              />
            </div>
            {sweep.name && !collapsed && (
              <div className="update-toast-meta">
                <span>{sweep.name}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {sweep.kind === 'done' && (
        <div className="update-toast drm-toast">
          <div className="update-toast-row">
            <span className="update-toast-text">{t('drmBoot.done')}</span>
          </div>
        </div>
      )}
      {warn.kind === 'warning' && (
        <div className="update-toast drm-toast drm-toast-warning">
          <div className="update-toast-stack">
            <span className="update-toast-text update-toast-text-error">
              {t('drmBoot.warning_title')}
            </span>
            <span className="update-toast-error-detail" title={warn.reason}>
              {t('drmBoot.warning_detail')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
