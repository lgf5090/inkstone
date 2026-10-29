import { useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Loader2, Pin, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import type { NavLink } from '@shared/nav/model'
import { COMMON_FAVICON_PATHS } from '@shared/nav/favicon-paths'
import { extractDomain, initialFor, normalizeLinkUrl } from '@shared/nav/model'
import { Modal, confirm } from '../../components/overlay'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { navApi, categoryOptions } from './api'
import { useNavStore } from './nav-store'

interface Props {
  open: boolean
  link: NavLink | null
  initial?: { title: string; url: string } | null
  defaultCategoryId?: string
  onClose: () => void
}

const DEBOUNCE_MS = 500

function imageExists(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image()
    const timer = window.setTimeout(() => {
      image.onload = null
      image.onerror = null
      image.src = ''
      resolve(false)
    }, 3000)
    image.onload = () => {
      window.clearTimeout(timer)
      resolve(image.naturalWidth > 0)
    }
    image.onerror = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
    image.src = url
  })
}

export function NavLinkEditor({ open, link, initial, defaultCategoryId, onClose }: Props) {
  const categories = useNavStore((state) => state.categories)
  const links = useNavStore((state) => state.links)
  const settings = useNavStore((state) => state.settings)
  const createCategory = useNavStore((state) => state.createCategory)
  const createLink = useNavStore((state) => state.createLink)
  const updateLink = useNavStore((state) => state.updateLink)
  const deleteLink = useNavStore((state) => state.deleteLink)
  const toast = useUi((state) => state.toast)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [icon, setIcon] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [pinned, setPinned] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [autoFetch, setAutoFetch] = useState(settings.display.autoFetchIcon)
  const [saving, setSaving] = useState(false)
  const [iconBusy, setIconBusy] = useState<'fetch' | 'detect' | 'upload' | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiAvailable, setAiAvailable] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const fetchSeq = useRef(0)
  const options = useMemo(() => categoryOptions(categories), [categories])

  useEffect(() => {
    if (!open) return
    const first = categories.find((category) => !category.parentId)?.id ?? ''
    const preferred = defaultCategoryId && categories.some((category) => category.id === defaultCategoryId) ? defaultCategoryId : first
    setTitle(link?.title ?? initial?.title ?? '')
    setUrl(link?.url ?? initial?.url ?? '')
    setIcon(link?.icon ?? '')
    setDescription(link?.description ?? '')
    setCategoryId(link?.categoryId ?? preferred)
    setPinned(link?.pinned ?? false)
    setBatchMode(false)
    setAutoFetch(settings.display.autoFetchIcon)
    setSaving(false)
    setIconBusy(null)
    setAiBusy(false)
    void navApi.aiModels().then((result) => setAiAvailable(result.available)).catch(() => setAiAvailable(false))
  }, [open, link, initial, categories, defaultCategoryId, settings.display.autoFetchIcon])

  useEffect(() => {
    if (!open || link || !autoFetch || icon.trim()) return
    if (!/^https?:\/\//i.test(url)) return
    const sequence = ++fetchSeq.current
    const timer = window.setTimeout(() => {
      void (async () => {
        const domain = extractDomain(url)
        if (!domain) return
        try {
          const cached = await navApi.favicon(domain)
          if (sequence !== fetchSeq.current) return
          if (cached.icon) {
            setIcon(cached.icon)
            return
          }
          const origin = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin
          const captured = await navApi.captureIcon(`${origin}/favicon.ico`)
          if (sequence !== fetchSeq.current) return
          setIcon(captured.icon.url)
          await navApi.cacheFavicon(domain, captured.icon.url)
        } catch {
          // Automatic fetching is best-effort; the field stays empty and the reader can retry manually.
        }
      })()
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, link, autoFetch, icon, url])

  function validate(): string | null {
    if (!title.trim() || !url.trim()) return t('nav.link.required')
    if (!normalizeLinkUrl(url)) return t('nav.link.invalid_url')
    return null
  }

  async function ensureCategory(): Promise<string> {
    if (categoryId && categories.some((category) => category.id === categoryId)) return categoryId
    const created = await createCategory({ name: t('nav.link.default_category'), icon: 'bookmark', parentId: null, passwordMode: 'none' })
    return created.id
  }

  async function save() {
    const invalid = validate()
    if (invalid) {
      toast({ title: invalid, tone: 'danger' })
      return
    }
    setSaving(true)
    try {
      const normalized = normalizeLinkUrl(url)!
      if (!link) {
        const duplicate = links.find((item) => item.url === normalized)
        if (duplicate) {
          const keep = await confirm({
            title: t('nav.link.duplicate'),
            description: `${duplicate.title} · ${duplicate.url} — ${t('nav.link.duplicate_hint')}`,
            confirmLabel: t('nav.add'),
          })
          if (!keep) {
            setSaving(false)
            return
          }
        }
      }
      const targetCategory = await ensureCategory()
      const body = {
        title: title.trim(),
        url: normalized,
        icon: icon.trim() || null,
        description: description.trim() || null,
        categoryId: targetCategory,
        pinned,
      }
      if (link) await updateLink(link.id, body)
      else await createLink(body)
      const domain = extractDomain(normalized)
      if (domain && icon.startsWith('http')) await navApi.cacheFavicon(domain, icon.trim()).catch(() => null)
      toast({ title: link ? t('nav.link.saved') : t('nav.link.added'), tone: 'success' })
      if (batchMode && !link) {
        setTitle('')
        setUrl('')
        setIcon('')
        setDescription('')
        setPinned(false)
      } else {
        onClose()
      }
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('nav.error.generic'), tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!link) return
    if (!(await confirm({ title: t('nav.link.delete_confirm'), tone: 'danger', confirmLabel: t('nav.delete') }))) return
    try {
      await deleteLink(link.id)
      onClose()
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('nav.error.generic'), tone: 'danger' })
    }
  }

  async function fetchIcon(manual: boolean) {
    if (!url.trim()) {
      if (manual) toast({ title: t('nav.link.required'), tone: 'danger' })
      return
    }
    setIconBusy('fetch')
    try {
      const origin = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin
      const captured = await navApi.captureIcon(`${origin}/favicon.ico`)
      setIcon(captured.icon.url)
      const domain = extractDomain(url)
      if (domain) await navApi.cacheFavicon(domain, captured.icon.url).catch(() => null)
      if (manual) toast({ title: t('nav.link.icon_detected'), tone: 'success' })
    } catch (error) {
      if (manual) toast({ title: error instanceof Error ? error.message : t('nav.link.icon_not_found'), tone: 'danger' })
    } finally {
      setIconBusy(null)
    }
  }

  async function detectLogo() {
    if (!url.trim()) return
    setIconBusy('detect')
    try {
      const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
      const origin = parsed.origin
      const candidates = COMMON_FAVICON_PATHS.filter((path) => !path.endsWith('.svg'))
      let found: string | null = null
      for (let index = 0; index < candidates.length && !found; index += 8) {
        const batch = candidates.slice(index, index + 8).map((path) => `${origin}${path}`)
        const hits = await Promise.all(batch.map(async (candidate) => (await imageExists(candidate) ? candidate : null)))
        found = hits.find((candidate): candidate is string => Boolean(candidate)) ?? null
      }
      if (!found) {
        toast({ title: t('nav.link.icon_not_found'), tone: 'warning' })
        return
      }
      const captured = await navApi.captureIcon(found)
      setIcon(captured.icon.url)
      const domain = extractDomain(url)
      if (domain) await navApi.cacheFavicon(domain, captured.icon.url).catch(() => null)
      toast({ title: t('nav.link.icon_detected'), tone: 'success' })
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('nav.error.generic'), tone: 'danger' })
    } finally {
      setIconBusy(null)
    }
  }

  async function upload(file: File | null) {
    if (!file) return
    setIconBusy('upload')
    try {
      const result = await navApi.uploadIcon(file)
      setIcon(result.icon.url)
      toast({ title: t('nav.link.icon_uploaded'), tone: 'success' })
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('nav.error.icon_invalid'), tone: 'danger' })
    } finally {
      setIconBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function aiFill() {
    if (!title.trim() || !url.trim()) return
    setAiBusy(true)
    try {
      const result = await navApi.aiSuggest({
        title: title.trim(),
        url: url.trim(),
        categories: categories.map((category) => ({ id: category.id, name: category.name })),
      })
      if (result.description) setDescription(result.description)
      if (result.categoryId) setCategoryId(result.categoryId)
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : t('nav.error.ai_unavailable'), tone: 'danger' })
    } finally {
      setAiBusy(false)
    }
  }

  const iconPreview = icon.trim()
  return (
    <Modal open={open} onClose={onClose} title={link ? t('nav.link.edit_title') : t('nav.link.add_title')} width={560}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant={pinned ? 'primary' : 'secondary'} icon={<Pin size={13} />} onClick={() => setPinned(!pinned)}>
            {t('nav.pin')}
          </Button>
          {!link && (
            <Checkbox checked={batchMode} onChange={(checked) => setBatchMode(checked)} label={t('nav.link.batch_keep_open')} />
          )}
          {link && (
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void remove()}>
              {t('nav.delete')}
            </Button>
          )}
        </div>
        <Field label={t('nav.link.title')}>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus placeholder="Example" />
        </Field>
        <Field label={t('nav.link.url')}>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" />
        </Field>
        <Field label={t('nav.link.icon')}>
          <div className="flex items-center gap-2">
            <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              {iconPreview ? (
                <img src={iconPreview} alt="" className="size-full object-contain" referrerPolicy="no-referrer" onError={() => setIcon('')} />
              ) : (
                <span className={cn('flex size-full items-center justify-center text-[length:var(--text-11)] font-semibold', iconPreview ? '' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)]')}>{initialFor(title, url)}</span>
              )}
            </div>
            <Input value={icon} onChange={(event) => setIcon(event.target.value)} placeholder="https://example.com/icon.png" className="min-w-0 flex-1" />
            <IconButton label={t('nav.link.icon_fetch')} onClick={() => void fetchIcon(true)} disabled={!url.trim() || iconBusy !== null}>
              {iconBusy === 'fetch' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            </IconButton>
            <IconButton label={t('nav.link.icon_detect')} onClick={() => void detectLogo()} disabled={!url.trim() || iconBusy !== null}>
              {iconBusy === 'detect' ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            </IconButton>
            <IconButton label={t('nav.link.icon_upload')} onClick={() => fileRef.current?.click()} disabled={iconBusy !== null}>
              {iconBusy === 'upload' ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            </IconButton>
            {icon && <IconButton label={t('nav.link.icon_clear')} onClick={() => setIcon('')}><X size={14} /></IconButton>}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/x-icon" className="hidden" onChange={(event) => void upload(event.target.files?.[0] ?? null)} />
          </div>
          <Checkbox checked={autoFetch} onChange={setAutoFetch} label={t('nav.link.auto_icon')} />
        </Field>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('nav.link.description')}</span>
            {title.trim() && url.trim() && aiAvailable && (
              <Button size="sm" variant="ghost" icon={aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} onClick={() => void aiFill()} disabled={aiBusy}>
                {aiBusy ? t('nav.link.ai_filling') : t('nav.link.ai_fill')}
              </Button>
            )}
          </div>
          <Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder={t('nav.no_description')} />
        </div>
        <Field label={t('nav.link.category')}>
          <Select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t('nav.cancel')}</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!title.trim() || !url.trim()}>{t('nav.save')}</Button>
        </div>
      </div>
    </Modal>
  )
}
