import { Children, isValidElement, memo, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy, TriangleAlert, X } from 'lucide-react'
import { useI18n } from '../lib/i18n'

/**
 * Safe Markdown renderer for chat messages.
 *
 * Security model:
 * - raw HTML is never rendered (no rehype-raw, no dangerouslySetInnerHTML);
 *   react-markdown escapes it to plain text by default.
 * - links are only allowed for http/https URLs; javascript:, data:, mailto:
 *   and any other scheme render as inert disabled text. The check runs on
 *   the percent-decoded href (the parser already decodes character
 *   references), so `javascript%3A...` / `&#106;avascript:...` variants are
 *   inert too.
 * - every rendered link opens in a new tab with noopener noreferrer; the
 *   fixed attributes are written after {...rest} so markdown-supplied
 *   attributes can never override them.
 * - code fences are rendered through a custom CodeBlock (language label,
 *   copy button, horizontal scrolling); inline code stays inline.
 *
 * The component is memoized so streaming updates only re-run react-markdown
 * and rehype-highlight for the block whose content actually changed;
 * historical blocks keep their previous rendered output.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:'])

function isSafeHref(href: string | undefined): href is string {
  if (!href) return false
  // Check the percent-decoded form so `javascript%3A...` can't masquerade as
  // a relative URL; the markdown parser already decodes character references
  // (`&#106;avascript:...` arrives as `javascript:...`).
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    decoded = href
  }
  try {
    return SAFE_PROTOCOLS.has(new URL(decoded.trim(), 'https://local.invalid/').protocol)
  } catch {
    return false
  }
}

/** Flatten React children (including highlight.js token spans) to plain text. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

type CopyState = 'idle' | 'ok' | 'error'

function CodeBlock({ language, text, children }: { language?: string | undefined; text: string; children: ReactNode }) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  const timerRef = useRef<number | undefined>(undefined)
  const mountedRef = useRef(true)
  const opRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      // No setState/timer may survive an unmount.
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [])

  useEffect(() => {
    if (state === 'idle') return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined
      setState('idle')
    }, 2000)
    return () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [state])

  function fallbackCopy(value: string): void {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    try {
      area.select()
      if (!document.execCommand('copy')) throw new Error('copy failed')
    } finally {
      // The fallback textarea must always be removed, even when execCommand
      // (or select) throws.
      document.body.removeChild(area)
    }
  }

  async function onCopy(): Promise<void> {
    // Each click gets a new operation id; only the latest operation may
    // publish feedback, so rapid successive copies surface the result of the
    // last click even when an earlier (slower) promise settles later.
    const op = ++opRef.current
    if (!mountedRef.current) return
    const commit = (next: CopyState): void => {
      if (op !== opRef.current || !mountedRef.current) return
      setState(next)
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        fallbackCopy(text)
      }
      commit('ok')
    } catch {
      try {
        fallbackCopy(text)
        commit('ok')
      } catch {
        commit('error')
      }
    }
  }

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{language || 'text'}</span>
        <button
          type="button"
          className="codeblock-copy"
          data-state={state}
          onClick={() => void onCopy()}
          aria-label={state === 'ok' ? t('markdown.codeCopied') : state === 'error' ? t('markdown.copyFailed') : t('markdown.copyCode')}
        >
          {state === 'ok' ? (
            <Check size={12} aria-hidden="true" />
          ) : state === 'error' ? (
            <TriangleAlert size={12} aria-hidden="true" />
          ) : (
            <Copy size={12} aria-hidden="true" />
          )}
          <span>{state === 'idle' ? t('markdown.copyCode') : state === 'ok' ? t('markdown.codeCopied') : t('markdown.copyFailed')}</span>
        </button>
        <span className="codeblock-live" role="status" aria-live="polite">
          {state === 'ok' ? t('markdown.codeCopiedLive') : state === 'error' ? t('markdown.copyFailedLive') : ''}
        </span>
      </div>
      <pre className="codeblock-pre">{children}</pre>
    </div>
  )
}

interface MarkdownProps {
  text: string
  className?: string
}

function Markdown({ text, className }: MarkdownProps) {
  const { t } = useI18n()
  return (
    <div className={className ? `md ${className}` : 'md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a({ node: _node, href, children, ...rest }) {
            if (!isSafeHref(href)) {
              return (
                <span className="md-link-disabled" title={t('markdown.blockedLink')}>
                  {children}
                </span>
              )
            }
            // {...rest} must come before the fixed target/rel so markdown-
            // supplied attributes can never override the safety ones.
            return (
              <a href={href} {...rest} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          },
          img({ node: _node, src, alt, ...rest }) {
            if (!isSafeHref(src)) {
              return (
                <span className="md-img-disabled" title={t('markdown.blockedImage')}>
                  {alt ?? t('markdown.image')}
                </span>
              )
            }
            return <img src={src} alt={alt ?? ''} {...rest} loading="lazy" />
          },
          code({ node: _node, className, children, ...rest }) {
            const isBlock = /language-[\w-]+/.test(className ?? '')
            if (isBlock) {
              // Preserve highlight.js classes (hljs, hljs-*) for token styling.
              return (
                <code className={className ? `md-code ${className}` : 'md-code'} {...rest}>
                  {children}
                </code>
              )
            }
            return (
              <code className="md-inline" {...rest}>
                {children}
              </code>
            )
          },
          pre({ node: _node, children }) {
            const [first] = Children.toArray(children)
            const codeEl = isValidElement<{ className?: string; children?: ReactNode }>(first) ? first : null
            const language = /language-([\w-]+)/.exec(codeEl?.props.className ?? '')?.[1]
            return <CodeBlock language={language} text={textOf(codeEl).replace(/\n$/, '')}>{children}</CodeBlock>
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export type { CopyState }
export { CodeBlock, isSafeHref, textOf }

// Memoize: during streaming updates the parent re-renders with the same
// text/className for historical blocks; skipping them avoids re-running
// react-markdown + rehype-highlight for content that has not changed.
export default memo(Markdown)
