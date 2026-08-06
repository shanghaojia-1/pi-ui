import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronRight, UserRound } from 'lucide-react'
import type { ChatMessage, ImageBlock, TextBlock } from '@shared/contracts'
import ToolCall from './ToolCall'
import Markdown from './Markdown'
import ImageLightbox from './Lightbox'
import { useI18n } from '../lib/i18n'
import { getThemeDefinition, useTheme } from '../lib/theme'

const SUGGESTION_KEYS = [
  'messages.suggest.explore',
  'messages.suggest.test',
  'messages.suggest.review',
]

const USER_AVATAR_PREVIEW = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d5aa7e"/><stop offset="1" stop-color="#8d5361"/></linearGradient></defs>
    <rect width="256" height="256" rx="56" fill="#251c21"/>
    <circle cx="128" cy="91" r="43" fill="url(#g)"/>
    <path d="M48 224c7-51 36-78 80-78s73 27 80 78" fill="url(#g)"/>
  </svg>
`)}`

const PI_AVATAR_PREVIEW = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d97b4a"/><stop offset="1" stop-color="#9c5a2b"/></linearGradient></defs>
    <rect width="256" height="256" rx="56" fill="#211f1c"/>
    <circle cx="128" cy="128" r="88" fill="url(#g)"/>
    <text x="128" y="166" text-anchor="middle" font-family="Georgia,serif" font-size="126" font-weight="700" fill="white">π</text>
  </svg>
`)}`

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

function MessageAvatar({ role }: { role: 'user' | 'assistant' }) {
  const { t } = useI18n()
  const { theme } = useTheme()
  const [zoom, setZoom] = useState(false)
  const label = role === 'user' ? t('messages.avatar.user') : t('messages.avatar.agent')
  const src = role === 'user' ? USER_AVATAR_PREVIEW : (getThemeDefinition(theme).avatar ?? PI_AVATAR_PREVIEW)

  return (
    <>
      <button
        type="button"
        className={`msg-avatar msg-avatar-${role}`}
        onClick={() => setZoom(true)}
        aria-label={label}
        title={label}
      >
        {role === 'user' ? <UserRound size={16} strokeWidth={2.2} aria-hidden="true" /> : <span className="msg-avatar-pi">π</span>}
      </button>
      {zoom ? <ImageLightbox src={src} alt={label} variant="avatar" onClose={() => setZoom(false)} /> : null}
    </>
  )
}

function Message({ message }: { message: ChatMessage }) {
  const { t } = useI18n()
  if (message.role === 'user') {
    const text = message.blocks.filter((b): b is TextBlock => b.type === 'text')
    const images = message.blocks.filter((b): b is ImageBlock => b.type === 'image')
    return (
      <div className="msg msg-user">
        <MessageAvatar role="user" />
        <div className="msg-content">
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
      <MessageAvatar role="assistant" />
      <div className="msg-content">
        <div className="msg-label">Pi</div>
        <div className="msg-body">
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
          <MessageAvatar role="user" />
          <div className="msg-content">
            <div className="msg-label">{t('common.you')}</div>
            <div className="msg-body">
              <p className="msg-text">
                {pendingText}
                <span className="msg-pending" aria-hidden="true" />
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
