import { useEffect, useId, useState } from 'react'
import { ArrowLeft, Pencil, Plus, Trash2, X } from 'lucide-react'
import { isValidEmailAddress } from '@shared/email/format'
import type { EmailFolder } from '@shared/email/model'
import type {
  EmailBlockedSender,
  EmailFilter,
  EmailFilterAction,
  EmailFilterCondition,
} from '@shared/email/rules'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Field, Input, Switch } from '../../components/form'
import { confirm } from '../../components/overlay'
import { api } from '../../lib/api'
import { navigateToPath } from '../../lib/app-history'
import { t } from '../../lib/i18n'
import { formatNumber } from '../../lib/time'
import { useUi } from '../../store/ui'
import { emailFolderPath } from './email-address'
import { emailErrorText } from './errors'
import { folderLabel } from './format'
import { RuleEditor } from './RuleEditor'
import { useEmailStore } from './store'

type RulesStatus = 'loading' | 'ready' | 'error'

function conditionSummary(condition: EmailFilterCondition): string {
  switch (condition.field) {
    case 'fromContains':
      return t('email.rules.summary.from', { value: condition.value })
    case 'toContains':
      return t('email.rules.summary.to', { value: condition.value })
    case 'subjectContains':
      return t('email.rules.summary.subject', { value: condition.value })
    case 'hasAttachment':
      return t('email.rules.summary.has_attachment')
    case 'minBytes':
      return t('email.rules.summary.min_bytes', { value: formatNumber(condition.value) })
  }
}

function actionSummary(action: EmailFilterAction, folders: readonly EmailFolder[]): string {
  switch (action.type) {
    case 'moveTo':
      return t('email.rules.summary.move', { folder: folderLabel(action.folder, folders) })
    case 'addTag':
      return t('email.rules.summary.tag', { tag: action.tag })
    case 'markRead':
      return t('email.rules.summary.read')
    case 'star':
      return t('email.rules.summary.star')
    case 'trash':
      return t('email.rules.summary.trash')
  }
}

function filterSummary(filter: EmailFilter, folders: readonly EmailFolder[]): string {
  return [
    ...filter.conditions.map((condition) => conditionSummary(condition)),
    ...filter.actions.map((action) => actionSummary(action, folders)),
  ].join(' · ')
}

export function RulesPage({ accountId }: { accountId: string }) {
  const account = useEmailStore((state) => state.accounts.find((entry) => entry.id === accountId) ?? null)
  const folders = useEmailStore((state) => state.folders)
  const foldersAccountId = useEmailStore((state) => state.foldersAccountId)
  const loadFolders = useEmailStore((state) => state.loadFolders)
  const [filters, setFilters] = useState<EmailFilter[]>([])
  const [blocked, setBlocked] = useState<EmailBlockedSender[]>([])
  const [status, setStatus] = useState<RulesStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<EmailFilter | null>(null)
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const filtersHeadingId = useId()
  const blockedHeadingId = useId()

  useEffect(() => {
    let live = true
    setStatus('loading')
    setError(null)
    setFilters([])
    setBlocked([])
    void Promise.all([
      api.email.listFilters(accountId),
      api.email.listBlockedSenders(accountId),
    ]).then(([nextFilters, nextBlocked]) => {
      if (!live) return
      setFilters(nextFilters)
      setBlocked(nextBlocked)
      setStatus('ready')
    }).catch((reason) => {
      if (!live) return
      setStatus('error')
      setError(emailErrorText(reason))
    })
    return () => {
      live = false
    }
  }, [accountId, reloadToken])

  useEffect(() => {
    if (foldersAccountId === accountId) return
    void loadFolders(accountId)
  }, [accountId, foldersAccountId, loadFolders])

  const openCreate = (): void => {
    setEditing(null)
    setEditorOpen(true)
  }

  const openEdit = (filter: EmailFilter): void => {
    setEditing(filter)
    setEditorOpen(true)
  }

  const closeEditor = (): void => {
    setEditorOpen(false)
    setEditing(null)
  }

  const saved = (filter: EmailFilter): void => {
    setFilters((current) => {
      const exists = current.some((entry) => entry.id === filter.id)
      return exists
        ? current.map((entry) => entry.id === filter.id ? filter : entry)
        : [...current, filter]
    })
    closeEditor()
    useUi.getState().toast({ title: t('email.rules.saved'), tone: 'success' })
  }

  const toggle = async (filter: EmailFilter, enabled: boolean): Promise<void> => {
    const previous = filters
    setFilters((current) => current.map((entry) => entry.id === filter.id ? { ...entry, enabled } : entry))
    try {
      const updated = await api.email.updateFilter(accountId, filter.id, { enabled })
      setFilters((current) => current.map((entry) => entry.id === filter.id ? updated : entry))
    } catch (reason) {
      setFilters(previous)
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: emailErrorText(reason),
        tone: 'danger',
      })
    }
  }

  const remove = async (filter: EmailFilter): Promise<void> => {
    const ok = await confirm({
      title: t('email.rules.delete_title', { name: filter.name }),
      description: t('email.rules.delete_hint'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.email.deleteFilter(accountId, filter.id)
      setFilters((current) => current.filter((entry) => entry.id !== filter.id))
      useUi.getState().toast({ title: t('email.rules.deleted'), tone: 'success' })
    } catch (reason) {
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: emailErrorText(reason),
        tone: 'danger',
      })
    }
  }

  const addBlocked = async (): Promise<void> => {
    const value = address.trim()
    if (!isValidEmailAddress(value)) {
      setAddressError(t('email.rules.block_invalid'))
      return
    }
    setAdding(true)
    setAddressError(null)
    try {
      const row = await api.email.addBlockedSender(accountId, value)
      setBlocked((current) => [row, ...current.filter((entry) => entry.address !== row.address)])
      setAddress('')
      useUi.getState().toast({ title: t('email.rules.block_added'), tone: 'success' })
    } catch (reason) {
      setAddressError(emailErrorText(reason))
    } finally {
      setAdding(false)
    }
  }

  const removeBlocked = async (entry: EmailBlockedSender): Promise<void> => {
    try {
      await api.email.removeBlockedSender(accountId, entry.address)
      setBlocked((current) => current.filter((row) => row.address !== entry.address))
      useUi.getState().toast({ title: t('email.rules.block_removed'), tone: 'success' })
    } catch (reason) {
      useUi.getState().toast({
        title: t('email.toast.failed'),
        description: emailErrorText(reason),
        tone: 'danger',
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 md:px-3">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={14} />}
          onClick={() => navigateToPath(emailFolderPath(accountId, 'inbox'))}
        >
          {t('email.header.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {t('email.rules.title')}
          </h1>
          {account && (
            <p className="m-0 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {account.displayName ? `${account.displayName} · ${account.address}` : account.address}
            </p>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-4 md:px-4">
          <section
            aria-labelledby={filtersHeadingId}
            className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h2 id={filtersHeadingId} className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                  {t('email.rules.filters')}
                </h2>
                <p className="m-0 mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
                  {t('email.rules.filters_hint')}
                </p>
              </div>
              <Button size="sm" icon={<Plus size={14} />} onClick={openCreate}>{t('email.rules.new')}</Button>
            </div>
            <div className="mt-3">
              {status === 'loading' && <LoadingBlock label={t('email.rules.loading')} />}
              {status === 'error' && (
                <Empty
                  compact
                  art="folder"
                  title={t('email.rules.error')}
                  description={error}
                  action={<Button size="sm" onClick={() => setReloadToken((token) => token + 1)}>{t('common.retry')}</Button>}
                />
              )}
              {status === 'ready' && filters.length === 0 && (
                <Empty compact art="folder" title={t('email.rules.empty')} description={t('email.rules.empty_hint')} />
              )}
              {status === 'ready' && filters.length > 0 && (
                <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
                  {filters.map((filter) => (
                    <li key={filter.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="m-0 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
                          {filter.name}
                        </p>
                        <p className="m-0 mt-0.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
                          {filterSummary(filter, folders)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Switch
                          checked={filter.enabled}
                          onChange={(next) => { void toggle(filter, next) }}
                          label={t('email.rules.toggle', { name: filter.name })}
                        />
                        <IconButton label={t('email.rules.edit_named', { name: filter.name })} size="sm" onClick={() => openEdit(filter)}>
                          <Pencil size={14} />
                        </IconButton>
                        <IconButton label={t('email.rules.delete_named', { name: filter.name })} size="sm" onClick={() => { void remove(filter) }}>
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          <section
            aria-labelledby={blockedHeadingId}
            className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4"
          >
            <h2 id={blockedHeadingId} className="m-0 text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('email.rules.blocked')}
            </h2>
            <p className="m-0 mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
              {t('email.rules.blocked_hint')}
            </p>
            <form
              className="mt-3 flex flex-col gap-2 md:flex-row md:items-end"
              onSubmit={(event) => {
                event.preventDefault()
                void addBlocked()
              }}
            >
              <Field className="min-w-0 flex-1" label={t('email.rules.block_address')}>
                <Input
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  value={address}
                  placeholder={t('email.rules.block_address_placeholder')}
                  aria-invalid={Boolean(addressError)}
                  onChange={(event) => {
                    setAddress(event.target.value)
                    setAddressError(null)
                  }}
                />
              </Field>
              <Button type="submit" size="sm" disabled={adding}>{t('email.rules.block_add')}</Button>
            </form>
            {addressError && (
              <p role="alert" className="m-0 mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2.5 py-1.5 text-[length:var(--text-11)] text-[var(--danger)]">
                {addressError}
              </p>
            )}
            {blocked.length === 0 ? (
              <p className="m-0 mt-3 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                {t('email.rules.blocked_empty')}
              </p>
            ) : (
              <ul className="m-0 mt-3 list-none divide-y divide-[var(--border-subtle)] p-0">
                {blocked.map((entry) => (
                  <li key={entry.address} className="flex min-h-10 items-center gap-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-secondary)]">
                      {entry.address}
                    </span>
                    <IconButton
                      label={t('email.rules.block_remove', { address: entry.address })}
                      size="sm"
                      onClick={() => { void removeBlocked(entry) }}
                    >
                      <X size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
      <RuleEditor
        open={editorOpen}
        accountId={accountId}
        filter={editing}
        folders={folders}
        onClose={closeEditor}
        onSaved={saved}
      />
    </div>
  )
}
