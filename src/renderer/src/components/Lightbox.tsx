import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useI18n } from '../lib/i18n'

interface ImageLightboxProps {
  /** data URL of the image to show full-size. */
  src: string
  alt?: string
  onClose: () => void
}

/**
 * Full-screen image viewer for clicked images. Renders a fixed overlay with
 * the image centered and scaled to fit; closes on overlay click, the close
 * button, or Escape. While open, page scroll is locked and the Escape key is
 * captured so the app's own Escape handling (abort / blur) cannot fire.
 */
export default function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useI18n()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.aria')}
      onClick={onClose}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={onClose}
        aria-label={t('lightbox.close')}
        title={t('lightbox.closeHint')}
      >
        <X size={18} aria-hidden="true" />
      </button>
      <img
        className="lightbox-img"
        src={src}
        alt={alt ?? t('lightbox.aria')}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
