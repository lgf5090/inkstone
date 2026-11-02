/**
 * A file picker whose button is ours.
 *
 * The browser's native file control renders its button text in the browser's language, ignores the
 * app's type scale and can sit below the 24px pointer floor. The input stays in the DOM for the file
 * dialog; the visible control is a normal Button with an accessible name and a filename readout.
 */
import { useRef } from 'react'
import { Button } from '../../components/primitives'

interface CalendarFilePickerProps {
  id?: string
  'aria-describedby'?: string
  label: string
  accept?: string
  multiple?: boolean
  disabled?: boolean
  fileName?: string | null
  onPick: (files: FileList) => void
}

export function CalendarFilePicker({
  id,
  'aria-describedby': describedBy,
  label,
  accept,
  multiple = false,
  disabled = false,
  fileName,
  onPick,
}: CalendarFilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        hidden
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(event) => {
          const files = event.target.files
          if (files && files.length > 0) onPick(files)
          // The same file may be picked again after a refusal; an unchanged value fires no change.
          event.target.value = ''
        }}
      />
      <Button
        id={id}
        aria-describedby={describedBy}
        size="sm"
        variant="secondary"
        aria-label={label}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </Button>
      {fileName && (
        <span className="min-w-0 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]" title={fileName}>
          {fileName}
        </span>
      )}
    </div>
  )
}
