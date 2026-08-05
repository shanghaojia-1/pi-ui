import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { TelemetryInfo, UsageInfo } from '../../src/shared/contracts'
import TelemetryBar from '../../src/renderer/src/components/TelemetryBar'

const usage: UsageInfo = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50, cost: 0.01 }

// renderToString emits <!-- --> between JSX text expressions; strip them for assertions.
const strip = (html: string): string => html.replace(/<!-- -->/g, '')

function telemetry(over: Partial<TelemetryInfo> = {}): TelemetryInfo {
  return {
    tokenRate: null,
    tokenRateKind: 'unavailable',
    ttftMs: null,
    cacheHitRate: null,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    contextEstimated: false,
    latestOutputTokens: null,
    ...over,
  }
}

describe('TelemetryBar', () => {
  it('renders an em dash with an explanatory tooltip for every null metric', () => {
    const html = strip(renderToString(<TelemetryBar telemetry={telemetry()} usage={usage} />))
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="运行指标"')
    // speed / cache / context / ttft / output all null → five dashes
    expect(html.match(/>—</g)).toHaveLength(5)
    expect(html).toContain('暂无 token 速率数据')
    expect(html).toContain('暂无缓存命中率数据')
    expect(html).toContain('暂无上下文用量数据')
    expect(html).toContain('暂无首字延迟数据')
    expect(html).toContain('暂无输出 token 数据')
  })

  it('live-estimate rate shows ≈ with the pulsing live class; final rate is plain', () => {
    const liveHtml = strip(
      renderToString(<TelemetryBar telemetry={telemetry({ tokenRate: 8.2, tokenRateKind: 'live-estimate' })} usage={usage} />),
    )
    expect(liveHtml).toContain('≈8.2 tok/s')
    expect(liveHtml).toContain('telemetry-live')
    expect(liveHtml).toContain('实时估算 token 速率')

    const finalHtml = strip(
      renderToString(<TelemetryBar telemetry={telemetry({ tokenRate: 120.4, tokenRateKind: 'final' })} usage={usage} />),
    )
    expect(finalHtml).toContain('120 tok/s')
    expect(finalHtml).not.toContain('≈')
    expect(finalHtml).not.toContain('telemetry-live')
    expect(finalHtml).toContain('本次输出最终速率')
  })

  it('cache hit rate renders as a percentage; title/aria state the cacheRead/(input+cacheRead+cacheWrite) formula', () => {
    const html = strip(renderToString(<TelemetryBar telemetry={telemetry({ cacheHitRate: 0.25 })} usage={usage} />))
    expect(html).toContain('25%')
    // explicit formula with cache write in the denominator (usage: 1.0k in, 200 read, 50 write)
    expect(html).toContain('缓存命中率 = 缓存读取 /（输入 + 缓存读取 + 缓存写入）')
    expect(html).toContain('200 /（1.0k + 200 + 50）')
    expect(html).toContain('缓存写入 50')
    expect(html).toContain('aria-label="缓存命中率 25%（缓存读取 200 / 输入 1.0k + 缓存读取 200 + 缓存写入 50）"')
  })

  it('context shows estimated ≈ tokens/window with a percent progress bar', () => {
    const html = strip(
      renderToString(
        <TelemetryBar
          telemetry={telemetry({ contextTokens: 1234, contextWindow: 8192, contextPercent: 15, contextEstimated: true })}
          usage={usage}
        />,
      ),
    )
    expect(html).toContain('≈1.2k / 8.2k')
    expect(html).toContain('width:15%')
    expect(html).toContain('上下文 ≈1.2k / 8.2k（15%）')
    expect(html).toContain('telemetry-ctx-fill')
  })

  it('context percent falls back to tokens/window when percent is null', () => {
    const html = strip(
      renderToString(
        <TelemetryBar telemetry={telemetry({ contextTokens: 1000, contextWindow: 2000, contextPercent: null })} usage={usage} />,
      ),
    )
    expect(html).toContain('1.0k / 2.0k') // no ≈ when not estimated
    expect(html).toContain('width:50%')
  })

  it('context without tokens renders a dash and no track', () => {
    const html = strip(
      renderToString(<TelemetryBar telemetry={telemetry({ contextTokens: null, contextWindow: 8192 })} usage={usage} />),
    )
    expect(html).toContain('— / 8.2k')
    expect(html).not.toContain('telemetry-ctx-track')
  })

  it('renders TTFT and latest output tokens when available', () => {
    const html = strip(
      renderToString(<TelemetryBar telemetry={telemetry({ ttftMs: 1250, latestOutputTokens: 512 })} usage={usage} />),
    )
    expect(html).toContain('1.3s')
    expect(html).toContain('512 tok')
  })

  it('marks secondary items so narrow screens can hide them while keeping speed/context', () => {
    const html = strip(renderToString(<TelemetryBar telemetry={telemetry()} usage={usage} />))
    expect(html.match(/telemetry-secondary/g)).toHaveLength(3) // cache, ttft, output
    expect(html).toContain('telemetry-speed')
    expect(html).toContain('telemetry-ctx')
  })
})
