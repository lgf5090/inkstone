import { useState } from 'react'
import { CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, Trash2, UserRound } from 'lucide-react'
import type { GithubAccountView } from '@shared/development/github/types'
import { t } from '../../../../lib/i18n'
import { isImeComposing } from '../../../../lib/ime'
import { Button, IconButton } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { Empty } from '../../../../components/feedback'
import { Modal, confirm } from '../../../../components/overlay'
import { GithubIcon } from './GithubIcon'

export function AccountsView({
  accounts,
  onAdd,
  onDelete,
}: {
  accounts: GithubAccountView[]
  onAdd: (token: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [pending, setPending] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const add = async () => {
    const trimmed = token.trim()
    if (!trimmed) {
      setError(t('development.github.accounts.token_required'))
      return
    }
    setPending(true)
    setError(null)
    setSuccess(null)
    try {
      await onAdd(trimmed)
      setSuccess(t('development.github.accounts.added_plain'))
      setToken('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('development.github.accounts.add_failed'))
    } finally {
      setPending(false)
    }
  }

  const remove = async (account: GithubAccountView) => {
    const ok = await confirm({
      title: t('development.github.accounts.delete'),
      description: t('development.github.accounts.delete_confirm', { username: account.username }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setDeleting(account.id)
    setError(null)
    try {
      await onDelete(account.id)
      setSuccess(t('development.github.accounts.deleted'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('development.github.accounts.delete_failed'))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-start gap-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--accent)]" />
        <div>
          <p className="font-medium text-[var(--text-secondary)]">{t('development.github.accounts.desc_title')}</p>
          <p className="mt-0.5">{t('development.github.accounts.desc')}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {accounts.length === 0 ? (
          <Empty art="select" title={t('development.github.accounts.empty')} />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3">
                {account.avatarUrl
                  ? <img src={account.avatarUrl} alt={account.username} loading="lazy" referrerPolicy="no-referrer" className="size-9 shrink-0 rounded-full bg-[var(--bg-inset)]" />
                  : <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--bg-inset)]"><UserRound size={15} className="text-[var(--text-tertiary)]" /></span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[length:var(--text-13)] font-medium">{account.username}</p>
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    {t('development.github.accounts.added_at', { date: new Date(account.createdAt).toLocaleDateString() })}
                  </p>
                </div>
                <a href={`https://github.com/${encodeURIComponent(account.username)}`} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title={t('development.github.accounts.open_profile')}>
                  <ExternalLink size={14} />
                </a>
                <IconButton label={t('development.github.accounts.delete_token', { username: account.username })} size="sm" onClick={() => void remove(account)} disabled={deleting === account.id}>
                  {deleting === account.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] p-3">
        <label htmlFor="github-account-token" className="text-[length:var(--text-12)] font-medium">{t('development.github.accounts.add_new')}</label>
        <div className="flex items-center gap-2">
          <Input
            id="github-account-token"
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(event) => { setToken(event.target.value); setError(null) }}
            onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter' && token.trim() && !pending) { event.preventDefault(); void add() } }}
            placeholder={t('development.github.accounts.token_placeholder')}
            className="h-9 font-mono text-[length:var(--text-12)]"
            leading={<KeyRound size={13} />}
            trailing={<IconButton label={showToken ? t('development.github.accounts.hide_token') : t('development.github.accounts.show_token')} size="sm" onClick={() => setShowToken((value) => !value)}>{showToken ? <EyeOff size={13} /> : <Eye size={13} />}</IconButton>}
          />
          <Button size="sm" onClick={() => void add()} disabled={pending || !token.trim()} loading={pending}>
            {t('development.github.accounts.add')}
          </Button>
        </div>
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {t('development.github.accounts.token_hint')} <code className="rounded bg-[var(--bg-inset)] px-1">{t('development.github.accounts.token_scope')}</code>{t('development.github.accounts.token_hint2')}
        </p>
        <a href="https://github.com/settings/tokens/new?scopes=gist" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[length:var(--text-11)] text-[var(--accent)] hover:underline">
          <ExternalLink size={12} /> {t('development.github.accounts.create_token_link')}
        </a>
        {error && <p className="text-[length:var(--text-11)] text-[var(--danger)]" role="alert">{error}</p>}
        {success && <p className="flex items-center gap-1 text-[length:var(--text-11)] text-[var(--success)]"><CheckCircle2 size={12} /> {success}</p>}
      </div>
    </div>
  )
}

export function AccountsDialog({
  open,
  onClose,
  accounts,
  onAdd,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  accounts: GithubAccountView[]
  onAdd: (token: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  return (
    <Modal open={open} onClose={onClose} title={<span className="inline-flex items-center gap-2"><GithubIcon className="size-4" /> {t('development.github.accounts.title')}</span>} description={t('development.github.accounts.title_desc')} width={680}>
      <AccountsView accounts={accounts} onAdd={onAdd} onDelete={onDelete} />
    </Modal>
  )
}
