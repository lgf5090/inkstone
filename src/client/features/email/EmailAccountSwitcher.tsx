import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown, Plus, Settings2, Trash2 } from 'lucide-react'
import type { EmailAccount } from '@shared/email/model'
import { Avatar, IconButton } from '../../components/primitives'
import { Tooltip, confirm, useClickOutside, useEscape } from '../../components/overlay'
import { cn } from '../../lib/cn'
import { Z_INDEX } from '../../lib/z-index'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useUi } from '../../store/ui'
import { emailFolderPath, emailSettingsPath } from './email-address'
import { emailErrorText } from './errors'
import { useEmailStore } from './store'

const PANEL_WIDTH = 300
const PANEL_MAX_HEIGHT = 420

function accountName(account: EmailAccount): string {
  return account.displayName || account.address
}

export function EmailAccountSwitcher({
  accounts,
  activeAccountId,
  onNavigate,
  onManageAccounts,
  compact = false,
}: {
  accounts: readonly EmailAccount[]
  activeAccountId: string
  onNavigate?: () => void
  onManageAccounts: (creating?: boolean) => void
  compact?: boolean
}) {
  const deleteAccount = useEmailStore((state) => state.deleteAccount)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  const active = accounts.find((entry) => entry.id === activeAccountId) ?? accounts[0] ?? null

  useEscape(open, () => setOpen(false))
  useClickOutside([panelRef, triggerRef], open, () => setOpen(false))

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
      const below = rect.bottom + 6
      const top = below + PANEL_MAX_HEIGHT > window.innerHeight - 8 && rect.top > PANEL_MAX_HEIGHT
        ? Math.max(8, rect.top - PANEL_MAX_HEIGHT - 6)
        : below
      setPosition({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    const selected = panelRef.current?.querySelector<HTMLButtonElement>('[data-account-row][aria-current="true"]')
    const first = panelRef.current?.querySelector<HTMLButtonElement>('[data-account-row]')
    ;(selected ?? first)?.focus({ preventScroll: true })
  }, [open, position])

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    triggerRef.current?.focus({ preventScroll: true })
  }, [open])

  const select = (account: EmailAccount): void => {
    setOpen(false)
    onNavigate?.()
    navigateToPath(emailFolderPath(account.id, 'inbox'))
  }

  const openSettings = (account: EmailAccount): void => {
    setOpen(false)
    onNavigate?.()
    navigateToPath(emailSettingsPath(account.id))
  }

  const remove = async (account: EmailAccount): Promise<void> => {
    setOpen(false)
    const ok = await confirm({
      title: t('email.accounts.delete_title'),
      description: t('email.accounts.delete_warning', { address: account.address }),
      confirmLabel: t('email.accounts.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await deleteAccount(account.id)
      useUi.getState().toast({ title: t('email.accounts.deleted'), tone: 'success' })
      if (account.id === activeAccountId) {
        const next = useEmailStore.getState().accounts[0]
        navigateToPath(next ? emailFolderPath(next.id, 'inbox') : '/email')
      }
    } catch (error) {
      useUi.getState().toast({ title: t('email.toast.failed'), description: emailErrorText(error), tone: 'danger' })
    }
  }

  if (!active) return null

  const panel = open && position
    ? createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t('email.accounts.mailboxes')}
          tabIndex={-1}
          className="anim-pop fixed flex max-h-[min(70vh,420px)] flex-col rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1.5 shadow-[var(--shadow-pop)] outline-none"
          style={{ top: position.top, left: position.left, width: Math.min(PANEL_WIDTH, window.innerWidth - 16), zIndex: Z_INDEX.pop }}
        >
          <p className="m-0 px-2 pt-1 pb-2 text-[length:var(--text-10-5)] font-medium tracking-wide text-[var(--text-quaternary)] uppercase">
            {t('email.accounts.mailboxes')}
          </p>
          <ul className="m-0 flex min-h-0 list-none flex-col gap-0.5 overflow-y-auto p-0">
            {accounts.map((account) => {
              const selected = account.id === activeAccountId
              return (
                <li key={account.id} className={cn(
                  'group flex items-center gap-0.5 rounded-[var(--r-md)] pr-1',
                  selected ? 'bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                  'focus-within:bg-[var(--accent-soft)]',
                )}>
                  <button
                    type="button"
                    data-account-row
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => select(account)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    <Avatar name={accountName(account)} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-primary)]">
                        {accountName(account)}
                      </span>
                      <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                        {account.address}
                      </span>
                    </span>
                  </button>
                  <span className="flex shrink-0 items-center gap-0.5">
                    {selected && (
                      <Check size={14} aria-hidden="true" className="mx-1 shrink-0 text-[var(--accent)] group-hover:hidden" />
                    )}
                    <span className="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
                      <Tooltip label={t('email.header.settings')} side="top">
                        <IconButton label={t('email.header.settings')} size="xs" onClick={() => openSettings(account)}>
                          <Settings2 size={13} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label={t('email.accounts.delete_address', { address: account.address })} side="top">
                        <IconButton label={t('email.accounts.delete_address', { address: account.address })} size="xs" onClick={() => { void remove(account) }}>
                          <Trash2 size={13} />
                        </IconButton>
                      </Tooltip>
                    </span>
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="my-1 h-px bg-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={() => { setOpen(false); onNavigate?.(); onManageAccounts(true) }}
            className="flex min-h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <span className="flex size-4 shrink-0 items-center justify-center"><Plus size={14} aria-hidden="true" /></span>
            {t('email.accounts.create')}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); onNavigate?.(); onManageAccounts(false) }}
            className="flex min-h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left text-[length:var(--text-12-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <span className="flex size-4 shrink-0 items-center justify-center"><Settings2 size={14} aria-hidden="true" /></span>
            {t('email.accounts.manage_title')}
          </button>
        </div>,
        document.body,
      )
    : null

  const triggerButton = compact
    ? (
        <Tooltip label={`${t('email.accounts.switch')} · ${active.address}`} side="right">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t('email.accounts.switch')}
            onClick={() => setOpen((current) => !current)}
            className="rounded-full transition-transform duration-[var(--dur-fast)] hover:scale-105 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            <Avatar name={accountName(active)} size={28} />
          </button>
        </Tooltip>
      )
    : (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={t('email.accounts.switch')}
          onClick={() => setOpen((current) => !current)}
          className="group flex h-10 w-full min-w-0 items-center gap-2 rounded-[var(--r-md)] px-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <Avatar name={accountName(active)} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
              {accountName(active)}
            </span>
            <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              {active.address}
            </span>
          </span>
          <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
        </button>
      )

  return (
    <>
      {triggerButton}
      {panel}
    </>
  )
}
