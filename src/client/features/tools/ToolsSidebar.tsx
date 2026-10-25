import type { ComponentType } from 'react'
import {
  CheckSquare,
  ChevronRight,
  FolderTree,
  KeyRound,
  Layers,
  PanelLeft,
  PanelLeftClose,
  Lock,
  Settings,
  Sparkles,
  Star,
  Wrench,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { useToolsStore, type PasswordNavView } from './store'
import { GroupTree } from './password/GroupTree'
import { usePasswordVaultStore } from './password/store'

interface NavSlot {
  id: PasswordNavView
  labelKey: MessageKey
  icon: ComponentType<{ size?: number; className?: string }>
}

const PASSWORD_NAV_SLOTS: readonly NavSlot[] = [
  { id: 'all', labelKey: 'tools.password.nav.all', icon: Layers },
  { id: 'favorites', labelKey: 'tools.password.nav.favorites', icon: Star },
  { id: 'generator', labelKey: 'tools.password.nav.generator', icon: Sparkles },
  { id: 'groups', labelKey: 'tools.password.nav.groups', icon: FolderTree },
  { id: 'backup_settings', labelKey: 'tools.password.nav.backup_settings', icon: Settings },
  { id: 'batch_operations', labelKey: 'tools.password.nav.batch_operations', icon: CheckSquare },
]

export interface ToolsSidebarProps {
  collapsed?: boolean
  onCollapse?: () => void
  onExpand?: () => void
}

export function ToolsSidebar({
  collapsed = false,
  onCollapse,
  onExpand,
}: ToolsSidebarProps) {
  const activeSubmodule = useToolsStore((s) => s.activeSubmodule)
  const setActiveSubmodule = useToolsStore((s) => s.setActiveSubmodule)
  const passwordModuleExpanded = useToolsStore((s) => s.passwordModuleExpanded)
  const togglePasswordModuleExpanded = useToolsStore((s) => s.togglePasswordModuleExpanded)
  const activePasswordView = useToolsStore((s) => s.activePasswordView)
  const setActivePasswordView = useToolsStore((s) => s.setActivePasswordView)
  const isUnlocked = usePasswordVaultStore((s) => s.isUnlocked)

  if (collapsed) {
    return (
      <aside
        aria-label={t('tools.sidebar.title')}
        className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
      >
        <div className="flex h-11 w-full shrink-0 items-center justify-center border-b border-[var(--border-subtle)]">
          <Tooltip label={t('tools.sidebar.expand')} side="right">
            <IconButton
              label={t('tools.sidebar.expand')}
              size="sm"
              onClick={onExpand}
            >
              <PanelLeft size={16} />
            </IconButton>
          </Tooltip>
        </div>

        <div className="flex w-full flex-col items-center gap-1 py-2">
          <Tooltip label={t('tools.password.module_name')} side="right">
            <IconButton
              label={t('tools.password.module_name')}
              size="sm"
              active={activeSubmodule === 'password'}
              onClick={() => {
                setActiveSubmodule('password')
                onExpand?.()
              }}
            >
              <KeyRound size={16} />
            </IconButton>
          </Tooltip>

          <div className="my-1 h-px w-6 bg-[var(--border-subtle)]" />

          {PASSWORD_NAV_SLOTS.map((slot) => {
            const Icon = slot.icon
            const isSelected = activeSubmodule === 'password' && activePasswordView === slot.id
            return (
              <Tooltip key={slot.id} label={t(slot.labelKey)} side="right">
                <IconButton
                  label={t(slot.labelKey)}
                  size="sm"
                  active={isSelected}
                  onClick={() => {
                    setActiveSubmodule('password')
                    setActivePasswordView(slot.id)
                  }}
                >
                  <Icon size={16} />
                </IconButton>
              </Tooltip>
            )
          })}
        </div>
      </aside>
    )
  }

  return (
    <aside
      aria-label={t('tools.sidebar.title')}
      className="flex h-full min-h-0 w-full flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)]"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Wrench size={18} className="shrink-0 text-[var(--text-secondary)]" />
          <h2 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
            {t('tools.sidebar.title')}
          </h2>
        </div>
        {onCollapse && (
          <Tooltip label={t('tools.sidebar.collapse')}>
            <IconButton
              label={t('tools.sidebar.collapse')}
              size="sm"
              onClick={onCollapse}
            >
              <PanelLeftClose size={15} />
            </IconButton>
          </Tooltip>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {/* First submodule: Password Vault (tools/password) */}
        <div>
          <button
            type="button"
            aria-expanded={passwordModuleExpanded}
            onClick={togglePasswordModuleExpanded}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]',
              'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              activeSubmodule === 'password' && 'text-[var(--text-primary)]',
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'transition-transform duration-[var(--dur-fast)]',
                  passwordModuleExpanded ? 'rotate-90' : 'rotate-0',
                )}
              >
                <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
              </span>
              <KeyRound size={16} className="shrink-0 text-[var(--accent)]" />
              <span className="truncate">{t('tools.password.module_name')}</span>
            </div>
            {isUnlocked && (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('tools.password.door.lock_now')}
                title={t('tools.password.door.lock_now')}
                onClick={(e) => {
                  e.stopPropagation()
                  usePasswordVaultStore.getState().lock()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    usePasswordVaultStore.getState().lock()
                  }
                }}
                className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
              >
                <Lock size={13} />
              </span>
            )}
          </button>

          {passwordModuleExpanded && (
            <div className="mt-1 ml-4 space-y-0.5 border-l border-[var(--border-subtle)] pl-2">
              {PASSWORD_NAV_SLOTS.map((slot) => {
                const Icon = slot.icon
                const isSelected = activeSubmodule === 'password' && activePasswordView === slot.id
                return (
                  <button
                    key={slot.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => {
                      setActiveSubmodule('password')
                      setActivePasswordView(slot.id)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]',
                      'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                      'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                      isSelected &&
                        'bg-[var(--accent-soft)] font-medium text-[var(--accent-on-soft)]',
                    )}
                  >
                    <Icon size={14} className="shrink-0" />
                    <span className="truncate">{t(slot.labelKey)}</span>
                  </button>
                )
              })}

              {/* Group tree mounting slot */}
              <div
                data-testid="tools-password-group-tree-slot"
                className="mt-2 pt-2 border-t border-[var(--border-subtle)]"
              >
                <GroupTree />
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
