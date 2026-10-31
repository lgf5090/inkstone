import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import type { BlogSettings } from '@shared/blog/settings'
import type { MessageKey } from '@shared/locales/en-US'
import type { BlogWidget } from '@shared/blog/model'
import { Button, IconButton } from '../../components/primitives'
import { Checkbox, Field, Input, Select, Textarea } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { AdminCard, AdminLoading, AdminError, PageHeader, useAdminResource } from './shared'

const WIDGET_TYPES = ['profile', 'search', 'categories', 'tags', 'series', 'recent', 'stats', 'calendar', 'announcement', 'custom'] as const
type WidgetType = (typeof WIDGET_TYPES)[number]

const TYPE_LABEL: Record<WidgetType, MessageKey> = {
  profile: 'blog.admin.widget_profile',
  search: 'blog.admin.widget_search',
  categories: 'blog.admin.widget_categories',
  tags: 'blog.admin.widget_tags',
  series: 'blog.admin.widget_series',
  recent: 'blog.admin.widget_recent',
  stats: 'blog.admin.widget_stats',
  calendar: 'blog.admin.widget_calendar',
  announcement: 'blog.admin.widget_announcement',
  custom: 'blog.admin.widget_custom',
}

function widgetItems(settings: BlogSettings | null): BlogWidget[] {
  const widgets = settings?.widgets as { items?: unknown } | undefined
  if (!Array.isArray(widgets?.items)) return []
  return widgets.items.filter((item): item is BlogWidget => Boolean(item) && typeof item === 'object' && typeof (item as BlogWidget).id === 'string')
}

function sidebarSettings(settings: BlogSettings | null): { enable: boolean; arrangement: 'single' | 'dual'; side: 'left' | 'right' } {
  const sidebar = settings?.sidebar as { enable?: boolean; arrangement?: string; side?: string } | undefined
  return {
    enable: sidebar?.enable !== false,
    arrangement: sidebar?.arrangement === 'dual' ? 'dual' : 'single',
    side: sidebar?.side === 'right' ? 'right' : 'left',
  }
}

export function WidgetsPanel() {
  const toast = useUi((state) => state.toast)
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const [items, setItems] = useState<BlogWidget[]>([])
  const [sidebar, setSidebar] = useState(() => sidebarSettings(null))
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [type, setType] = useState<WidgetType>('profile')
  const [title, setTitle] = useState('')
  const [html, setHtml] = useState('')
  const [slot, setSlot] = useState<'default' | 'top' | 'sticky'>('default')
  const [pagesText, setPagesText] = useState('')
  const [collapseAfter, setCollapseAfter] = useState('')
  const [announcementText, setAnnouncementText] = useState('')

  useEffect(() => {
    setItems(widgetItems(settings.data))
    setSidebar(sidebarSettings(settings.data))
  }, [settings.data])

  const saveItems = async (next: BlogWidget[]) => {
    setBusy(true)
    try {
      await api.blog.settings.patch('widgets', { items: next })
      setItems(next)
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const saveSidebar = async (next: typeof sidebar) => {
    setBusy(true)
    try {
      await api.blog.settings.patch('sidebar', next)
      setSidebar(next)
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const openAdd = () => {
    setEditingId(null)
    setType('profile')
    setTitle('')
    setHtml('')
    setSlot('default')
    setPagesText('')
    setCollapseAfter('')
    setAnnouncementText('')
    setAdding(true)
  }

  const openEdit = (widget: BlogWidget) => {
    setEditingId(widget.id)
    setType(widget.type as WidgetType)
    setTitle(widget.title)
    setHtml(String((widget.config as { html?: unknown }).html ?? ''))
    setAnnouncementText(String((widget.config as { text?: unknown }).text ?? ''))
    setSlot(widget.slot === 'top' || widget.slot === 'sticky' ? widget.slot : 'default')
    setPagesText(Array.isArray(widget.pages) ? widget.pages.join(', ') : '')
    setCollapseAfter(typeof widget.collapseAfter === 'number' ? String(widget.collapseAfter) : '')
    setAdding(true)
  }

  const add = () => {
    const pages = pagesText.split(',').map((item) => item.trim()).filter(Boolean)
    const collapse = Number(collapseAfter)
    const extra = {
      ...(slot === 'default' ? {} : { slot }),
      ...(pages.length ? { pages } : {}),
      ...(Number.isFinite(collapse) && collapse > 0 ? { collapseAfter: Math.trunc(collapse) } : {}),
    }
    const next = editingId
      ? items.map((item) => item.id === editingId
        ? { ...item, type, title: title.trim(), config: type === 'custom' ? { html } : type === 'announcement' ? { text: announcementText } : item.config, ...extra }
        : item)
      : [...items, { id: `widget-${Date.now().toString(36)}`, type, title: title.trim(), enabled: true, config: type === 'custom' ? { html } : type === 'announcement' ? { text: announcementText } : {}, ...extra }]
    setAdding(false)
    setEditingId(null)
    setTitle('')
    setHtml('')
    setSlot('default')
    setPagesText('')
    setCollapseAfter('')
    setAnnouncementText('')
    void saveItems(next)
  }

  const remove = async (widget: BlogWidget) => {
    const ok = await confirm({
      title: t('blog.admin.widget_delete_title', { label: widget.title || t(TYPE_LABEL[widget.type as WidgetType] ?? 'blog.admin.widget_custom') }),
      description: t('blog.admin.widget_delete_desc'),
      confirmLabel: t('blog.admin.delete_forever'),
      tone: 'danger',
    })
    if (!ok) return
    void saveItems(items.filter((item) => item.id !== widget.id))
  }

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    void saveItems(next)
  }

  return (
    <div className="mx-auto max-w-[900px]">
      <PageHeader
        title={t('blog.admin.widgets')}
        description={t('blog.admin.widgets_subtitle')}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openAdd}>{t('blog.admin.widget_add')}</Button>}
      />

      {settings.error ? (
        <AdminError message={settings.error} onRetry={() => void settings.reload()} />
      ) : !settings.data ? (
        <AdminLoading />
      ) : (
        <div className="space-y-4">
          <AdminCard className="p-4">
            <h2 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{t('blog.admin.sidebar_settings')}</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Checkbox checked={sidebar.enable} onChange={(enable) => void saveSidebar({ ...sidebar, enable })} label={t('blog.admin.sidebar_enable')} />
              <Field label={t('blog.admin.sidebar_arrangement')}>
                <Select value={sidebar.arrangement} onChange={(event) => void saveSidebar({ ...sidebar, arrangement: event.target.value === 'dual' ? 'dual' : 'single' })}>
                  <option value="single">{t('blog.admin.sidebar_single')}</option>
                  <option value="dual">{t('blog.admin.sidebar_dual')}</option>
                </Select>
              </Field>
              <Field label={t('blog.admin.sidebar_side')}>
                <Select value={sidebar.side} onChange={(event) => void saveSidebar({ ...sidebar, side: event.target.value === 'right' ? 'right' : 'left' })}>
                  <option value="left">{t('blog.admin.sidebar_left')}</option>
                  <option value="right">{t('blog.admin.sidebar_right')}</option>
                </Select>
              </Field>
            </div>
          </AdminCard>

          <AdminCard className="overflow-hidden">
            {items.length === 0 ? (
              <p className="p-5 text-[length:var(--text-12-5)] text-[var(--text-tertiary)]">{t('blog.admin.widgets_empty')}</p>
            ) : (
              <ul className="divide-y divide-[var(--border-subtle)]">
                {items.map((widget, index) => (
                  <li key={widget.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <Checkbox
                      checked={widget.enabled}
                      onChange={(enabled) => void saveItems(items.map((item) => item.id === widget.id ? { ...item, enabled } : item))}
                      ariaLabel={t('blog.admin.widget_enabled')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                        {widget.title || t(TYPE_LABEL[widget.type as WidgetType] ?? 'blog.admin.widget_custom')}
                      </span>
                      <span className="block text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t(TYPE_LABEL[widget.type as WidgetType] ?? 'blog.admin.widget_custom')}</span>
                    </span>
                    <IconButton label={t('blog.admin.move_up')} size="sm" disabled={index === 0 || busy} onClick={() => move(index, -1)}><ArrowUp size={13} /></IconButton>
                    <IconButton label={t('blog.admin.move_down')} size="sm" disabled={index === items.length - 1 || busy} onClick={() => move(index, 1)}><ArrowDown size={13} /></IconButton>
                    <IconButton label={t('blog.admin.edit')} size="sm" onClick={() => openEdit(widget)}><Pencil size={13} /></IconButton>
                    <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(widget)}><Trash2 size={13} /></IconButton>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>
        </div>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={editingId ? t('blog.admin.widget_edit') : t('blog.admin.widget_add')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('blog.admin.cancel')}</Button>
            <Button size="sm" loading={busy} disabled={type === 'custom' && !html.trim()} onClick={add}>{t('blog.admin.save')}</Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <Field label={t('blog.admin.widget_type')}>
            <Select value={type} onChange={(event) => setType(event.target.value as WidgetType)}>
              {WIDGET_TYPES.map((value) => <option key={value} value={value}>{t(TYPE_LABEL[value])}</option>)}
            </Select>
          </Field>
          <Field label={t('blog.admin.widget_title')}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('blog.admin.widget_slot')}>
              <Select value={slot} onChange={(event) => setSlot(event.target.value as 'default' | 'top' | 'sticky')}>
                <option value="default">{t('blog.admin.widget_slot_default')}</option>
                <option value="top">{t('blog.admin.widget_slot_top')}</option>
                <option value="sticky">{t('blog.admin.widget_slot_sticky')}</option>
              </Select>
            </Field>
            {(type === 'categories' || type === 'tags' || type === 'series') && (
              <Field label={t('blog.admin.widget_collapse')} hint={t('blog.admin.widget_collapse_hint')}>
                <Input type="number" min={0} value={collapseAfter} onChange={(event) => setCollapseAfter(event.target.value)} />
              </Field>
            )}
          </div>
          <Field label={t('blog.admin.widget_pages')} hint={t('blog.admin.widget_pages_hint')}>
            <Input value={pagesText} onChange={(event) => setPagesText(event.target.value)} />
          </Field>
          {type === 'announcement' && (
            <Field label={t('blog.admin.widget_announcement_text')}>
              <Textarea rows={3} value={announcementText} onChange={(event) => setAnnouncementText(event.target.value)} />
            </Field>
          )}
          {type === 'custom' && (
            <Field label={t('blog.admin.widget_html')} hint={t('blog.admin.widget_html_hint')}>
              <Textarea rows={6} value={html} onChange={(event) => setHtml(event.target.value)} className="font-mono" />
            </Field>
          )}
        </div>
      </Modal>
    </div>
  )
}
