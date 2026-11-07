/**
 * Chooses the icon source for one host: provider monogram, a curated Lucide glyph, an emoji or an
 * uploaded image. Uploaded files are decoded, scaled to at most 256 px and re-encoded as WebP before
 * they leave the browser, so the row never downloads the original camera-sized picture.
 */
import { useMemo, useRef, useState } from 'react'
import { ImagePlus, Search, Trash2 } from 'lucide-react'
import type { WebsshHost, WebsshHostIconKind, WebsshProvider } from '@shared/webssh/types'
import { WEBSSH_BUILTIN_PROVIDERS } from '@shared/webssh/providers'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { Button, IconButton } from '../../components/primitives'
import { Input, Segmented } from '../../components/form'
import { Modal } from '../../components/overlay'
import { ApiError } from '../../lib/api'
import { useUi } from '../../store/ui'
import { websshApi } from './api'
import { HostIcon, WEBSSH_EMOJI_ICONS, WEBSSH_LUCIDE_ICONS, providerText } from './HostIcon'

type IconSource = 'provider' | 'lucide' | 'emoji' | 'image'

export async function compressHostIcon(file: File): Promise<Blob> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error(t('webssh.icon.bad_type'))
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error(t('webssh.icon.encode_failed'))
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
  if (!blob) throw new Error(t('webssh.icon.encode_failed'))
  return blob
}

export function HostIconPicker({
  open,
  host,
  providers,
  onClose,
  onPick,
  onUploaded,
}: {
  open: boolean
  host: WebsshHost | null
  providers: readonly WebsshProvider[]
  onClose: () => void
  onPick: (kind: WebsshHostIconKind, value: string) => void
  onUploaded: (host: WebsshHost) => void
}) {
  const toast = useUi((state) => state.toast)
  const fileRef = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState<IconSource>('provider')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initials = host?.name.slice(0, 1).toUpperCase() || '?'
  const customProviders = providers.filter((provider) => provider.id.startsWith('custom:'))
  const needle = query.trim().toLowerCase()

  const lucideChoices = useMemo(() => WEBSSH_LUCIDE_ICONS.filter((entry) => !needle || entry.name.includes(needle)), [needle])
  const emojiChoices = useMemo(() => WEBSSH_EMOJI_ICONS.filter((emoji) => !needle || emoji.includes(needle)), [needle])

  const preview = host ?? { name: '', provider: 'other', iconKind: '' as WebsshHostIconKind, iconValue: '', iconUrl: '' }

  const choose = (kind: WebsshHostIconKind, value: string) => {
    onPick(kind, value)
    onClose()
  }

  const upload = async (file: File | undefined) => {
    if (!file || !host) return
    setBusy(true)
    setError(null)
    try {
      const blob = await compressHostIcon(file)
      const updated = await websshApi.uploadIcon(host.id, blob)
      onUploaded(updated)
      toast({ title: t('webssh.icon.uploaded'), tone: 'success' })
      onClose()
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : t('webssh.error.generic')
      setError(message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('webssh.icon.title')}
      description={t('webssh.icon.description')}
      width={560}
      footer={(
        <>
          {host?.iconKind === 'image' && (
            <Button
              variant="ghost"
              icon={<Trash2 size={13} aria-hidden="true" />}
              disabled={busy}
              onClick={() => {
                setBusy(true)
                websshApi.deleteIcon(host.id)
                  .then((updated) => { onUploaded(updated); onClose() })
                  .catch((caught: unknown) => setError(caught instanceof ApiError ? caught.message : t('webssh.error.generic')))
                  .finally(() => setBusy(false))
              }}
            >
              {t('webssh.icon.remove')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t('webssh.actions.close')}</Button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <HostIcon host={preview} providers={providers} size={40} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{host?.name ?? t('webssh.icon.preview')}</p>
            <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('webssh.icon.preview_hint')}</p>
          </div>
          {!host?.iconKind && (
            <span className="rounded-[var(--r-xs)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {initials}
            </span>
          )}
        </div>

        <Segmented
          value={source}
          onChange={(value) => { setSource(value); setQuery(''); setError(null) }}
          options={[
            { value: 'provider', label: t('webssh.icon.source_provider') },
            { value: 'lucide', label: t('webssh.icon.source_lucide') },
            { value: 'emoji', label: t('webssh.icon.source_emoji') },
            { value: 'image', label: t('webssh.icon.source_image') },
          ]}
          label={t('webssh.icon.source')}
        />

        {(source === 'lucide' || source === 'emoji') && (
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            leading={<Search size={13} aria-hidden="true" />}
            aria-label={t('webssh.icon.search')}
            placeholder={t('webssh.icon.search')}
          />
        )}

        {source === 'provider' && (
          <div role="group" aria-label={t('webssh.icon.source_provider')} className="grid max-h-64 grid-cols-2 gap-1.5 overflow-y-auto p-0.5">
            {[...WEBSSH_BUILTIN_PROVIDERS, ...customProviders].map((provider) => {
              const label = providerText(provider.id, providers)
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => choose('', '')}
                  className={cn(
                    'flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]',
                    host?.provider === provider.id && !host.iconKind && 'border-[var(--accent)] bg-[var(--accent-soft)]',
                  )}
                >
                  <span aria-hidden="true" className="size-5 shrink-0 rounded-[var(--r-xs)]" style={{ backgroundColor: provider.color || '#475569' }} />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{label}</span>
                </button>
              )
            })}
          </div>
        )}

        {source === 'lucide' && (
          <div role="group" aria-label={t('webssh.icon.source_lucide')} className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto p-0.5">
            {lucideChoices.map((entry) => {
              const Glyph = entry.icon
              return (
                <button
                  key={entry.name}
                  type="button"
                  aria-label={entry.name}
                  aria-pressed={host?.iconKind === 'lucide' && host.iconValue === entry.name}
                  onClick={() => choose('lucide', entry.name)}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                    host?.iconKind === 'lucide' && host.iconValue === entry.name && 'border-[var(--accent)] bg-[var(--accent-soft)]',
                  )}
                >
                  <Glyph size={17} />
                </button>
              )
            })}
          </div>
        )}

        {source === 'emoji' && (
          <div role="group" aria-label={t('webssh.icon.source_emoji')} className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto p-0.5">
            {emojiChoices.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                aria-pressed={host?.iconKind === 'emoji' && host.iconValue === emoji}
                onClick={() => choose('emoji', emoji)}
                className="flex aspect-square items-center justify-center rounded-[var(--r-md)] border border-[var(--border-subtle)] text-[length:var(--text-16)] hover:bg-[var(--bg-hover)]"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        {source === 'image' && (
          <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-4 text-center">
            {!host ? (
              <p className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('webssh.icon.save_first')}</p>
            ) : (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(event) => void upload(event.target.files?.[0])}
                />
                <IconButton label={t('webssh.icon.upload')} onClick={() => fileRef.current?.click()} disabled={busy}>
                  <ImagePlus size={20} aria-hidden="true" />
                </IconButton>
                <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">{busy ? t('webssh.icon.compressing') : t('webssh.icon.upload_hint')}</p>
              </>
            )}
            {error && <p className="mt-2 text-[length:var(--text-11-5)] text-[var(--danger)]">{error}</p>}
          </div>
        )}
      </div>
    </Modal>
  )
}
