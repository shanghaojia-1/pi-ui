import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { ChatMessage, ImageBlock, TextBlock } from '@shared/contracts'
import ToolCall from './ToolCall'
import Markdown from './Markdown'
import ImageLightbox from './Lightbox'
import { useI18n } from '../lib/i18n'

const SUGGESTION_KEYS = [
  'messages.suggest.explore',
  'messages.suggest.test',
  'messages.suggest.review',
]

function ThinkingBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const { t } = useI18n()
  // Thinking is shown EXPANDED by default so the model's reasoning is visible;
  // while streaming it stays open and keeps updating.
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  const idle = text.trim() === ''
  return (
    <div className={`thinking${open ? ' thinking-open' : ''}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t('messages.thinking')}
      >
        <ChevronRight size={12} className="thinking-chevron" aria-hidden="true" />
        <Brain size={13} aria-hidden="true" />
        <span>{t('messages.thinking')}</span>
        <span className="thinking-count">{idle ? t('messages.thinkingInProgress') : t('messages.thinkingCount', { n: text.length })}</span>
      </button>
      {open && (
        <div className="thinking-body">
          {idle ? (
            <span className="thinking-idle">{t('messages.thinkingIdle')}</span>
          ) : (
            <>
              <Markdown text={text} />
              {streaming ? <span className="msg-cursor" aria-hidden="true" /> : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ImageAttachmentBlock({ block }: { block: ImageBlock }) {
  const { t } = useI18n()
  const [zoom, setZoom] = useState(false)
  return (
    <div className="msg-image">
      <button
        type="button"
        className="msg-image-btn"
        onClick={() => setZoom(true)}
        aria-label={t('messages.zoomImage')}
        title={t('messages.zoomImage')}
      >
        <img src={`data:${block.mimeType};base64,${block.data}`} alt={t('messages.imageAlt')} />
      </button>
      {zoom ? (
        <ImageLightbox
          src={`data:${block.mimeType};base64,${block.data}`}
          onClose={() => setZoom(false)}
        />
      ) : null}
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  const { t } = useI18n()
  if (message.role === 'user') {
    const text = message.blocks.filter((b): b is TextBlock => b.type === 'text')
    const images = message.blocks.filter((b): b is ImageBlock => b.type === 'image')
    return (
      <div className="msg msg-user">
        <div className="msg-label">{t('common.you')}</div>
        <div className="msg-body">
          {images.map((b, i) => (
            <ImageAttachmentBlock key={i} block={b} />
          ))}
          {text.map((b, i) => (
            <Markdown key={i} text={b.text} className="msg-text" />
          ))}
        </div>
      </div>
    )
  }

  if (message.role === 'tool') {
    const block = message.blocks[0]
    if (!block || block.type !== 'tool') return null
    return <ToolCall tool={block} />
  }

  return (
    <div className="msg msg-assistant">
      <div className="msg-label">Pi</div>      <div className="msg-body">
        {message.blocks.map((block, i) => {
          if (block.type === 'thinking') {
            return <ThinkingBlock key={i} text={block.text} streaming={message.isStreaming === true} />
          }
          if (block.type === 'tool') return <ToolCall key={block.id} tool={block} />
          if (block.type === 'image') return <ImageAttachmentBlock key={i} block={block} />
          return block.text !== '' ? <Markdown key={i} text={block.text} /> : null
        })}
        {message.isStreaming === true ? <span className="msg-cursor" aria-hidden="true" /> : null}
      </div>
    </div>
  )
}

interface MessageListProps {
  messages: ChatMessage[]
  pendingText: string | null
  workspaceName: string | null
  onSuggest: (text: string) => void
}

export default function MessageList({ messages, pendingText, workspaceName, onSuggest }: MessageListProps) {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: ChatMessage[] = []
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const b of message.blocks) if (b.type === 'tool') seen.add(b.id)
        out.push(message)
        continue
      }
      if (message.role === 'tool') {
        const block = message.blocks[0]
        if (block && block.type === 'tool' && seen.has(block.id)) continue
      }
      out.push(message)
    }
    return out
  }, [messages])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, pendingText])

  if (messages.length === 0 && pendingText === null) {
    return (
      <div className="welcome">
        <h1>{t('messages.welcome.title')}</h1>
        <p>
          {t('messages.welcome.desc')}
          {workspaceName ? (
            <>
              {' '}
              <code>{workspaceName}</code>
            </>
          ) : null}
          {t('messages.welcome.desc2')}
        </p>
        <div className="suggestions">
          {SUGGESTION_KEYS.map((key) => (
            <button key={key} type="button" onClick={() => onSuggest(t(key))}>
              {t(key)}
            </button>
          ))}
        </div>
        <div className="welcome-shortcuts">{t('messages.welcome.shortcuts')}</div>
      </div>
    )
  }

  return (
    <div
      className="messages"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      }}
      aria-live="polite"
    >
      {items.map((message) => (
        <Message key={message.id} message={message} />
      ))}
      {pendingText !== null ? (
        <div className="msg msg-user">
          <div className="msg-label">{t('common.you')}</div>
          <div className="msg-body">
            <p className="msg-text">
              {pendingText}
              <span className="msg-pending" aria-hidden="true" />
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}
