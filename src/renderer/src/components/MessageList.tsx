import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { ChatMessage, TextBlock } from '@shared/contracts'
import ToolCall from './ToolCall'
import Markdown from './Markdown'

const SUGGESTIONS = [
  '探索这个项目，总结它的结构与主要模块',
  '运行测试并修复失败的部分',
  '审查最近的代码变更，指出潜在问题',
]

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`thinking${open ? ' thinking-open' : ''}`}>
      <button
        type="button"
        className="thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="思考过程"
      >
        <ChevronRight size={12} className="thinking-chevron" aria-hidden="true" />
        <Brain size={13} aria-hidden="true" />
        <span>思考</span>
        <span className="thinking-count">{text.length} 字</span>
      </button>
      {open && (
        <div className="thinking-body">
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    const text = message.blocks.filter((b): b is TextBlock => b.type === 'text')
    return (
      <div className="msg msg-user">
        <div className="msg-label">你</div>
        <div className="msg-body">
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
      <div className="msg-label">Pi</div>
      <div className="msg-body">
        {message.blocks.map((block, i) => {
          if (block.type === 'thinking') return <ThinkingBlock key={i} text={block.text} />
          if (block.type === 'tool') return <ToolCall key={block.id} tool={block} />
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
        <h1>开始新任务</h1>
        <p>
          描述你想让 Pi 在{workspaceName ? (
            <>
              {' '}
              <code>{workspaceName}</code>
            </>
          ) : null}{' '}
          中完成的工作
        </p>
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => onSuggest(s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="welcome-shortcuts">
          ⌘N 新任务 · ⌘K 聚焦输入 · ⇧⌘O 打开目录 · Enter 发送 · Esc 停止
        </div>
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
          <div className="msg-label">你</div>
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
