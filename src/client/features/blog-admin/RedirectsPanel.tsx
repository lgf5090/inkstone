import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { BlogRedirectItem } from '@shared/blog/model'
import { Badge, Button, IconButton } from '../../components/primitives'
import { Field, Input, Select } from '../../components/form'
import { Modal, confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { AdminCard, AdminEmpty, AdminError, AdminLoading, PageHeader, SearchField, formatDate, useAdminResource, useDebounced } from './shared'

export function RedirectsPanel() {
  const toast = useUi((state) => state.toast)
  const redirects = useAdminResource(() => api.blog.redirects.list(), [])
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 200)
  const [editing, setEditing] = useState<BlogRedirectItem | null>(null)
  const [adding, setAdding] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [status, setStatus] = useState(301)
  const [busy, setBusy] = useState(false)

  const items = (redirects.data?.items ?? []).filter((item) => {
    if (!debounced.trim()) return true
    const needle = debounced.trim().toLowerCase()
    return item.from.toLowerCase().includes(needle) || item.to.toLowerCase().includes(needle)
  })

  const openAdd = () => {
    setEditing(null)
    setFrom('')
    setTo('')
    setStatus(301)
    setAdding(true)
  }

  const openEdit = (item: BlogRedirectItem) => {
    setEditing(item)
    setFrom(item.from)
    setTo(item.to)
    setStatus(item.status)
    setAdding(true)
  }

  const save = async () => {
    if (!from.trim().startsWith('/') || !to.trim().startsWith('/') || from.trim() === to.trim()) {
      toast({ title: t('blog.admin.redirect_invalid'), tone: 'danger' })
      return
    }
    setBusy(true)
    try {
      await api.blog.redirects.save({ from: from.trim(), to: to.trim(), status })
      setAdding(false)
      await redirects.reload()
      toast({ title: t('blog.admin.saved'), tone: 'success' })
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (item: BlogRedirectItem) => {
    const ok = await confirm({
      title: t('blog.admin.redirect_delete_title', { from: item.from }),
      description: t('blog.admin.redirect_delete_desc'),
      confirmLabel: t('blog.admin.delete_forever'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.blog.redirects.remove(item.from)
      await redirects.reload()
    } catch (error) {
      toast({ title: t('blog.admin.delete_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    }
  }

  return (
    <div className="mx-auto max-w-[900px]">
      <PageHeader
        title={t('blog.admin.redirects')}
        description={t('blog.admin.redirects_subtitle')}
        actions={<Button size="sm" icon={<Plus size={13} />} onClick={openAdd}>{t('blog.admin.redirect_add')}</Button>}
      />
      <div className="mb-3 flex items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder={t('blog.admin.redirect_search')} className="max-w-sm" />
      </div>

      {redirects.error ? (
        <AdminError message={redirects.error} onRetry={() => void redirects.reload()} />
      ) : !redirects.data ? (
        <AdminLoading />
      ) : items.length === 0 ? (
        <AdminEmpty>{t('blog.admin.redirects_empty')}</AdminEmpty>
      ) : (
        <AdminCard className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left text-[length:var(--text-12-5)]">
              <caption className="sr-only">{t('blog.admin.redirects')}</caption>
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                  <th scope="col" className="px-3 py-2 font-medium">{t('blog.admin.redirect_from')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.redirect_to')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.redirect_status')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('blog.admin.column_date')}</th>
                  <th scope="col" className="w-20 px-2 py-2"><span className="sr-only">{t('blog.admin.column_actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.from} className="border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-3 py-2.5 font-mono text-[length:var(--text-11-5)] text-[var(--text-primary)]">{item.from}</td>
                    <td className="px-2 py-2.5 font-mono text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{item.to}</td>
                    <td className="px-2 py-2.5"><Badge tone={item.status === 301 ? 'accent' : 'neutral'}>{item.status}</Badge></td>
                    <td className="whitespace-nowrap px-2 py-2.5 text-[var(--text-tertiary)]">{formatDate(item.createdAt)}</td>
                    <td className="px-2 py-2.5">
                      <div className="flex justify-end gap-0.5">
                        <Button size="sm" variant="ghost" onClick={() => openEdit(item)}>{t('blog.admin.edit')}</Button>
                        <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => void remove(item)}><Trash2 size={13} /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={editing ? t('blog.admin.redirect_edit') : t('blog.admin.redirect_add')}
        footer={(
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('blog.admin.cancel')}</Button>
            <Button size="sm" loading={busy} onClick={() => void save()}>{t('blog.admin.save')}</Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <Field label={t('blog.admin.redirect_from')} hint={t('blog.admin.redirect_from_hint')}>
            <Input value={from} onChange={(event) => setFrom(event.target.value)} placeholder={t('blog.admin.redirect_from_placeholder')} />
          </Field>
          <Field label={t('blog.admin.redirect_to')} hint={t('blog.admin.redirect_to_hint')}>
            <Input value={to} onChange={(event) => setTo(event.target.value)} placeholder={t('blog.admin.redirect_to_placeholder')} />
          </Field>
          <Field label={t('blog.admin.redirect_status')}>
            <Select value={status} onChange={(event) => setStatus(Number(event.target.value) === 302 ? 302 : 301)}>
              <option value={301}>{t('blog.admin.redirect_301')}</option>
              <option value={302}>{t('blog.admin.redirect_302')}</option>
            </Select>
          </Field>
          {editing && <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('blog.admin.redirect_edit_hint')}</p>}
        </div>
      </Modal>
    </div>
  )
}
