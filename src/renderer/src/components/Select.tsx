import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

interface SelectProps {
  label: string
  value: string | null
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  width?: number
  placeholder?: string
}

export default function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  width,
  placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? null

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

  return (
    <div className={`select${open ? ' select-open' : ''}`} ref={rootRef} style={width !== undefined ? { width } : undefined}>
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
          {options.map((o) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
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
          ))}
        </ul>
      )}
    </div>
  )
}
