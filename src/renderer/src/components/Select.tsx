import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

export interface SelectGroup {
  label: string
  options: SelectOption[]
}

interface SelectProps {
  label: string
  value: string | null
  options?: SelectOption[]
  /** Optional group headers (e.g. model picker grouped by provider). */
  groups?: SelectGroup[]
  onChange: (value: string) => void
  disabled?: boolean
  /** Fixed width in px (trigger content ellipsizes). */
  width?: number
  /** Adaptive sizing: the trigger grows with its content, clamped between these. */
  minWidth?: number
  maxWidth?: number
  placeholder?: string
}

export default function Select({
  label,
  value,
  options,
  groups,
  onChange,
  disabled = false,
  width,
  minWidth,
  maxWidth,
  placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const flat = groups !== undefined ? groups.flatMap((g) => g.options.map((o) => ({ ...o, group: g.label }))) : (options ?? []).map((o) => ({ ...o, group: undefined }))
  const current = flat.find((o) => o.value === value) ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const containerStyle: CSSProperties | undefined =
    width !== undefined
      ? { width }
      : minWidth !== undefined || maxWidth !== undefined
        ? { width: 'max-content', minWidth, maxWidth }
        : undefined

  return (
    <div className={`select${open ? ' select-open' : ''}`} ref={rootRef} style={containerStyle}>
      <button
        type="button"
        className="select-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={current ? current.label : placeholder}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-label">{label}</span>
        <span className="select-value">{current ? current.label : (placeholder ?? '—')}</span>
        <ChevronDown size={13} className="select-chevron" aria-hidden="true" />
      </button>
      {open && (
        <ul className="select-menu" role="listbox" aria-label={label}>
          {flat.map((o, i) => {
            const header = o.group !== undefined && (i === 0 || flat[i - 1]!.group !== o.group)
            return (
              <li key={o.value}>
                {header ? <span className="select-group-label">{o.group}</span> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className="select-item"
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                >
                  <span className="select-item-label">{o.label}</span>
                  {o.hint !== undefined ? <span className="select-item-hint">{o.hint}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
