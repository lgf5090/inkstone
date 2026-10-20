/**
 * The one place a provider or model gets its mark.
 *
 * Four sources sit behind a tab each: the built-in brands, emoji, Lucide, and an uploaded image. Choosing
 * an item closes the dialog because the choice is the whole task; "Use default" returns the row to the
 * inferred brand. The upload runs through a local canvas, so what leaves the browser is a 96 px mark, not
 * the reader's original photograph.
 */
import { useId, useRef, useState } from 'react'
import { Search, Upload } from 'lucide-react'
import { ASSISTANT_BRANDS, ASSISTANT_ICON_EMOJIS, ASSISTANT_LUCIDE_ICON_NAMES } from '@shared/assistant-icons'
import { Button } from '../../components/primitives'
import { Input, Segmented } from '../../components/form'
import { Modal } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { AssistantIcon } from './AssistantIcon'
import { iconFromFile } from './assistant-icon-upload'

type IconTab = 'brand' | 'emoji' | 'lucide' | 'upload'

function initialTab(value: string): IconTab {
  if (value.startsWith('emoji:')) return 'emoji'
  if (value.startsWith('lucide:')) return 'lucide'
  if (value.startsWith('data:image/')) return 'upload'
  return 'brand'
}

export function AssistantIconPicker({
  value,
  fallback,
  onChange,
}: {
  value: string
  /** The inferred mark shown while `value` is empty, so the preview is the mark the row actually wears. */
  fallback?: string
  onChange: (next: string) => void
}) {  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <AssistantIcon value={value} fallback={fallback} size={32} />
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{t('assistant.icon.choose')}</Button>
      {value && (
        <Button size="sm" variant="ghost" onClick={() => onChange('')}>{t('assistant.icon.default')}</Button>
      )}
      {open && (
        <IconPickerModal
          value={value}
          fallback={fallback}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

/** The labelled block both editors use; a group rather than a `<label>`, because its control is a button. */
export function AssistantIconField({
  value,
  fallback,
  onChange,
}: {
  value: string
  fallback?: string
  onChange: (next: string) => void
}) {
  const titleId = useId()
  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-1">
      <span id={titleId} className="block text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
        {t('assistant.icon.label')}
      </span>
      <AssistantIconPicker value={value} fallback={fallback} onChange={onChange} />
      <span className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
        {t('assistant.icon.field_hint')}
      </span>
    </div>
  )
}

function IconPickerModal({
  value,
  fallback,
  onChange,
  onClose,
}: {
  value: string
  fallback?: string
  onChange: (next: string) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<IconTab>(() => initialTab(value))
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const brands = ASSISTANT_BRANDS.filter((brand) =>
    !query.trim() || `${brand.label} ${brand.key} ${brand.aliases.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  const choose = (next: string) => {
    onChange(next)
    onClose()
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      choose(await iconFromFile(file))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('assistant.icon.upload_failed'))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Modal open onClose={onClose} title={t('assistant.icon.title')} description={t('assistant.icon.hint')} width={560}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-2">
          <AssistantIcon value={value} fallback={fallback} size={32} />
          <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.icon.current')}</span>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          label={t('assistant.icon.title')}
          options={[
            { value: 'brand', label: t('assistant.icon.brand') },
            { value: 'emoji', label: t('assistant.icon.emoji') },
            { value: 'lucide', label: t('assistant.icon.lucide') },
            { value: 'upload', label: t('assistant.icon.upload') },
          ]}
        />

        {tab === 'brand' && (
          <div className="flex flex-col gap-2">
            <Input
              leading={<Search size={13} />}
              value={query}
              aria-label={t('assistant.icon.search')}
              placeholder={t('assistant.icon.search')}
              className="h-8 text-[length:var(--text-12)]"
              onChange={(event) => setQuery(event.target.value)}
            />
            {brands.length === 0 ? (
              <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.icon.none')}</p>
            ) : (
              <div className="grid max-h-[44vh] grid-cols-4 gap-1 overflow-y-auto md:grid-cols-6">
                {brands.map((brand) => (
                  <button
                    key={brand.key}
                    type="button"
                    aria-pressed={value === `brand:${brand.key}`}
                    onClick={() => choose(`brand:${brand.key}`)}
                    className={cn(
                      'flex min-w-0 flex-col items-center gap-1 rounded-[var(--r-md)] border px-1 py-2 text-center transition-colors duration-[var(--dur-fast)]',
                      value === `brand:${brand.key}`
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <AssistantIcon value={`brand:${brand.key}`} size={28} />
                    <span className="w-full truncate text-[length:var(--text-10)] text-[var(--text-tertiary)]">{brand.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'emoji' && (
          <div className="grid max-h-[44vh] grid-cols-8 gap-1 overflow-y-auto">
            {ASSISTANT_ICON_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                aria-pressed={value === `emoji:${emoji}`}
                onClick={() => choose(`emoji:${emoji}`)}
                className={cn(
                  'flex size-9 items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-18)] transition-colors duration-[var(--dur-fast)]',
                  value === `emoji:${emoji}` ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {tab === 'lucide' && (
          <div className="grid max-h-[44vh] grid-cols-4 gap-1 overflow-y-auto md:grid-cols-5">
            {ASSISTANT_LUCIDE_ICON_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={value === `lucide:${name}`}
                onClick={() => choose(`lucide:${name}`)}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] border px-1.5 py-1.5 text-left transition-colors duration-[var(--dur-fast)]',
                  value === `lucide:${name}`
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-transparent hover:bg-[var(--bg-hover)]',
                )}
              >
                <AssistantIcon value={`lucide:${name}`} size={22} />
                <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{name}</span>
              </button>
            ))}
          </div>
        )}

        {tab === 'upload' && (
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label={t('assistant.icon.upload_choose')}
              onChange={(event) => void upload(event.target.files?.[0])}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" icon={<Upload size={13} />} loading={busy} onClick={() => fileRef.current?.click()}>
                {t('assistant.icon.upload_choose')}
              </Button>
              <span className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('assistant.icon.upload_hint')}</span>
            </div>
            {error && <p role="alert" className="text-[length:var(--text-11)] text-[var(--danger)]">{error}</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}
