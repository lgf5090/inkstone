import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogAlbumPhoto, BlogCollectionItem, BlogCollectionKind, BlogMediaItem } from '@shared/blog/model'
import { BLOG_COLLECTION_DEFS } from '@shared/blog/collections'
import { Button } from '../../components/primitives'
import { Checkbox, Field, Input, Textarea } from '../../components/form'
import { DatePicker } from '../../components/date-picker'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { MediaPicker } from './MediaPicker'

const KIND_LABEL: Record<BlogCollectionKind, MessageKey> = {
  moments: 'blog.admin.moments',
  albums: 'blog.admin.albums',
  friends: 'blog.admin.friends',
  projects: 'blog.admin.projects',
  skills: 'blog.admin.skills',
  devices: 'blog.admin.devices',
  games: 'blog.admin.games',
  anime: 'blog.admin.anime',
  timeline: 'blog.admin.timeline',
  compass: 'blog.admin.compass',
}

const FIELD_LABEL: Record<string, MessageKey> = {
  content: 'blog.admin.field_content',
  pinned: 'blog.admin.pinned',
  location: 'blog.admin.field_location',
  mood: 'blog.admin.field_mood',
  images: 'blog.admin.field_images',
  tags: 'blog.admin.tags',
  published_at: 'blog.admin.field_published_at',
  draft: 'blog.admin.field_draft',
  title: 'blog.admin.field_title',
  slug: 'blog.admin.slug',
  description: 'blog.admin.field_description',
  cover_asset_id: 'blog.admin.featured_image',
  date: 'blog.admin.field_date',
  layout: 'blog.admin.field_layout',
  columns: 'blog.admin.field_columns',
  password: 'blog.admin.password',
  password_hint: 'blog.admin.field_password_hint',
  position: 'blog.admin.field_position',
  name: 'blog.admin.field_name',
  url: 'blog.admin.field_url',
  avatar_asset_id: 'blog.admin.field_avatar',
  enabled: 'blog.admin.field_enabled',
  key: 'blog.admin.field_key',
  summary: 'blog.admin.field_summary',
  category: 'blog.admin.category',
  phase: 'blog.admin.field_phase',
  technologies: 'blog.admin.field_technologies',
  icon: 'blog.admin.field_icon',
  featured: 'blog.admin.field_featured',
  repository: 'blog.admin.field_repository',
  year: 'blog.admin.field_year',
  level: 'blog.admin.field_level',
  brand: 'blog.admin.field_brand',
  status: 'blog.admin.field_status',
  specs: 'blog.admin.field_specs',
  link: 'blog.admin.field_link',
  developer: 'blog.admin.field_developer',
  rating: 'blog.admin.field_rating',
  hours: 'blog.admin.field_hours',
  platform: 'blog.admin.field_platform',
  watched: 'blog.admin.field_watched',
  total: 'blog.admin.field_total',
  studio: 'blog.admin.field_studio',
  genres: 'blog.admin.field_genres',
  period_start: 'blog.admin.field_period_start',
  period_end: 'blog.admin.field_period_end',
  identity: 'blog.admin.field_identity',
  subtitle: 'blog.admin.field_subtitle',
  highlights: 'blog.admin.field_highlights',
  links: 'blog.admin.field_links',
  blurb: 'blog.admin.field_blurb',
}

function toLocalInput(value: unknown): string {
  const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const date = new Date(timestamp)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function fromLocalInput(value: string): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function parseStructured(value: string, fallback: unknown): unknown {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      throw new Error('invalid_json')
    }
  }
  return trimmed.split(',').map((part) => part.trim()).filter(Boolean)
}

function initialValues(item: BlogCollectionItem | null, kind: BlogCollectionKind): Record<string, unknown> {
  const def = BLOG_COLLECTION_DEFS[kind]
  const values: Record<string, unknown> = {}
  for (const field of def.fields) {
    const source = item?.data[field.key]
    if (field.key === 'published_at') values[field.key] = toLocalInput(source)
    else if (field.type === 'json') values[field.key] = Array.isArray(source) || (source && typeof source === 'object') ? JSON.stringify(source, null, 2) : ''
    else if (field.type === 'boolean') values[field.key] = source === true || source === 1
    else values[field.key] = source === undefined || source === null ? '' : String(source)
  }
  if (kind === 'albums') values.published_at = toLocalInput(item?.publishedAt)
  return values
}

export function CollectionForm({
  kind,
  item,
  busy,
  onClose,
  onSave,
}: {
  kind: BlogCollectionKind
  item: BlogCollectionItem | null
  busy: boolean
  onClose: () => void
  onSave: (input: Record<string, unknown>) => void
}) {
  const toast = useUi((state) => state.toast)
  const def = BLOG_COLLECTION_DEFS[kind]
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(item, kind))
  const [publish, setPublish] = useState(kind === 'albums' ? Boolean(item?.publishedAt) || !item : false)
  const [clearPassword, setClearPassword] = useState(false)
  const [pickerField, setPickerField] = useState<string | null>(null)

  useEffect(() => {
    setValues(initialValues(item, kind))
    setPublish(kind === 'albums' ? Boolean(item?.publishedAt) || !item : false)
    setClearPassword(false)
  }, [item, kind])

  const set = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }))

  const submit = () => {
    const input: Record<string, unknown> = {}
    try {
      for (const field of def.fields) {
        if (field.key === 'published_at') {
          if (kind === 'albums') {
            input.published_at = publish ? (fromLocalInput(String(values.published_at ?? '')) ?? Date.now()) : null
          } else {
            input.published_at = fromLocalInput(String(values.published_at ?? '')) ?? Date.now()
          }
        } else if (field.type === 'json') {
          input[field.key] = parseStructured(String(values[field.key] ?? ''), [])
        } else if (field.type === 'boolean') {
          input[field.key] = values[field.key] === true
        } else if (field.type === 'number') {
          const raw = values[field.key]
          input[field.key] = raw === '' || raw === undefined ? null : Number(raw)
        } else {
          input[field.key] = values[field.key] ?? ''
        }
      }
      if (kind === 'albums') {
        input.published_at = publish ? Date.now() : null
        if (clearPassword) input.clearPassword = true
        else if (typeof values.password === 'string' && values.password.trim()) input.password = values.password
      }
      onSave(input)
    } catch (error) {
      toast({ title: t('blog.admin.invalid_field'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? t('blog.admin.collection_edit', { kind: t(KIND_LABEL[kind]) }) : t('blog.admin.collection_add', { kind: t(KIND_LABEL[kind]) })}
      width={680}
      footer={(
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>{t('blog.admin.cancel')}</Button>
          <Button size="sm" loading={busy} onClick={submit}>{t('blog.admin.save')}</Button>
        </div>
      )}
    >
      <div className="grid max-h-[65vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
        {def.fields.map((field) => {
          if (field.key === 'published_at' && kind !== 'albums') {
            return (
              <Field key={field.key} label={t(FIELD_LABEL[field.key] ?? 'blog.admin.field_other')}>
                <DatePicker label={t(FIELD_LABEL[field.key] ?? 'blog.admin.field_other')} value={String(values[field.key] ?? '')} withTime onChange={(value) => set(field.key, value)} />
              </Field>
            )
          }
          if (field.key === 'published_at') return null
          if (field.key === 'cover_asset_id' || field.key === 'avatar_asset_id') {
            return (
              <Field key={field.key} label={t(FIELD_LABEL[field.key] ?? 'blog.admin.field_other')}>
                <div className="flex gap-1.5">
                  <Input value={String(values[field.key] ?? '')} onChange={(event) => set(field.key, event.target.value)} placeholder={t('blog.admin.media_asset_id')} />
                  <Button size="sm" variant="ghost" onClick={() => setPickerField(field.key)}>{t('blog.admin.select_media')}</Button>
                </div>
              </Field>
            )
          }
          if (field.type === 'boolean') {
            return (
              <div key={field.key} className="flex items-center sm:col-span-2">
                <Checkbox checked={values[field.key] === true} onChange={(next) => set(field.key, next)} label={t(FIELD_LABEL[field.key] ?? 'blog.admin.field_other')} />
              </div>
            )
          }
          if (field.type === 'text' || field.type === 'json') {
            return (
              <Field key={field.key} label={t(FIELD_LABEL[field.key] ?? 'blog.admin.field_other')} className={field.type === 'json' || field.key === 'content' ? 'sm:col-span-2' : undefined}>
                <Textarea
                  rows={field.type === 'json' ? 3 : 4}
                  value={String(values[field.key] ?? '')}
                  onChange={(event) => set(field.key, event.target.value)}
                  className={field.type === 'json' ? 'font-mono text-[length:var(--text-11)]' : undefined}
                />
              </Field>
            )
          }
          if (field.key === 'password') {
            return (
              <Field key={field.key} label={t('blog.admin.password')} hint={item?.data.hasPassword ? t('blog.admin.password_set') : undefined}>
                <Input type="password" value={String(values[field.key] ?? '')} onChange={(event) => set(field.key, event.target.value)} autoComplete="new-password" />
                {item?.data.hasPassword === true && <Checkbox checked={clearPassword} onChange={setClearPassword} label={t('blog.admin.clear_password')} />}
              </Field>
            )
          }
          return (
            <Field key={field.key} label={t(FIELD_LABEL[field.key] ?? 'blog.admin.field_other')}>
              <Input
                type={field.type === 'number' ? 'number' : 'text'}
                value={String(values[field.key] ?? '')}
                onChange={(event) => set(field.key, event.target.value)}
                required={field.required && !item}
              />
            </Field>
          )
        })}
        {kind === 'albums' && (
          <div className="flex items-center sm:col-span-2">
            <Checkbox checked={publish} onChange={setPublish} label={t('blog.admin.publish_now')} />
          </div>
        )}
      </div>
      <MediaPicker
        open={Boolean(pickerField)}
        onClose={() => setPickerField(null)}
        onSelect={(media: BlogMediaItem) => {
          if (pickerField) set(pickerField, media.id)
        }}
      />
    </Modal>
  )
}

export function AlbumPhotosDrawer({
  album,
  open,
  onClose,
}: {
  album: BlogCollectionItem
  open: boolean
  onClose: () => void
}) {
  const toast = useUi((state) => state.toast)
  const [photos, setPhotos] = useState<BlogAlbumPhoto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [captions, setCaptions] = useState<Record<string, { caption: string; alt: string }>>({})

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.blog.collections.photos(album.id)
      setPhotos(result.items)
      setCaptions(Object.fromEntries(result.items.map((photo) => [photo.id, { caption: photo.caption, alt: photo.alt }])))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open, album.id])

  const add = async (media: BlogMediaItem) => {
    try {
      await api.blog.collections.addPhoto(album.id, { assetId: media.id })
      await load()
    } catch (cause) {
      toast({ title: t('blog.admin.save_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  const savePhoto = async (photo: BlogAlbumPhoto) => {
    const values = captions[photo.id]
    if (!values) return
    try {
      await api.blog.collections.updatePhoto(album.id, photo.id, values)
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (cause) {
      toast({ title: t('blog.admin.save_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  const remove = async (photo: BlogAlbumPhoto) => {
    try {
      await api.blog.collections.removePhoto(album.id, photo.id)
      await load()
    } catch (cause) {
      toast({ title: t('blog.admin.delete_failed'), description: cause instanceof Error ? cause.message : String(cause), tone: 'danger' })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('blog.admin.album_photos', { title: album.title })} width={860} footer={<Button size="sm" onClick={() => setPicking(true)}>{t('blog.admin.add_photo')}</Button>}>
      {error ? <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{error}</p> : loading ? <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.loading')}</p> : photos.length === 0 ? (
        <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('blog.admin.album_empty')}</p>
      ) : (
        <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
          {photos.map((photo) => (
            <li key={photo.id} className="flex gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
              <img src={photo.url} alt={photo.alt} className="size-20 shrink-0 rounded-[var(--r-sm)] object-cover" />
              <div className="min-w-0 flex-1 space-y-1">
                <Input
                  value={captions[photo.id]?.caption ?? ''}
                  onChange={(event) => setCaptions((current) => ({ ...current, [photo.id]: { ...current[photo.id], caption: event.target.value } }))}
                  placeholder={t('blog.admin.photo_caption')}
                  aria-label={t('blog.admin.photo_caption')}
                />
                <Input
                  value={captions[photo.id]?.alt ?? ''}
                  onChange={(event) => setCaptions((current) => ({ ...current, [photo.id]: { ...current[photo.id], alt: event.target.value } }))}
                  placeholder={t('blog.admin.photo_alt')}
                  aria-label={t('blog.admin.photo_alt')}
                />
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <Button size="sm" variant="ghost" onClick={() => void savePhoto(photo)}>{t('blog.admin.save')}</Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(photo)}>{t('blog.admin.media_delete')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <MediaPicker open={picking} onClose={() => setPicking(false)} onSelect={(media) => { setPicking(false); void add(media) }} />
    </Modal>
  )
}

