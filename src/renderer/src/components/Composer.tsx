import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'

export interface ComposerHandle {
  focus: () => void
}

interface ComposerProps {
  disabled: boolean
  placeholder: string
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { disabled, placeholder, running, onSend, onStop },
  ref,
) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const resize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    setText('')
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
    onSend(trimmed)
  }

  return (
    <div className="composer-wrap">
      <div className={`composer-box${disabled ? ' composer-disabled' : ''}`}>
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label="消息输入"
          onChange={(e) => {
            setText(e.target.value)
            resize()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-actions">
          {running ? (
            <button type="button" className="btn-stop" onClick={onStop} aria-label="停止运行" title="停止运行 (Esc)">
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="btn-send"
              onClick={submit}
              disabled={disabled || text.trim() === ''}
              aria-label="发送"
              title="发送 (Enter)"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        {running
          ? '运行中 — 继续输入并发送将作为 follow-up 排队'
          : 'Enter 发送 · Shift+Enter 换行 · ⌘K 聚焦输入'}
      </div>
    </div>
  )
})

export default Composer
