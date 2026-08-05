// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import Markdown from '../../src/renderer/src/components/Markdown'
import MessageList from '../../src/renderer/src/components/MessageList'
import { I18nProvider } from '../../src/renderer/src/lib/i18n'
import type { ChatMessage } from '../../src/shared/contracts'
import { type ReactElement } from 'react'

/** All renders run inside the I18nProvider so t() resolves real strings. */
function renderI18n(ui: ReactElement) {
  return render(<I18nProvider initialLang="zh">{ui}</I18nProvider>)
}

/**
 * Render-count instrumentation: wrap react-markdown's default export in a
 * counting component so tests can observe whether historical (unchanged)
 * markdown blocks are re-invoked during streaming updates. The wrapper
 * delegates to the real implementation, so all other assertions keep
 * exercising the real parser and highlighter.
 */
const { markdownRenderLog } = vi.hoisted(() => ({ markdownRenderLog: { count: 0 } }))

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>()
  function CountingReactMarkdown(props: ComponentProps<typeof actual.default>) {
    markdownRenderLog.count += 1
    return createElement(actual.default, props)
  }
  return { ...actual, default: CountingReactMarkdown }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  markdownRenderLog.count = 0
})

function renderMarkdown(text: string) {
  return renderI18n(<Markdown text={text} />)
}

describe('Markdown rendering', () => {
  it('renders headings, paragraphs, emphasis, lists, blockquote and hr', () => {
    const { container } = renderMarkdown(
      '# 标题\n\n**粗体** and *斜体*\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用\n\n---\n',
    )
    expect(container.querySelector('h1')?.textContent).toBe('标题')
    expect(container.querySelector('strong')?.textContent).toBe('粗体')
    expect(container.querySelector('em')?.textContent).toBe('斜体')
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelector('blockquote')?.textContent).toContain('引用')
    expect(container.querySelector('hr')).not.toBeNull()
  })

  it('renders GFM tables, strikethrough and task lists', () => {
    const { container } = renderMarkdown(
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n~~划掉~~\n\n- [x] 完成\n- [ ] 未完成\n',
    )
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.querySelectorAll('th')).toHaveLength(2)
    expect(table?.querySelectorAll('td')).toHaveLength(2)
    expect(container.querySelector('del')?.textContent).toBe('划掉')
    const checks = container.querySelectorAll('input[type="checkbox"]')
    expect(checks).toHaveLength(2)
    expect((checks[0] as HTMLInputElement).checked).toBe(true)
    expect((checks[1] as HTMLInputElement).checked).toBe(false)
    expect((checks[0] as HTMLInputElement).disabled).toBe(true)
  })

  it('keeps single newlines as line breaks (chat wrapping)', () => {
    const { container } = renderMarkdown('第一行\n第二行\n\n第三行')
    expect(container.querySelectorAll('br')).toHaveLength(1)
    expect(container.textContent).toContain('第二行')
  })

  it('strictly separates inline code from fenced blocks', () => {
    const { container } = renderMarkdown('行内 `code` 和块：\n\n```js\nconst x = 1\n```\n')
    const inline = container.querySelector('code.md-inline')
    expect(inline?.textContent).toBe('code')
    // inline code must not live inside a pre/codeblock
    expect(container.querySelector('.codeblock code.md-inline')).toBeNull()
    const block = container.querySelector('.codeblock')
    expect(block).not.toBeNull()
    expect(block?.querySelector('.codeblock-lang')?.textContent).toBe('js')
    expect(block?.querySelector('pre.codeblock-pre code')).not.toBeNull()
  })

  it('applies highlight.js language classes to fenced code', () => {
    const { container } = renderMarkdown('```python\ndef f():\n    return 1\n```\n')
    const code = container.querySelector('.codeblock-pre code')
    expect(code?.className).toContain('hljs')
    expect(code?.className).toContain('language-python')
    expect(container.querySelector('.hljs-keyword, .hljs-title, .hljs-number')).not.toBeNull()
  })

  it('does not crash on an unclosed fence (streaming)', () => {
    const { container } = renderMarkdown('先看这段：\n\n```js\nconst x = 42\n')
    expect(container.textContent).toContain('const x = 42')
    expect(container.textContent).toContain('先看这段')
  })

  it('renders unknown languages without crashing', () => {
    const { container } = renderMarkdown('```notalang\nfoo\n```\n')
    expect(container.querySelector('.codeblock')).not.toBeNull()
    expect(container.textContent).toContain('foo')
  })
})

describe('Markdown link safety', () => {
  it('opens http/https links in a new tab with noopener noreferrer', () => {
    const { container } = renderMarkdown('[官网](https://example.com/a) 和 [http](http://example.com)\n')
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toContain('noopener')
      expect(link.getAttribute('rel')).toContain('noreferrer')
    }
  })

  it('keeps the fixed safety attributes even when rest supplies its own', () => {
    // react-markdown v10 hands arbitrary attributes through {...rest} on the
    // a component; target/rel must not be overridable from markdown.
    const { container } = renderMarkdown('[x](https://example.com/a)\n')
    const link = container.querySelector('a')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noopener')
    expect(link?.getAttribute('rel')).toContain('noreferrer')
  })

  it('renders javascript:/data: links as inert text, not anchors', () => {
    const { container } = renderMarkdown(
      '[bad](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>) [mail](mailto:x@y.z)\n',
    )
    expect(container.querySelectorAll('a')).toHaveLength(0)
    const inert = container.querySelectorAll('.md-link-disabled')
    expect(inert).toHaveLength(3)
    expect(container.textContent).toContain('bad')
  })

  it.each([
    ['uppercase scheme', '[x](JaVaScRiPt:alert(1))'],
    ['leading whitespace', '[x]( javascript:alert(1))'],
    ['percent-encoded letters', '[x](java%73cript:alert(1))'],
    ['percent-encoded colon', '[x](javascript%3Aalert(1))'],
    ['entity-encoded letters', '[x](&#106;avascript:alert(1))'],
    ['uppercase data', '[x](DaTa:text/html,<b>x</b>)'],
    ['percent-encoded data colon', '[x](data%3Atext/html,<b>x</b>)'],
    ['entity-encoded data', '[x](&#100;ata:text/html,<b>x</b>)'],
    ['uppercase mailto', '[x](MAILTO:user@example.com)'],
    ['percent-encoded mailto colon', '[x](mailto%3Auser@example.com)'],
    ['entity-encoded mailto', '[x](&#109;ailto:user@example.com)'],
  ])('renders %s javascript/data/mailto links as inert text, not anchors', (_label, md) => {
    const { container } = renderMarkdown(md)
    expect(container.querySelectorAll('a')).toHaveLength(0)
    const inert = container.querySelectorAll('.md-link-disabled')
    expect(inert).toHaveLength(1)
    expect(inert[0]?.textContent).toBe('x')
  })
})

describe('Markdown raw HTML', () => {
  it('never executes or renders raw HTML', () => {
    const { container } = renderMarkdown('<img src="x" onerror="alert(1)"> <script>alert(1)</script>\n')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img')
    expect(container.textContent).toContain('<script>')
  })
})

describe('Markdown memoization under streaming updates', () => {
  function assistant(id: string, blocks: ChatMessage['blocks']): ChatMessage {
    return { id, role: 'assistant', blocks }
  }

  function list(messages: ChatMessage[]) {
    // The provider must be INSIDE the tree so rerender() keeps it mounted;
    // wrapping only at render() time would unmount it on every rerender.
    return (
      <I18nProvider initialLang="zh">
        <MessageList messages={messages} pendingText={null} workspaceName={null} onSuggest={() => undefined} />
      </I18nProvider>
    )
  }

  it('re-runs react-markdown only for the block whose content changed', () => {
    const first = assistant('m1', [{ type: 'text', text: '稳定的历史块' }])
    const second = assistant('m2', [{ type: 'text', text: '当前流式块' }])
    const { rerender, container } = render(list([first, second]))
    expect(markdownRenderLog.count).toBe(2)

    // A new assistant message arrives while the stream continues.
    const third = assistant('m3', [{ type: 'text', text: '第三条' }])
    rerender(list([first, second, third]))
    // Only the new block renders; both historical blocks are skipped.
    expect(markdownRenderLog.count).toBe(3)

    // The streaming block grows: only it re-runs react-markdown/highlight.
    rerender(list([first, second, assistant('m3', [{ type: 'text', text: '第三条（继续增长）' }])]))
    expect(markdownRenderLog.count).toBe(4)
    expect(container.textContent).toContain('第三条（继续增长）')
    expect(container.textContent).toContain('稳定的历史块')
  })

  it('keeps user markdown (with className) stable while other blocks stream', () => {
    const user: ChatMessage = { id: 'u1', role: 'user', blocks: [{ type: 'text', text: '用户问题' }] }
    const assistantMsg = assistant('a1', [{ type: 'text', text: '回答' }])
    const { rerender } = render(list([user, assistantMsg]))
    expect(markdownRenderLog.count).toBe(2)

    rerender(list([user, assistant('a1', [{ type: 'text', text: '回答变长了' }])]))
    // The user block's text/className are unchanged: only the assistant block re-renders.
    expect(markdownRenderLog.count).toBe(3)
  })
})

describe('CodeBlock copy button', () => {
  function codeMarkdown() {
    return '```ts\nconst answer = 42\n```\n'
  }

  function stubClipboard(writeText: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value: writeText, configurable: true })
  }

  it('copies the raw code text and announces success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })
    renderMarkdown(codeMarkdown())
    const button = screen.getByRole('button', { name: '复制代码' })
    fireEvent.click(button)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const answer = 42'))
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制到剪贴板' })).toBeTruthy())
    expect(screen.getByRole('status').textContent).toBe('代码已复制到剪贴板')
  })

  it('announces failure when the clipboard is unavailable', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    stubClipboard({ writeText })
    renderMarkdown(codeMarkdown())
    const button = screen.getByRole('button', { name: '复制代码' })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('button', { name: '复制失败' })).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('复制失败')
  })

  it('removes the fallback textarea even when execCommand throws', async () => {
    stubClipboard(undefined)
    const exec = vi.fn(() => {
      throw new Error('execCommand denied')
    })
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    try {
      renderMarkdown(codeMarkdown())
      fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
      await waitFor(() => expect(screen.getByRole('button', { name: '复制失败' })).toBeTruthy())
      expect(exec).toHaveBeenCalled() // the fallback reached execCommand and it threw
      // try/finally must always remove the temporary textarea.
      expect(document.body.querySelector('textarea')).toBeNull()
    } finally {
      delete (document as { execCommand?: unknown }).execCommand
    }
  })

  it('keeps the feedback of the last copy when an earlier slower success settles later', async () => {
    let resolveFirst!: () => void
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => Promise.reject(new Error('denied')))
    stubClipboard({ writeText })
    renderMarkdown(codeMarkdown())
    const button = screen.getByRole('button', { name: '复制代码' })
    fireEvent.click(button) // first copy: slow success
    fireEvent.click(button) // second copy: fast failure — last feedback wins
    await waitFor(() => expect(screen.getByRole('button', { name: '复制失败' })).toBeTruthy())
    await act(async () => {
      resolveFirst()
    })
    // The stale success from the first copy must not clobber the last feedback.
    expect(screen.getByRole('button', { name: '复制失败' })).toBeTruthy()
  })

  it('shows the feedback of the last copy when an earlier slower failure settles later', async () => {
    let rejectFirst!: (reason: Error) => void
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (rejectFirst = reject)))
      .mockResolvedValueOnce(undefined)
    stubClipboard({ writeText })
    renderMarkdown(codeMarkdown())
    const button = screen.getByRole('button', { name: '复制代码' })
    fireEvent.click(button) // first copy: slow failure
    fireEvent.click(button) // second copy: fast success — must win
    await waitFor(() => expect(screen.getByRole('button', { name: '已复制到剪贴板' })).toBeTruthy())
    await act(async () => {
      rejectFirst(new Error('late failure'))
    })
    expect(screen.getByRole('button', { name: '已复制到剪贴板' })).toBeTruthy()
  })

  it('unmounting while a copy is pending causes no state updates or errors', async () => {
    let resolve!: () => void
    const writeText = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    stubClipboard({ writeText })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderMarkdown(codeMarkdown())
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    unmount()
    await act(async () => {
      resolve()
    })
    expect(errorSpy).not.toHaveBeenCalled()
    expect(document.body.querySelector('textarea')).toBeNull()
  })

  it('clears the feedback timer on unmount', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard({ writeText })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderMarkdown(codeMarkdown())
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await act(async () => {}) // flush the copy promise so the ok-feedback timer is scheduled
    expect(screen.getByRole('button', { name: '已复制到剪贴板' })).toBeTruthy()
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(3000) // a leaked timer would fire here
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('MessageList markdown wiring', () => {
  function message(blocks: ChatMessage['blocks'], extra?: Partial<ChatMessage>): ChatMessage {
    return { id: 'm1', role: 'assistant', blocks, ...extra }
  }

  it('renders assistant text and thinking blocks as markdown', () => {
    const messages = [
      message([
        { type: 'thinking', text: '思考：\n- 步骤一\n- 步骤二' },
        { type: 'text', text: '# 结论\n\n```py\nprint(1)\n```\n' },
      ]),
      message([{ type: 'text', text: '**你好**' }], { role: 'user', id: 'u1' }),
    ]
    const { container } = renderI18n(
      <MessageList messages={messages} pendingText={null} workspaceName={null} onSuggest={() => undefined} />,
    )
    const thinking = container.querySelector('.thinking-body')
    expect(thinking?.querySelector('ul li')).not.toBeNull()
    const assistant = container.querySelector('.msg-assistant .msg-body > .md')
    expect(assistant?.querySelector('h1')?.textContent).toBe('结论')
    expect(assistant?.querySelector('.codeblock')).not.toBeNull()
    const user = container.querySelector('.msg-user .md')
    expect(user?.querySelector('strong')?.textContent).toBe('你好')
  })
})
