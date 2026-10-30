import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Avatar, Badge, Button, IconButton } from '../../components/primitives'
import { Field, Input, Textarea } from '../../components/form'
import { api } from '../../lib/api'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { AdminCard, AdminError, AdminLoading, PageHeader, formatDateTime, useAdminResource } from './shared'

interface AccountLink {
  label: string
  url: string
}

export function AccountPanel() {
  const toast = useUi((state) => state.toast)
  const account = useAdminResource(() => api.blog.account.get(), [])
  const [name, setName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [bio, setBio] = useState('')
  const [links, setLinks] = useState<AccountLink[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!account.data) return
    setName(account.data.name)
    setAvatarUrl(account.data.avatarUrl)
    const profile = account.data.profile as { bio?: unknown; links?: unknown }
    setBio(typeof profile.bio === 'string' ? profile.bio : '')
    setLinks(Array.isArray(profile.links)
      ? profile.links.filter((link): link is AccountLink => Boolean(link) && typeof link === 'object' && typeof (link as AccountLink).label === 'string')
      : [])
  }, [account.data])

  const save = async () => {
    setBusy(true)
    try {
      await api.blog.account.update({ name, avatarUrl, bio, links: links.filter((link) => link.label.trim() && link.url.trim()) })
      await useSession.getState().refresh()
      toast({ title: t('blog.admin.saved'), tone: 'success' })
      await account.reload()
    } catch (error) {
      toast({ title: t('blog.admin.save_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (account.error) {
    return <div className="mx-auto max-w-[820px]"><AdminError message={account.error} onRetry={() => void account.reload()} /></div>
  }
  if (!account.data) return <AdminLoading />

  return (
    <div className="mx-auto max-w-[820px]">
      <PageHeader title={t('blog.admin.account')} description={t('blog.admin.account_subtitle')} />
      <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
        <AdminCard className="h-fit p-4">
          <div className="flex flex-col items-center text-center">
            <Avatar name={name || account.data.username} src={avatarUrl || undefined} size={72} />
            <p className="mt-2 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">{name || account.data.username}</p>
            <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">@{account.data.username}</p>
            <Badge tone="accent" className="mt-2">{t('blog.admin.owner')}</Badge>
          </div>
          <dl className="mt-4 space-y-2 border-t border-[var(--border-subtle)] pt-3 text-[length:var(--text-11-5)]">
            <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.account_joined')}</dt><dd className="text-[var(--text-secondary)]">{formatDateTime(account.data.createdAt)}</dd></div>
            <div><dt className="text-[var(--text-quaternary)]">{t('blog.admin.account_last_seen')}</dt><dd className="text-[var(--text-secondary)]">{formatDateTime(account.data.lastSeenAt)}</dd></div>
          </dl>
        </AdminCard>

        <AdminCard className="space-y-3 p-4">
          <Field label={t('blog.admin.account_name')}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={t('blog.admin.account_avatar')} hint={t('blog.admin.account_avatar_hint')}><Input value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} /></Field>
          <Field label={t('blog.admin.account_bio')}><Textarea rows={4} value={bio} onChange={(event) => setBio(event.target.value)} /></Field>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('blog.admin.account_links')}</span>
              <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setLinks((current) => [...current, { label: '', url: '' }])}>{t('blog.admin.account_add_link')}</Button>
            </div>
            <ul className="space-y-2">
              {links.map((link, index) => (
                <li key={index} className="flex items-center gap-2">
                  <Input value={link.label} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder={t('blog.admin.account_link_label')} aria-label={t('blog.admin.account_link_label')} />
                  <Input value={link.url} onChange={(event) => setLinks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item))} placeholder="https://" aria-label={t('blog.admin.field_url')} />
                  <IconButton label={t('blog.admin.delete_forever')} size="sm" onClick={() => setLinks((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /></IconButton>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end border-t border-[var(--border-subtle)] pt-3">
            <Button size="sm" loading={busy} onClick={() => void save()}>{t('blog.admin.save')}</Button>
          </div>
        </AdminCard>
      </div>
    </div>
  )
}
