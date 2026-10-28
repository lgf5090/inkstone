import { useRef, useState } from 'react'
import {
  ChevronDown,
  Briefcase,
  Columns2,
  Globe,
  History,
  Layers,
  Rows2,
  Settings2,
  Sparkles,
  Tag,
  Timer,
  Upload,
  Code2,
} from 'lucide-react'
import type { MenuItem } from '../../../../components/overlay'
import { Menu, Tooltip } from '../../../../components/overlay'
import { IconButton } from '../../../../components/primitives'
import { Select } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { TIMEOUT_OPTIONS } from '@shared/development/api-tester/limits'
import { useApiTesterStore } from '../store'

export type ToolbarDialog = 'env' | 'tags' | 'curl' | 'history' | 'mock' | 'io' | 'ws' | 'workspaces'

export function AppToolbar({
  compact,
  onOpen,
  onOpenCollections,
}: {
  compact: boolean
  onOpen: (dialog: ToolbarDialog) => void
  onOpenCollections?: () => void
}) {
  const workspaces = useApiTesterStore((s) => s.workspaces)
  const activeWorkspaceId = useApiTesterStore((s) => s.activeWorkspaceId)
  const state = useApiTesterStore((s) => s.state)
  const switchWorkspace = useApiTesterStore((s) => s.switchWorkspace)
  const patchState = useApiTesterStore((s) => s.patchState)
  const patchSettings = useApiTesterStore((s) => s.patchSettings)
  const conflict = useApiTesterStore((s) => s.conflict)
  const saving = useApiTesterStore((s) => s.saving)

  const workspaceRef = useRef<HTMLButtonElement>(null)
  const settingsRef = useRef<HTMLButtonElement>(null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const activeEnvironment = state.environments.find((environment) => environment.id === state.activeEnvId)

  const workspaceItems: MenuItem[] = [
    ...workspaces.map((workspace) => ({
      id: `ws-${workspace.id}`,
      label: workspace.name,
      checked: workspace.id === activeWorkspaceId,
      onSelect: () => {
        setWorkspaceOpen(false)
        void switchWorkspace(workspace.id)
      },
    })),
    { id: 'ws-manage', label: t('development.apitester.toolbar.manage_workspaces'), icon: <Settings2 size={14} />, separatorBefore: true, onSelect: () => { setWorkspaceOpen(false); onOpen('workspaces') } },
  ]

  const settingsItems: MenuItem[] = [
    { id: 'workspaces', label: t('development.apitester.toolbar.manage_workspaces'), icon: <Layers size={14} />, onSelect: () => { setSettingsOpen(false); onOpen('workspaces') } },
    { id: 'env', label: t('development.apitester.toolbar.environments'), icon: <Globe size={14} />, onSelect: () => { setSettingsOpen(false); onOpen('env') } },
    { id: 'tags', label: t('development.apitester.toolbar.tags'), icon: <Tag size={14} />, onSelect: () => { setSettingsOpen(false); onOpen('tags') } },
    { id: 'curl', label: t('development.apitester.toolbar.curl'), icon: <Code2 size={14} />, onSelect: () => { setSettingsOpen(false); onOpen('curl') } },
    { id: 'history', label: t('development.apitester.toolbar.history'), icon: <History size={14} />, onSelect: () => { setSettingsOpen(false); onOpen('history') } },
    { id: 'mock', label: t('development.apitester.toolbar.mock'), icon: <Sparkles size={14} />, onSelect: () => { setSettingsOpen(false); onOpen('mock') } },
    { id: 'io', label: t('development.apitester.toolbar.io'), icon: <Upload size={14} />, separatorBefore: true, onSelect: () => { setSettingsOpen(false); onOpen('io') } },
    { id: 'redirects', label: t('development.apitester.toolbar.follow_redirects'), checked: state.settings.followRedirects, separatorBefore: true, onSelect: () => patchSettings({ followRedirects: !state.settings.followRedirects }) },
    { id: 'prettify', label: t('development.apitester.toolbar.auto_prettify'), checked: state.settings.autoPrettify, onSelect: () => patchSettings({ autoPrettify: !state.settings.autoPrettify }) },
    ...TIMEOUT_OPTIONS.map((ms) => ({
      id: `timeout-${ms}`,
      label: `${t('development.apitester.toolbar.timeout')}: ${ms / 1000}s`,
      icon: <Timer size={14} />,
      checked: state.settings.timeoutMs === ms,
      separatorBefore: ms === TIMEOUT_OPTIONS[0],
      onSelect: () => patchSettings({ timeoutMs: ms }),
    })),
  ]

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-2">
      {compact && onOpenCollections && (
        <Tooltip label={t('development.apitester.toolbar.collections')}>
          <IconButton label={t('development.apitester.toolbar.collections')} size="sm" onClick={onOpenCollections}>
            <Layers size={16} />
          </IconButton>
        </Tooltip>
      )}
      <Globe size={16} className="shrink-0 text-[var(--accent)]" />
      {compact ? (
        <button
          ref={workspaceRef}
          type="button"
          aria-label={t('development.apitester.toolbar.workspace')}
          aria-haspopup="menu"
          aria-expanded={workspaceOpen}
          onClick={() => setWorkspaceOpen((open) => !open)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          <Briefcase size={16} />
        </button>
      ) : (
        <button
          ref={workspaceRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={workspaceOpen}
          onClick={() => setWorkspaceOpen((open) => !open)}
          className={cn(
            'inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2',
            'text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          )}
        >
          <Layers size={13} className="shrink-0" />
          <span className="max-w-[140px] truncate">{activeWorkspace?.name ?? t('development.apitester.toolbar.workspace')}</span>
          <ChevronDown size={12} className="shrink-0 opacity-60" />
        </button>
      )}
      {!compact && (
        <Select
          aria-label={t('development.apitester.toolbar.environment')}
          value={state.activeEnvId ?? ''}
          onChange={(event) => patchState((current) => ({ ...current, activeEnvId: event.target.value || null }))}
          className="h-8 w-36 text-[length:var(--text-12)]"
        >
          <option value="">{t('development.apitester.toolbar.no_environment')}</option>
          {state.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>{environment.name}</option>
          ))}
        </Select>
      )}
      {activeEnvironment && !compact && (
        <span className="hidden min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] xl:inline">
          {activeEnvironment.name}
        </span>
      )}
      <div className="flex-1" />
      <span className="hidden shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] text-[var(--text-tertiary)] sm:inline">
        {t('development.apitester.app.relay')}
      </span>
      {saving && <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('development.apitester.app.saving')}</span>}
      {conflict && <span className="shrink-0 text-[length:var(--text-10-5)] text-[var(--warning)]">{t('development.apitester.app.unsaved')}</span>}
      {!compact && (
        <Tooltip label={state.settings.splitDirection === 'vertical' ? t('development.apitester.toolbar.split_horizontal') : t('development.apitester.toolbar.split_vertical')}>
          <IconButton
            label={state.settings.splitDirection === 'vertical' ? t('development.apitester.toolbar.split_horizontal') : t('development.apitester.toolbar.split_vertical')}
            size="sm"
            onClick={() => patchSettings({ splitDirection: state.settings.splitDirection === 'vertical' ? 'horizontal' : 'vertical' })}
          >
            {state.settings.splitDirection === 'vertical' ? <Columns2 size={16} /> : <Rows2 size={16} />}
          </IconButton>
        </Tooltip>
      )}
      <button
        ref={settingsRef}
        type="button"
        aria-label={t('development.apitester.toolbar.settings')}
        aria-haspopup="menu"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((open) => !open)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      >
        <Settings2 size={16} />
      </button>
      <Menu
        anchor={workspaceRef}
        open={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        items={workspaceItems}
        align="start"
        width={220}
        label={t('development.apitester.toolbar.workspace')}
      />
      <Menu
        anchor={settingsRef}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        items={settingsItems}
        align="end"
        width={250}
        label={t('development.apitester.toolbar.settings')}
      />
    </header>
  )
}
