/**
 * One side's text, as the reader can put it there.
 *
 * A drop target and a button, not a styled file input: the control a keyboard reaches is the button,
 * and the hidden `<input type=file>` behind it only carries the picker. The text area is the fallback
 * for the copy a reader has in the clipboard rather than in a file.
 */
import { useRef, useState } from 'react'
import { FileText, Upload, X } from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Tooltip } from '../../../../components/overlay'
import { SelectMenu } from '../../../../components/select-menu'
import { Textarea } from '../../../../components/form'
import { cn } from '../../../../lib/cn'
import { t } from '../../../../lib/i18n'
import type { TextEncoding } from '@shared/tools/compare/encoding'
import type { CompareSide } from '../store'

const ENCODINGS: readonly { value: TextEncoding; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'gbk', label: 'GBK' },
]

export interface TextSideCardProps {
  side: CompareSide
  label: string
  placeholder: string
  onChange: (text: string) => void
  onFile: (file: File, encoding?: TextEncoding) => void
  onClear: () => void
  busy?: boolean
  error?: 'unknown-encoding' | 'binary' | 'too-large' | 'decode-failed' | null
  onPickEncoding?: (encoding: TextEncoding) => void
  progress?: string | null
}

export function TextSideCard({
  side,
  label,
  placeholder,
  onChange,
  onFile,
  onClear,
  busy,
  error,
  onPickEncoding,
  progress,
}: TextSideCardProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <section
      aria-label={label}
      className="flex min-h-0 flex-col gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2.5"
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileText size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
          <h3 className="truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">{label}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {side.encoding && (
            <span className="rounded-full border border-[var(--border-subtle)] px-1.5 py-0.5 font-mono text-[length:var(--text-10-5)] uppercase text-[var(--text-tertiary)]">
              {side.encoding}
            </span>
          )}
          {side.name && (
            <span className="max-w-[140px] truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]" title={side.name}>
              {side.name}
            </span>
          )}
          <Tooltip label={t('tools.compare.text.clear')}>
            <IconButton size="sm" label={t('tools.compare.text.clear')} onClick={onClear} disabled={!side.text}>
              <X size={13} />
            </IconButton>
          </Tooltip>
        </div>
      </header>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          const file = event.dataTransfer.files?.[0]
          if (file) onFile(file)
        }}
        className={cn(
          'flex min-h-0 flex-1 rounded-[var(--r-sm)] border transition-colors duration-[var(--dur-fast)]',
          over ? 'border-[var(--accent)]' : 'border-transparent',
        )}
      >
        <Textarea
          value={side.text}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
          spellCheck={false}
          className="min-h-[160px] flex-1 resize-none font-mono text-[length:var(--text-12)]"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="secondary" loading={busy} onClick={() => inputRef.current?.click()}>
          <span className="flex items-center gap-1"><Upload size={13} aria-hidden="true" />{t('tools.compare.text.import_file')}</span>
        </Button>
        {progress && <span className="font-mono text-[length:var(--text-11)] text-[var(--text-tertiary)]">{progress}</span>}
      </div>

      {error === 'unknown-encoding' && (
        <div className="flex flex-col gap-1.5 rounded-[var(--r-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-2">
          <p className="text-[length:var(--text-11)] text-[var(--danger)]">{t('tools.compare.text.encoding_unknown')}</p>
          <div className="flex items-center gap-2">
            <span className="text-[length:var(--text-11)] text-[var(--text-secondary)]">{t('tools.compare.text.encoding_choose')}</span>
            <SelectMenu
              label={t('tools.compare.text.encoding_choose')}
              value={'utf-8'}
              options={ENCODINGS.map((encoding) => ({ value: encoding.value, label: encoding.label }))}
              onChange={(value) => onPickEncoding?.(value)}
              size="sm"
              width={160}
            />
          </div>
        </div>
      )}
      {error === 'binary' && (
        <p className="rounded-[var(--r-sm)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-[length:var(--text-11)] text-[var(--warning)]">
          {t('tools.compare.text.encoding_binary')}
        </p>
      )}
      {error === 'too-large' && (
        <p className="rounded-[var(--r-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-2 text-[length:var(--text-11)] text-[var(--danger)]">
          {t('tools.compare.text.file_too_large')}
        </p>
      )}
      {error === 'decode-failed' && (
        <p className="rounded-[var(--r-sm)] border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-2 text-[length:var(--text-11)] text-[var(--danger)]">
          {t('tools.compare.text.decode_failed')}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-label={label}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ''
        }}
      />
    </section>
  )
}
