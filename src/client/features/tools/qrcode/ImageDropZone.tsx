import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '../../../components/primitives'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { acceptQrImageFile } from './accept-qr-image'

/**
 * A file picker with the two other ways people actually get an image here: dropping it, and pasting it
 * (the page-level paste listener lives with the view that owns the result).
 *
 * The drop target is a container, not the control: the clickable affordance is the button below, so a
 * keyboard reaches it and a screen reader announces a button rather than an area that happens to answer
 * clicks.
 */
export function ImageDropZone({
  label,
  hint,
  onFile,
  className,
  bodyClassName,
}: {
  label: string
  hint?: string
  onFile: (file: File) => void
  className?: string
  bodyClassName?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const accept = (file: File | undefined) => {
    const usable = acceptQrImageFile(file)
    if (usable) onFile(usable)
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        accept(event.dataTransfer.files?.[0])
      }}
      className={cn(
        'flex w-full flex-col items-center justify-center gap-2 rounded-[var(--r-md)] border-2 border-dashed p-4 text-center',
        over ? 'border-[var(--accent)] bg-[var(--bg-hover)]' : 'border-[var(--border-subtle)]',
        className
      )}
    >
      <div className={cn('flex flex-1 flex-col items-center justify-center gap-2', bodyClassName)}>
        <Upload size={24} aria-hidden="true" className="text-[var(--text-tertiary)]" />
        <span className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{label}</span>
        {hint && <span className="max-w-sm text-[length:var(--text-11)] text-[var(--text-quaternary)]">{hint}</span>}
      </div>
      <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
        {t('tools.qrcode.scanner.choose_image')}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          accept(event.target.files?.[0])
          event.target.value = ''
        }}
      />
    </div>
  )
}
