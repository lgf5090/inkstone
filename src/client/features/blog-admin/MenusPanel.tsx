import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import type { BlogSettings } from '@shared/blog/settings'
import type { BlogSitePublic } from '@shared/blog/model'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { AdminCard, AdminEmpty, AdminError, AdminLoading, PageHeader, useAdminResource } from './shared'

type NavLink = BlogSitePublic['nav'][number]

function navLinks(settings: BlogSettings | null): NavLink[] {
  const nav = settings?.nav as { links?: unknown } | undefined
  if (!Array.isArray(nav?.links)) return []
  return nav.links.filter((link): link is NavLink => Boolean(link) && typeof link === 'object' && typeof (link as NavLink).label === 'string')
}

function validHref(href: string): boolean {
  return href.startsWith('/') || /^https?:\/\//i.test(href)
}

export function MenusPanel() {
  const toast = useUi((state) => state.toast)
  const settings = useAdminResource(() => api.blog.settings.get(), [])
  const [links, setLinks] = useState<NavLink[]>([])
  const [editing, setEditing] = useState<{ index: number | null; parentIndex: number | null } | null>(null)
  const [label, setLabel] = useState('')
  const [href, setHref] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setLinks(navLinks(settings.data))
  }, [settings.data])

  const save = async (next: NavLink[]) => {
    setBusy(true)
    try {
      await api.blog.settings.patch('nav', { links: next })
      setLinks(next)
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const openAdd = (parentIndex: number | null = null) => {
    setEditing({ index: null, parentIndex })
    setLabel('')
    setHref('')
  }

  const openEdit = (index: number, parentIndex: number | null = null) => {
    const link = parentIndex === null ? links[index] : links[parentIndex]?.children?.[index]
    if (!link) return
    setEditing({ index, parentIndex })
    setLabel(link.label)
    setHref(link.href)
  }

  const submit = () => {
    const cleanLabel = label.trim()
    const cleanHref = href.trim()
    if (!cleanLabel || !validHref(cleanHref) || !editing) return
    const next: NavLink[] = links.map((link) => ({ ...link, children: link.children ? [...link.children] : undefined }))
    if (editing.parentIndex === null) {
      if (editing.index === null) next.push({ label: cleanLabel, href: cleanHref })
      else next[editing.index] = { ...next[editing.index], label: cleanLabel, href: cleanHref }
    } else {
      const parent = next[editing.parentIndex]
      if (!parent) return
      const children = parent.children ? [...parent.children] : []
      if (editing.index === null) children.push({ label: cleanLabel, href: cleanHref })
      else children[editing.index] = { ...children[editing.index], label: cleanLabel, href: cleanHref }
      next[editing.parentIndex] = { ...parent, children }
    }
    setEditing(null)
    void save(next)
  }

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= links.length) return
    const next = [...links]
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    void save(next)
  }

  const remove = async (index: number, parentIndex: number | null = null) => {
    const link = parentIndex === null ? links[index] : links[parentIndex]?.children?.[index]
    if (!link) return
    const ok = await confirm({
      title: t('blog.admin.menu_delete_title', { label: link.label }),
      description: t('blog.admin.menu_delete_desc'),
      confirmLabel: t('blog.admin.delete_forever'),
      tone: 'danger',
    })
    if (!ok) return
    if (parentIndex === null) {
      void save(links.filter((_, current) => current !== index))
    } else {
      const next = links.map((item, current) => current === parentIndex
        ? { ...item, children: (item.children ?? []).filter((_, child) => child !== index) }
        : item)
      void save(next)
    }
  }

  return (
    <div className="mx-auto max-w-[900px]">
      <PageHeader
        title={t('blog.admin.menus')}
        description={t('blog.admin.menus_subtitle')}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => openAdd()}>{t('blog.admin.menu_add')}</Button>}
      />

      {settings.error ? (
        <AdminError message={settings.error} onRetry={() => void settings.reload()} />
      ) : !settings.data ? (
        <AdminLoading />
      ) : links.length === 0 ? (
        <AdminEmpty>{t('blog.admin.menus_empty')}</AdminEmpty>
      ) : (
        <AdminCard className="overflow-hidden">
          <ul className="divide-y divide-[var(--border-subtle)]">
            {links.map((link, index) => (
              <li key={`${link.label}-${index}`} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">{link.label}</span>
                    <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{link.href}</span>
                  </span>
                  <IconButton label={t('blog.admin.move_up')} size="sm" disabled={index === 0 || busy} onClick={() => move(index, -1)}><ArrowUp size={13} /></IconButton>
                  <IconButton label={t('blog.admin.move_down')} size="sm" disabled={index === links.length - 1 || busy} onClick={() => move(index, 1)}><ArrowDown size={13} /></IconButton>
                  <Button size="sm" variant="ghost" onClick={() => openEdit(index)}>{t('blog.admin.edit')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void openAdd(index)}>{t('blog.admin.menu_add_child')}</Button>
                  <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(index)}><Trash2 size={13} /></IconButton>
                </div>
                {link.children && link.children.length > 0 && (
                  <ul className="mt-1 space-y-1 border-l border-[var(--border-subtle)] pl-4">
                    {link.children.map((child, childIndex) => (
                      <li key={`${child.label}-${childIndex}`} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{child.label}</span>
                          <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{child.href}</span>
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => openEdit(childIndex, index)}>{t('blog.admin.edit')}</Button>
                        <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(childIndex, index)}><Trash2 size={12} /></IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </AdminCard>
      )}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.index === null ? t('blog.admin.menu_add') : t('blog.admin.menu_edit')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t('blog.admin.cancel')}</Button>
            <Button size="sm" loading={busy} disabled={!label.trim() || !validHref(href.trim())} onClick={submit}>{t('blog.admin.save')}</Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <Field label={t('blog.admin.menu_label')}><Input value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
          <Field label={t('blog.admin.menu_href')} hint={t('blog.admin.menu_href_hint')}><Input value={href} onChange={(event) => setHref(event.target.value)} placeholder={t('blog.admin.path_placeholder')} /></Field>
          {editing?.parentIndex !== null && editing?.parentIndex !== undefined && (
            <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('blog.admin.menu_child_of', { label: links[editing.parentIndex]?.label ?? '' })}</p>
          )}
        </div>
      </Modal>
    </div>
  )
}
