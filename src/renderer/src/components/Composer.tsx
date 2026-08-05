import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowUp, ImagePlus, Square, X } from 'lucide-react'
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES, type DynamicCommand, type ImageAttachment } from '@shared/contracts'
import ImageLightbox from './Lightbox'
import { useI18n } from '../lib/i18n'

export interface ComposerHandle {
  focus: () => void
}

interface ComposerProps {
  disabled: boolean
  placeholder: string
  running: boolean
  onSend: (text: string, images?: ImageAttachment[]) => void
  onStop: () => void
  /** Slash-command dispatch; App maps ids to app actions / IPC. */
  onCommand: (commandId: string, arg: string) => void
  /** Commands contributed by extensions / prompt templates / skills. */
  extraCommands?: DynamicCommand[]
}

interface SlashCommand {
  id: string
  name: string
  argHint?: string
  descriptionKey: string
  groupKey: string
}

/** The `/` menu — a GUI mapping of pi's TUI slash commands. */
const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'new', name: 'new', descriptionKey: 'composer.slash.new', groupKey: 'composer.slash.groupSession' },
  { id: 'resume', name: 'resume', descriptionKey: 'composer.slash.resume', groupKey: 'composer.slash.groupSession' },
  { id: 'name', name: 'name', argHint: '<名称>', descriptionKey: 'composer.slash.name', groupKey: 'composer.slash.groupSession' },
  { id: 'compact', name: 'compact', argHint: '[提示词]', descriptionKey: 'composer.slash.compact', groupKey: 'composer.slash.groupSession' },
  { id: 'copy', name: 'copy', descriptionKey: 'composer.slash.copy', groupKey: 'composer.slash.groupSession' },
  { id: 'export', name: 'export', descriptionKey: 'composer.slash.export', groupKey: 'composer.slash.groupSession' },
  { id: 'session', name: 'session', descriptionKey: 'composer.slash.session', groupKey: 'composer.slash.groupSession' },
  { id: 'model', name: 'model', descriptionKey: 'composer.slash.model', groupKey: 'composer.slash.groupConfig' },
  { id: 'settings', name: 'settings', descriptionKey: 'composer.slash.settings', groupKey: 'composer.slash.groupConfig' },
  { id: 'login', name: 'login', descriptionKey: 'composer.slash.login', groupKey: 'composer.slash.groupConfig' },
  { id: 'reload', name: 'reload', descriptionKey: 'composer.slash.reload', groupKey: 'composer.slash.groupSystem' },
  { id: 'quit', name: 'quit', descriptionKey: 'composer.slash.quit', groupKey: 'composer.slash.groupSystem' },
]

/** Converts a File to a base64 attachment (data without the data: URL prefix). */
function fileToAttachment(file: File, fail: (key: string, vars?: Record<string, string>) => string): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(fail('composer.unsupportedType', { type: file.type || 'unknown' })))
      return
    }
    if (file.size > MAX_ATTACHED_IMAGE_BYTES) {
      reject(new Error(fail('composer.imageTooLarge')))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve({ data: comma >= 0 ? result.slice(comma + 1) : result, mimeType: file.type })
    }
    reader.onerror = () => reject(new Error(fail('composer.readFailed')))
    reader.readAsDataURL(file)
  })
}

const GROUP_KEY_BY_SOURCE: Record<DynamicCommand['source'], string> = {
  extension: 'composer.slash.groupExtension',
  prompt: 'composer.slash.groupPrompt',
  skill: 'composer.slash.groupSkill',
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { disabled, placeholder, running, onSend, onStop, onCommand, extraCommands },
  ref,
) {
  const { t } = useI18n()
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [zoomIndex, setZoomIndex] = useState<number | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)
  // Menu viewport position: fixed so it's never clipped by parent overflow.
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  /** Active slash-menu item; scrolled into view on keyboard navigation. */
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }))

  const resize = (): void => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }

  const addFiles = async (files: FileList | File[] | null): Promise<void> => {
    if (!files || files.length === 0 || disabled) return
    setImageError(null)
    const candidates = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (candidates.length === 0) {
      setImageError(t('composer.onlyImages'))
      return
    }
    const room = MAX_ATTACHED_IMAGES - images.length
    if (room <= 0) {
      setImageError(t('composer.maxImages', { n: MAX_ATTACHED_IMAGES }))
      return
    }
    const picked = candidates.slice(0, room)
    const results = await Promise.allSettled(picked.map((file) => fileToAttachment(file, t)))
    const ok: ImageAttachment[] = []
    const errors: string[] = []
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') ok.push(result.value)
      else errors.push(`${picked[i]?.name ?? t('markdown.image')}: ${result.reason instanceof Error ? result.reason.message : t('composer.readFailed')}`)
    })
    if (ok.length > 0) setImages((prev) => [...prev, ...ok].slice(0, MAX_ATTACHED_IMAGES))
    if (errors.length > 0) setImageError(errors.join('；'))
  }

  const removeImage = (index: number): void => {
    setImages((prev) => prev.filter((_, i) => i !== index))
    setImageError(null)
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      void addFiles(imageFiles)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    dragDepth.current = 0
    if (e.dataTransfer?.files) {
      e.preventDefault()
      void addFiles(e.dataTransfer.files)
    }
  }

  const submit = (): void => {
    const trimmed = text.trim()
    if ((!trimmed && images.length === 0) || disabled) return
    const attachments = images.length > 0 ? images : undefined
    setText('')
    setImages([])
    setImageError(null)
    const el = textareaRef.current
    if (el) el.style.height = 'auto'
    onSend(trimmed, attachments)
  }

  const canSend = text.trim() !== '' || images.length > 0

  // --- slash-command menu ------------------------------------------------
  // Opens when the input starts with `/`; matches are filtered by the typed
  // prefix. `/name <arg>` style commands keep the caret in the input until
  // the argument is typed; parameterless commands run immediately on Enter.
  const slash = text.startsWith('/') ? text.slice(1) : null
  const slashParts = slash !== null ? slash.split(/\s/, 2) : []
  const slashQuery = slashParts[0] ?? ''
  const slashArg = slashParts[1] ?? ''
  const menuOpen = slash !== null && !disabled
  const matches = useMemo(() => {
    if (slash === null) return []
    const q = slashQuery.trim().toLowerCase()
    // Built-in GUI commands + extension/template/skill commands.
    const dynamic: SlashCommand[] = (extraCommands ?? []).map((cmd) => ({
      id: `dynamic:${cmd.name}`,
      name: cmd.name,
      descriptionKey: `__dynamic__:${cmd.description ?? ''}`,
      groupKey: GROUP_KEY_BY_SOURCE[cmd.source],
      ...(cmd.argHint !== undefined ? { argHint: cmd.argHint } : {}),
    }))
    const list = [...SLASH_COMMANDS, ...dynamic]
    return q === '' ? list : list.filter((c) => c.name.startsWith(q) || c.name.includes(q))
  }, [slash, slashQuery, extraCommands])

  // Keep the selection index valid when the filtered list shrinks.
  useEffect(() => {
    setMenuIndex((i) => (matches.length === 0 ? 0 : Math.min(i, matches.length - 1)))
  }, [matches.length])

  // Keep the keyboard-highlighted menu item visible inside the scrollable
  // menu: nudge ONLY the menu's scrollTop when the selection moves, so the
  // document itself never scrolls.
  useEffect(() => {
    const item = activeItemRef.current
    const menu = item?.closest('.slash-menu')
    if (!item || !menu) return
    const menuRect = menu.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    if (itemRect.top < menuRect.top) menu.scrollTop -= menuRect.top - itemRect.top
    else if (itemRect.bottom > menuRect.bottom) menu.scrollTop += itemRect.bottom - menuRect.bottom
  }, [menuIndex])

  // Measure the composer box when the menu opens so we can fix-position
  // the menu just above it, immune to any parent overflow clipping.
  useLayoutEffect(() => {
    if (!menuOpen || matches.length === 0) { setMenuPos(null); return }
    const el = textareaRef.current?.closest('.composer-box') as HTMLElement | null
    if (!el) return
    const r = el.getBoundingClientRect()
    setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 6, width: r.width })
  }, [menuOpen, matches.length])

  const completeCommand = (cmd: SlashCommand): void => {
    setText(`/${cmd.name} `)
    setMenuIndex(0)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const runCommand = (cmd: SlashCommand, arg: string): void => {
    setText('')
    setMenuIndex(0)
    // Dynamic commands carry their description in descriptionKey; translate
    // the text part before dispatch (id is dynamic:NAME).
    const id = cmd.id.startsWith('dynamic:') ? cmd.id.slice('dynamic:'.length) : cmd.id
    onCommand(id, arg)
    textareaRef.current?.focus()
  }

  const acceptMenu = (): void => {
    const cmd = matches[menuIndex]
    if (!cmd) return
    const arg = slashArg.trim()
    if (cmd.argHint !== undefined && arg === '') {
      // Needs an argument: complete `/name ` and let the user type it.
      completeCommand(cmd)
      return
    }
    runCommand(cmd, arg)
  }

  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        acceptMenu()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        acceptMenu()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setText('')
        setMenuIndex(0)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer-wrap">
      <div
        className={`composer-box${disabled ? ' composer-disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) e.dataTransfer.dropEffect = 'copy'
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          dragDepth.current += 1
        }}
        onDragLeave={(e) => {
          e.preventDefault()
          dragDepth.current -= 1
          if (dragDepth.current <= 0) dragDepth.current = 0
        }}
        onDrop={handleDrop}
      >
        {images.length > 0 ? (
          <div className="composer-attachments">
            {images.map((image, i) => (
              <div className="composer-attachment" key={`${image.mimeType}-${i}`}>
                <button
                  type="button"
                  className="attachment-preview"
                  onClick={() => setZoomIndex(i)}
                  aria-label={t('composer.previewImage', { n: i + 1 })}
                  title={t('messages.zoomImage')}
                >
                  <img src={`data:${image.mimeType};base64,${image.data}`} alt={t('composer.attachmentAlt', { n: i + 1 })} />
                </button>
                <button
                  type="button"
                  className="attachment-remove"
                  onClick={() => removeImage(i)}
                  aria-label={t('composer.removeImage', { n: i + 1 })}
                  title={t('common.close')}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {zoomIndex !== null && images[zoomIndex] ? (
          <ImageLightbox
            src={`data:${images[zoomIndex].mimeType};base64,${images[zoomIndex].data}`}
            onClose={() => setZoomIndex(null)}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={t('composer.aria')}
          onChange={(e) => {
            setText(e.target.value)
            resize()
          }}
          onPaste={handlePaste}
          onKeyDown={onInputKeyDown}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="btn-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label={t('composer.attachImage')}
            title={t('composer.attachHint')}
          >
            <ImagePlus size={15} aria-hidden="true" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          {running ? (
            <button type="button" className="btn-stop" onClick={onStop} aria-label={t('composer.stop')} title={t('composer.stopHint')}>
              <Square size={14} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="btn-send"
              onClick={submit}
              disabled={disabled || !canSend}
              aria-label={t('composer.send')}
              title={t('composer.sendHint')}
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {menuOpen && matches.length > 0 && menuPos !== null ? (
        <div
          className="slash-menu"
          role="listbox"
          aria-label={t('composer.slashAria')}
          style={{ position: 'fixed', left: menuPos.left, bottom: menuPos.bottom, width: menuPos.width }}
        >
          {matches.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              role="option"
              aria-selected={i === menuIndex}
              ref={i === menuIndex ? activeItemRef : undefined}
              className={`slash-item${i === menuIndex ? ' slash-item-active' : ''}`}
              onMouseEnter={() => setMenuIndex(i)}
              onClick={() => {
                const arg = slashArg.trim()
                if (cmd.argHint !== undefined && arg === '') completeCommand(cmd)
                else runCommand(cmd, arg)
              }}
            >
              <span className="slash-name">/{cmd.name}</span>
              {cmd.argHint !== undefined ? <span className="slash-arg">{cmd.argHint}</span> : null}
              <span className="slash-desc">
                {cmd.descriptionKey.startsWith('__dynamic__:')
                  ? cmd.descriptionKey.slice('__dynamic__:'.length)
                  : t(cmd.descriptionKey)}
              </span>
              <span className="slash-group">{t(cmd.groupKey)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {imageError !== null ? <div className="composer-error">{imageError}</div> : null}
      <div className="composer-hint">
        {running ? t('composer.hint.running') : t('composer.hint.idle')}
      </div>
    </div>
  )
})

export default Composer
