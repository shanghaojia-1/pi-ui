import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useI18n } from '../lib/i18n'

interface WindowBarProps {
  /** Primary title: app name when no workspace is open, else the workspace name. */
  title: string
}

/**
 * Frameless win32 title bar: theme-following drag band (same 44px as the
 * macOS drag strip) with self-drawn minimize / maximize / close controls.
 * The whole bar is draggable; only the control buttons opt out.
 */
export default function WindowBar({ title }: WindowBarProps) {
  const { t } = useI18n()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.pi.getWindowMaximized().then(setMaximized)
    return window.pi.onMaximizedChange(setMaximized)
  }, [])

  return (
    <div className="window-bar">
      <div className="window-bar-title" title={title}>
        {title}
      </div>
      <div className="window-bar-controls">
        <button
          type="button"
          className="window-bar-btn"
          aria-label={t('windowBar.minimize')}
          title={t('windowBar.minimize')}
          onClick={() => void window.pi.minimizeWindow()}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-bar-btn"
          aria-label={maximized ? t('windowBar.restore') : t('windowBar.maximize')}
          title={maximized ? t('windowBar.restore') : t('windowBar.maximize')}
          onClick={() => void window.pi.toggleMaximizeWindow()}
        >
          {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="window-bar-btn window-bar-close"
          aria-label={t('windowBar.close')}
          title={t('windowBar.close')}
          onClick={() => void window.pi.closeWindow()}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
