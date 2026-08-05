import { memo } from 'react'
import type { TelemetryInfo, UsageInfo } from '@shared/contracts'
import { formatDuration, formatTokens } from '../lib/format'
import { useI18n } from '../lib/i18n'

export interface TelemetryBarProps {
  telemetry: TelemetryInfo
  usage: UsageInfo
}

/**
 * Cache hit rate formatting with dynamic precision: high rates need more
 * digits to be meaningful (99% could be 99.0% or 99.97%), low rates are
 * fine as integers. 31.25% → "31%", 95.3% → "95.3%", 99.97% → "99.97%".
 */
function formatCacheRate(rate: number): string {
  const pct = rate * 100
  if (pct >= 99) return pct.toFixed(2)
  if (pct >= 90) return pct.toFixed(1)
  return pct.toFixed(0)
}

/**
 * Bottom-of-chat runtime metrics bar (Codex style). Renders live/final token
 * rate, cache hit rate, context usage with a mini progress bar, TTFT and the
 * latest output token count. Null values render as an em dash with a tooltip.
 */
function TelemetryBar({ telemetry, usage }: TelemetryBarProps) {
  const { t } = useI18n()
  const rate = telemetry.tokenRate
  const live = telemetry.tokenRateKind === 'live-estimate'
  const cache = telemetry.cacheHitRate
  const ttft = telemetry.ttftMs
  const out = telemetry.latestOutputTokens
  const ctxTokens = telemetry.contextTokens
  const ctxWindow = telemetry.contextWindow
  const ctxPct =
    telemetry.contextPercent ??
    (ctxTokens !== null && ctxWindow !== null && ctxWindow > 0 ? (ctxTokens / ctxWindow) * 100 : null)
  const pct = ctxPct === null ? null : Math.max(0, Math.min(100, ctxPct))
  const ctxText =
    ctxTokens !== null || ctxWindow !== null
      ? `${telemetry.contextEstimated ? '≈' : ''}${ctxTokens !== null ? formatTokens(ctxTokens) : '—'} / ${ctxWindow !== null ? formatTokens(ctxWindow) : '—'}`
      : null
  const ctxTitle = ctxPct !== null && ctxText !== null ? t('telemetry.ctxTitle', { text: ctxText, pct: Math.round(ctxPct) }) : t('telemetry.ctxNone')
  // Explicit formula: cacheRead / (input + cacheRead + cacheWrite). Cache
  // writes take part in the denominator — the tooltip and aria-label both
  // state it so the percentage is never mistaken for a "free" read.
  const cacheTooltip =
    cache !== null
      ? t('telemetry.cacheFormula', {
          read: formatTokens(usage.cacheRead),
          input: formatTokens(usage.input),
          write: formatTokens(usage.cacheWrite),
          pct: formatCacheRate(cache),
        })
      : t('telemetry.cacheNone')
  const cacheAriaLabel =
    cache !== null
      ? t('telemetry.cacheAria', {
          pct: formatCacheRate(cache),
          read: formatTokens(usage.cacheRead),
          input: formatTokens(usage.input),
          write: formatTokens(usage.cacheWrite),
        })
      : undefined

  return (
    <div className="telemetry-bar" role="status" aria-label={t('telemetry.aria')}>
      <div
        className="telemetry-item telemetry-speed"
        title={rate !== null ? (live ? t('telemetry.speedLive') : t('telemetry.speedFinal')) : t('telemetry.speedNone')}
      >
        <span className="telemetry-label">{t('telemetry.speed')}</span>
        {rate !== null ? (
          <span className={`telemetry-value${live ? ' telemetry-live' : ''}`}>
            {live ? '≈' : ''}
            {rate.toFixed(rate < 10 ? 1 : 0)} tok/s
          </span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label={t('telemetry.speedNone')}>
            —
          </span>
        )}
      </div>
      <div className="telemetry-item telemetry-secondary" title={cacheTooltip}>
        <span className="telemetry-label">{t('telemetry.cacheHit')}</span>
        {cache !== null ? (
          <span className="telemetry-value" aria-label={cacheAriaLabel}>
            {formatCacheRate(cache)}%
          </span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label={t('telemetry.cacheNone')}>
            —
          </span>
        )}
      </div>
      <div className="telemetry-item telemetry-ctx" title={ctxTitle}>
        <span className="telemetry-label">{t('telemetry.context')}</span>
        {ctxText !== null ? (
          <span className="telemetry-value telemetry-ctx-text">{ctxText}</span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label={t('telemetry.ctxNone')}>
            —
          </span>
        )}
        {pct !== null ? (
          <span className="telemetry-ctx-track" aria-hidden="true">
            <span className="telemetry-ctx-fill" style={{ width: `${pct}%` }} />
          </span>
        ) : null}
      </div>
      <div
        className="telemetry-item telemetry-secondary"
        title={ttft !== null ? t('telemetry.ttftTitle', { dur: formatDuration(ttft) }) : t('telemetry.ttftNone')}
      >
        <span className="telemetry-label">{t('telemetry.ttft')}</span>
        {ttft !== null ? (
          <span className="telemetry-value">{formatDuration(ttft)}</span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label={t('telemetry.ttftNone')}>
            —
          </span>
        )}
      </div>
      <div
        className="telemetry-item telemetry-secondary"
        title={out !== null ? t('telemetry.outputTitle') : t('telemetry.outputNone')}
      >
        <span className="telemetry-label">{t('telemetry.recentOutput')}</span>
        {out !== null ? (
          <span className="telemetry-value">{formatTokens(out)} tok</span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label={t('telemetry.outputNone')}>
            —
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The snapshot's telemetry object is recreated on every flush (often faster
 * than telemetry-relevant values actually change). Compare every displayed
 * primitive so unrelated snapshot updates (queue, status text, ...) skip the
 * re-render while live-rate ticks still paint immediately.
 */
function telemetryEqual(prev: TelemetryBarProps, next: TelemetryBarProps): boolean {
  const a = prev.telemetry
  const b = next.telemetry
  return (
    a.tokenRate === b.tokenRate &&
    a.tokenRateKind === b.tokenRateKind &&
    a.ttftMs === b.ttftMs &&
    a.cacheHitRate === b.cacheHitRate &&
    a.contextTokens === b.contextTokens &&
    a.contextWindow === b.contextWindow &&
    a.contextPercent === b.contextPercent &&
    a.contextEstimated === b.contextEstimated &&
    a.latestOutputTokens === b.latestOutputTokens &&
    prev.usage.input === next.usage.input &&
    prev.usage.cacheRead === next.usage.cacheRead &&
    prev.usage.cacheWrite === next.usage.cacheWrite
  )
}

export default memo(TelemetryBar, telemetryEqual)
