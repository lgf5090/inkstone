import type { ComponentType } from 'react'
import {
  Award,
  Binary,
  Blend,
  BookOpen,
  Bot,
  Camera,
  CheckSquare,
  ChevronRight,
  Compass,
  FolderTree,
  Heart,
  History,
  Image,
  KeyRound,
  Layers,
  LayoutGrid,
  LayoutTemplate,
  PanelLeft,
  PanelLeftClose,
  Lock,
  Palette,
  Printer,
  QrCode,
  ScanLine,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Wrench,
} from 'lucide-react'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import {
  useToolsStore,
  type ColorNavView,
  type IdPhotoNavView,
  type PasswordNavView,
  type QrCodeNavView,
} from './store'
import { GroupTree } from './password/GroupTree'
import { usePasswordVaultStore } from './password/store'

interface NavSlot {
  id: PasswordNavView
  labelKey: MessageKey
  icon: ComponentType<{ size?: number; className?: string }>
}

interface QrNavSlot {
  id: QrCodeNavView
  labelKey: MessageKey
  icon: ComponentType<{ size?: number; className?: string }>
}

interface IdPhotoNavSlot {
  id: IdPhotoNavView
  labelKey: MessageKey
  icon: ComponentType<{ size?: number; className?: string }>
}

interface ColorNavSlot {
  id: ColorNavView
  labelKey: MessageKey
  icon: ComponentType<{ size?: number; className?: string }>
}

const ID_PHOTO_NAV_SLOTS: readonly IdPhotoNavSlot[] = [
  { id: 'studio', labelKey: 'tools.id_photo.nav.studio', icon: Camera },
  { id: 'compliance', labelKey: 'tools.id_photo.nav.compliance', icon: ShieldCheck },
  { id: 'print', labelKey: 'tools.id_photo.nav.print', icon: Printer },
  { id: 'batch', labelKey: 'tools.id_photo.nav.batch', icon: Layers },
  { id: 'specs', labelKey: 'tools.id_photo.nav.specs', icon: Award },
  { id: 'history', labelKey: 'tools.id_photo.nav.history', icon: History },
  { id: 'settings', labelKey: 'tools.id_photo.nav.settings', icon: Settings },
]

const COLOR_NAV_SLOTS: readonly ColorNavSlot[] = [
  { id: 'studio', labelKey: 'tools.color.nav.studio', icon: Palette },
  { id: 'algorithm', labelKey: 'tools.color.nav.algorithm', icon: Binary },
  { id: 'ai_palette', labelKey: 'tools.color.nav.ai_palette', icon: Bot },
  { id: 'ui_palettes', labelKey: 'tools.color.nav.ui_palettes', icon: LayoutGrid },
  { id: 'image_palette', labelKey: 'tools.color.nav.image_palette', icon: Image },
  { id: 'traditional', labelKey: 'tools.color.nav.traditional', icon: BookOpen },
  { id: 'gradient', labelKey: 'tools.color.nav.gradient', icon: Blend },
  { id: 'color_hunt', labelKey: 'tools.color.nav.color_hunt', icon: Heart },
  { id: 'favorites', labelKey: 'tools.color.nav.favorites', icon: Star },
]

const QRCODE_NAV_SLOTS: readonly QrNavSlot[] = [
  { id: 'generator', labelKey: 'tools.qrcode.nav.generator', icon: QrCode },
  { id: 'scanner', labelKey: 'tools.qrcode.nav.scanner', icon: ScanLine },
  { id: 'compare', labelKey: 'tools.qrcode.nav.compare', icon: Compass },
  { id: 'batch', labelKey: 'tools.qrcode.nav.batch', icon: Layers },
  { id: 'history', labelKey: 'tools.qrcode.nav.history', icon: History },
  { id: 'templates', labelKey: 'tools.qrcode.nav.templates', icon: LayoutTemplate },
  { id: 'settings', labelKey: 'tools.qrcode.nav.settings', icon: Settings },
]

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
  onNavigate?: () => void
}

export function ToolsSidebar({
  collapsed = false,
  onCollapse,
  onExpand,
  onNavigate,
}: ToolsSidebarProps) {
  const activeSubmodule = useToolsStore((s) => s.activeSubmodule)
  const setActiveSubmodule = useToolsStore((s) => s.setActiveSubmodule)
  const passwordModuleExpanded = useToolsStore((s) => s.passwordModuleExpanded)
  const togglePasswordModuleExpanded = useToolsStore((s) => s.togglePasswordModuleExpanded)
  const activePasswordView = useToolsStore((s) => s.activePasswordView)
  const setActivePasswordView = useToolsStore((s) => s.setActivePasswordView)
  const qrcodeModuleExpanded = useToolsStore((s) => s.qrcodeModuleExpanded)
  const toggleQrcodeModuleExpanded = useToolsStore((s) => s.toggleQrcodeModuleExpanded)
  const activeQrCodeView = useToolsStore((s) => s.activeQrCodeView)
  const setActiveQrCodeView = useToolsStore((s) => s.setActiveQrCodeView)
  const idPhotoModuleExpanded = useToolsStore((s) => s.idPhotoModuleExpanded)
  const toggleIdPhotoModuleExpanded = useToolsStore((s) => s.toggleIdPhotoModuleExpanded)
  const activeIdPhotoView = useToolsStore((s) => s.activeIdPhotoView)
  const setActiveIdPhotoView = useToolsStore((s) => s.setActiveIdPhotoView)
  const colorModuleExpanded = useToolsStore((s) => s.colorModuleExpanded)
  const toggleColorModuleExpanded = useToolsStore((s) => s.toggleColorModuleExpanded)
  const activeColorView = useToolsStore((s) => s.activeColorView)
  const setActiveColorView = useToolsStore((s) => s.setActiveColorView)
  const isUnlocked = usePasswordVaultStore((s) => s.isUnlocked)
  const isBackupSettingsOpen = usePasswordVaultStore((s) => s.isBackupSettingsOpen)
  const isBatchOperationsOpen = usePasswordVaultStore((s) => s.isBatchOperationsOpen)

  const handleSlotClick = (slotId: PasswordNavView) => {
    setActiveSubmodule('password')
    if (slotId === 'backup_settings') {
      usePasswordVaultStore.getState().openBackupSettings()
    } else if (slotId === 'batch_operations') {
      usePasswordVaultStore.getState().openBatchOperations()
    } else {
      setActivePasswordView(slotId)
    }
    onNavigate?.()
  }

  const handleQrSlotClick = (slotId: QrCodeNavView) => {
    setActiveSubmodule('qrcode')
    setActiveQrCodeView(slotId)
    onNavigate?.()
  }

  const handleIdPhotoSlotClick = (slotId: IdPhotoNavView) => {
    setActiveSubmodule('id_photo')
    setActiveIdPhotoView(slotId)
    onNavigate?.()
  }

  const handleColorSlotClick = (slotId: ColorNavView) => {
    setActiveSubmodule('color')
    setActiveColorView(slotId)
    onNavigate?.()
  }

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
          <Tooltip label={t('tools.qrcode.module_name')} side="right">
            <IconButton
              label={t('tools.qrcode.module_name')}
              size="sm"
              active={activeSubmodule === 'qrcode'}
              onClick={() => {
                setActiveSubmodule('qrcode')
                onExpand?.()
              }}
            >
              <QrCode size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('tools.id_photo.module_name')} side="right">
            <IconButton
              label={t('tools.id_photo.module_name')}
              size="sm"
              active={activeSubmodule === 'id_photo'}
              onClick={() => {
                setActiveSubmodule('id_photo')
                onExpand?.()
              }}
            >
              <Camera size={16} />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('tools.color.module_name')} side="right">
            <IconButton
              label={t('tools.color.module_name')}
              size="sm"
              active={activeSubmodule === 'color'}
              onClick={() => {
                setActiveSubmodule('color')
                onExpand?.()
              }}
            >
              <Palette size={16} />
            </IconButton>
          </Tooltip>
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
                const isSelected =
                  activeSubmodule === 'password' &&
                  (slot.id === 'backup_settings'
                    ? isBackupSettingsOpen
                    : slot.id === 'batch_operations'
                      ? isBatchOperationsOpen
                      : activePasswordView === slot.id)
                return (
                  <button
                    key={slot.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => handleSlotClick(slot.id)}
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

        <div>
          <button
            type="button"
            aria-expanded={qrcodeModuleExpanded}
            onClick={toggleQrcodeModuleExpanded}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]',
              'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              activeSubmodule === 'qrcode' && 'text-[var(--text-primary)]',
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'transition-transform duration-[var(--dur-fast)]',
                  qrcodeModuleExpanded ? 'rotate-90' : 'rotate-0',
                )}
              >
                <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
              </span>
              <QrCode size={16} className="shrink-0 text-[var(--accent)]" />
              <span className="truncate">{t('tools.qrcode.module_name')}</span>
            </div>
          </button>

          {qrcodeModuleExpanded && (
            <div className="mt-1 ml-4 space-y-0.5 border-l border-[var(--border-subtle)] pl-2">
              {QRCODE_NAV_SLOTS.map((slot) => {
                const Icon = slot.icon
                const isSelected = activeSubmodule === 'qrcode' && activeQrCodeView === slot.id
                return (
                  <button
                    key={slot.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => handleQrSlotClick(slot.id)}
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
            </div>
          )}
        </div>

        {/* Submodule: ID Photo Studio (tools/id_photo) */}
        <div>
          <button
            type="button"
            aria-expanded={idPhotoModuleExpanded}
            onClick={toggleIdPhotoModuleExpanded}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]',
              'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              activeSubmodule === 'id_photo' && 'text-[var(--text-primary)]',
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'transition-transform duration-[var(--dur-fast)]',
                  idPhotoModuleExpanded ? 'rotate-90' : 'rotate-0',
                )}
              >
                <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
              </span>
              <Camera size={16} className="shrink-0 text-[var(--accent)]" />
              <span className="truncate">{t('tools.id_photo.module_name')}</span>
            </div>
          </button>

          {idPhotoModuleExpanded && (
            <div className="mt-1 ml-4 space-y-0.5 border-l border-[var(--border-subtle)] pl-2">
              {ID_PHOTO_NAV_SLOTS.map((slot) => {
                const Icon = slot.icon
                const isSelected = activeSubmodule === 'id_photo' && activeIdPhotoView === slot.id
                return (
                  <button
                    key={slot.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => handleIdPhotoSlotClick(slot.id)}
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
            </div>
          )}
        </div>

        {/* Third submodule: Color Assistant (tools/color) */}
        <div>
          <button
            type="button"
            aria-expanded={colorModuleExpanded}
            onClick={toggleColorModuleExpanded}
            className={cn(
              'flex w-full items-center justify-between gap-2 rounded-[var(--r-md)] px-2.5 py-1.5 text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]',
              'transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              activeSubmodule === 'color' && 'text-[var(--text-primary)]',
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'transition-transform duration-[var(--dur-fast)]',
                  colorModuleExpanded ? 'rotate-90' : 'rotate-0',
                )}
              >
                <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
              </span>
              <Palette size={16} className="shrink-0 text-[var(--accent)]" />
              <span className="truncate">{t('tools.color.module_name')}</span>
            </div>
          </button>

          {colorModuleExpanded && (
            <div className="mt-1 ml-4 space-y-0.5 border-l border-[var(--border-subtle)] pl-2">
              {COLOR_NAV_SLOTS.map((slot) => {
                const Icon = slot.icon
                const isSelected = activeSubmodule === 'color' && activeColorView === slot.id
                return (
                  <button
                    key={slot.id}
                    type="button"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => handleColorSlotClick(slot.id)}
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
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
