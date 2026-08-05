import { memo } from 'react'
import type { TelemetryInfo, UsageInfo } from '@shared/contracts'
import { formatDuration, formatTokens } from '../lib/format'

export interface TelemetryBarProps {
  telemetry: TelemetryInfo
  usage: UsageInfo
}

/**
 * Bottom-of-chat runtime metrics bar (Codex style). Renders live/final token
 * rate, cache hit rate, context usage with a mini progress bar, TTFT and the
 * latest output token count. Null values render as an em dash with a tooltip.
 */
function TelemetryBar({ telemetry, usage }: TelemetryBarProps) {
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
  const ctxTitle = ctxPct !== null && ctxText !== null ? `上下文 ${ctxText}（${Math.round(ctxPct)}%）` : '暂无上下文用量数据'
  // Explicit formula: cacheRead / (input + cacheRead + cacheWrite). Cache
  // writes take part in the denominator — the tooltip and aria-label both
  // state it so the percentage is never mistaken for a "free" read.
  const cacheTooltip =
    cache !== null
      ? `缓存命中率 = 缓存读取 /（输入 + 缓存读取 + 缓存写入）= ${formatTokens(usage.cacheRead)} /（${formatTokens(usage.input)} + ${formatTokens(usage.cacheRead)} + ${formatTokens(usage.cacheWrite)}）= ${(cache * 100).toFixed(1)}%`
      : '暂无缓存命中率数据'
  const cacheAriaLabel =
    cache !== null
      ? `缓存命中率 ${(cache * 100).toFixed(0)}%（缓存读取 ${formatTokens(usage.cacheRead)} / 输入 ${formatTokens(usage.input)} + 缓存读取 ${formatTokens(usage.cacheRead)} + 缓存写入 ${formatTokens(usage.cacheWrite)}）`
      : undefined

  return (
    <div className="telemetry-bar" role="status" aria-label="运行指标">
      <div
        className="telemetry-item telemetry-speed"
        title={rate !== null ? (live ? '实时估算 token 速率' : '本次输出最终速率') : '暂无 token 速率数据'}
      >
        <span className="telemetry-label">速度</span>
        {rate !== null ? (
          <span className={`telemetry-value${live ? ' telemetry-live' : ''}`}>
            {live ? '≈' : ''}
            {rate.toFixed(rate < 10 ? 1 : 0)} tok/s
          </span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label="暂无速率数据">
            —
          </span>
        )}
      </div>
      <div className="telemetry-item telemetry-secondary" title={cacheTooltip}>
        <span className="telemetry-label">缓存命中</span>
        {cache !== null ? (
          <span className="telemetry-value" aria-label={cacheAriaLabel}>
            {(cache * 100).toFixed(0)}%
          </span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label="暂无缓存命中率数据">
            —
          </span>
        )}
      </div>
      <div className="telemetry-item telemetry-ctx" title={ctxTitle}>
        <span className="telemetry-label">上下文</span>
        {ctxText !== null ? (
          <span className="telemetry-value telemetry-ctx-text">{ctxText}</span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label="暂无上下文用量数据">
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
        title={ttft !== null ? `首字延迟 ${formatDuration(ttft)}` : '暂无首字延迟数据'}
      >
        <span className="telemetry-label">TTFT</span>
        {ttft !== null ? (
          <span className="telemetry-value">{formatDuration(ttft)}</span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label="暂无首字延迟数据">
            —
          </span>
        )}
      </div>
      <div
        className="telemetry-item telemetry-secondary"
        title={out !== null ? '最近一次输出的 token 数' : '暂无输出 token 数据'}
      >
        <span className="telemetry-label">最近输出</span>
        {out !== null ? (
          <span className="telemetry-value">{formatTokens(out)} tok</span>
        ) : (
          <span className="telemetry-value telemetry-na" aria-label="暂无输出 token 数据">
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
