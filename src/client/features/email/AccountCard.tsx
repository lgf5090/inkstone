import { lazy, Suspense, useRef, useState } from 'react'
import { Camera, ChartNoAxesColumn, ContactRound, ListFilter, LogOut, Mail, Moon, Settings, Settings2, Sun } from 'lucide-react'
import type { EmailAccount } from '@shared/email/model'
import { Avatar, IconButton } from '../../components/primitives'
import { Menu, Tooltip, type MenuItem } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { switchThemeWithTransition, useUi } from '../../store/ui'
import { useSession } from '../../store/session'
import { emailContactsPath, emailFolderPath, emailRulesPath, emailSettingsPath, emailStatsPath } from './email-address'

const AvatarPicker = lazy(() => import('../settings/AvatarPicker').then((module) => ({ default: module.AvatarPicker })))

export function EmailAccountCard({
  accounts,
  activeAccountId,
  compact = false,
  onNavigate,
}: {
  accounts: readonly EmailAccount[]
  activeAccountId: string
  compact?: boolean
  onNavigate?: () => void
}) {
  const user = useSession((state) => state.user)
  const theme = useSession((state) => state.settings.appearance.theme)
  const updateSettings = useSession((state) => state.updateSettings)
  const logout = useSession((state) => state.logout)
  const openPanel = useUi((state) => state.openPanel)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  if (!user) return null

  const displayName = user.name || user.username
  const isDark = theme === 'dark'
    || (theme === 'system' && document.documentElement.dataset.theme === 'dark')
  const items: MenuItem[] = [
    ...accounts.map((account) => ({
      id: `account:${account.id}`,
      label: account.displayName && account.displayName !== account.address
        ? `${account.displayName} · ${account.address}`
        : account.address,
      icon: <Mail size={13} />,
      checked: account.id === activeAccountId,
      onSelect: () => {
        onNavigate?.()
        navigateToPath(emailFolderPath(account.id, 'inbox'))
      },
    })),
    {
      id: 'mailbox-settings',
      label: t('email.header.settings'),
      icon: <Settings2 size={13} />,
      separatorBefore: true,
      onSelect: () => {
        onNavigate?.()
        navigateToPath(emailSettingsPath(activeAccountId))
      },
    },
    {
      id: 'all-mailboxes',
      label: t('email.header.all_accounts'),
      icon: <Mail size={13} />,
      onSelect: () => {
        onNavigate?.()
        navigateToPath('/email')
      },
    },
    {
      id: 'stats',
      label: t('email.stats.title'),
      icon: <ChartNoAxesColumn size={13} />,
      onSelect: () => {
        onNavigate?.()
        navigateToPath(emailStatsPath(activeAccountId))
      },
    },
    {
      id: 'rules',
      label: t('email.rules.title'),
      icon: <ListFilter size={13} />,
      onSelect: () => {
        onNavigate?.()
        navigateToPath(emailRulesPath(activeAccountId))
      },
    },
    {
      id: 'contacts',
      label: t('email.contacts.title'),
      icon: <ContactRound size={13} />,
      onSelect: () => {
        onNavigate?.()
        navigateToPath(emailContactsPath())
      },
    },
    {
      id: 'avatar',
      label: t('settings.change_avatar'),
      icon: <Camera size={13} />,
      separatorBefore: true,
      onSelect: () => setPickerOpen(true),
    },
    {
      id: 'settings',
      label: t('common.settings'),
      icon: <Settings size={13} />,
      onSelect: () => {
        onNavigate?.()
        openPanel('settings')
      },
    },
    {
      id: 'theme',
      label: isDark ? t('sidebar.switch_to_light') : t('sidebar.switch_to_dark'),
      icon: isDark ? <Sun size={13} /> : <Moon size={13} />,
      onSelect: () => {
        const rect = buttonRef.current?.getBoundingClientRect()
        const next = isDark ? 'light' : 'dark'
        switchThemeWithTransition(
          next,
          rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined,
          () => updateSettings({ appearance: { theme: next } }),
        )
      },
    },
    {
      id: 'logout',
      label: t('sidebar.log_out'),
      icon: <LogOut size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => void logout(),
    },
  ]

  const picker = pickerOpen
    ? (
        <Suspense fallback={null}>
          <AvatarPicker
            open
            onClose={() => setPickerOpen(false)}
            displayName={displayName}
            preference={user.avatarUrl}
          />
        </Suspense>
      )
    : null

  if (compact) {
    return (
      <>
        <Tooltip label={t('sidebar.account_and_settings')} side="right">
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label={t('sidebar.account_and_settings')}
            className="rounded-full transition-transform duration-[var(--dur-fast)] hover:scale-105 active:scale-95"
          >
            <Avatar src={user.avatarUrl} name={displayName} size={28} />
          </button>
        </Tooltip>
        <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={252} />
        {picker}
      </>
    )
  }

  return (
    <>
      <div className="group flex h-11 w-full items-center rounded-[var(--r-md)] transition-colors hover:bg-[var(--bg-hover)]">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label={t('sidebar.account_and_settings')}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[var(--r-md)] pl-2 text-left"
        >
          <Avatar src={user.avatarUrl} name={displayName} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--text-12-5)] font-semibold text-[var(--text-primary)]">
              {displayName}
            </span>
            <span className="block truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              @{user.username}
            </span>
          </span>
        </button>
        <Tooltip label={t('common.settings')} side="top">
          <IconButton
            label={t('common.settings')}
            size="sm"
            onClick={() => {
              onNavigate?.()
              openPanel('settings')
            }}
            className="mr-1 shrink-0 text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]"
          >
            <Settings size={14} />
          </IconButton>
        </Tooltip>
      </div>
      <Menu anchor={buttonRef} open={menuOpen} onClose={() => setMenuOpen(false)} items={items} width={252} />
      {picker}
    </>
  )
}
