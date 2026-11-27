import { useDialogFocus } from './use-dialog-focus'
import { Button, IconButton } from '../../../components/primitives'
import { useEffect } from 'react'
import { X } from 'lucide-react'
import { t } from '../../../lib/i18n'

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const ref = useDialogFocus<HTMLDivElement>()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="reader-lightbox" role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1} ref={ref}>
      <div className="reader-lightbox-toolbar">
        <Button size="sm" variant="secondary" onClick={onClose}>{t('common.close')}</Button>
        <IconButton label={t('common.close')} size="sm" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <img src={src} alt={alt} className="reader-lightbox-image" />
    </div>
  )
}
