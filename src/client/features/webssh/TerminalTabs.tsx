/**
 * The session strip. A terminal tab carries a close control beside it, so the tab itself stays one
 * button and the row keeps a single tab stop, while arrow keys move the selection the way `Tabs`
 * does. The status dot repeats the connection phase without relying on colour alone: the dot's
 * tooltip and the status bar both say the phase in words.
 */
import { useRef } from 'react'
import { Plus, Settings2, Keyboard, X, FolderOpen, History, ScrollText, Sparkles, Video } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import type { TerminalSessionPhase } from './use-terminal-session'

export interface TerminalTabView {
  id: string
  title: string
}

const DOT_TONE: Record<TerminalSessionPhase, string> = {
  connecting: 'bg-[var(--warning)]',
  open: 'bg-[var(--success)]',
  reconnecting: 'bg-[var(--warning)]',
  closed: 'bg-[var(--text-quaternary)]',
  failed: 'bg-[var(--danger)]',
}

const DOT_LABEL: Record<TerminalSessionPhase, 'webssh.status.connecting' | 'webssh.status.connected' | 'webssh.status.reconnecting' | 'webssh.status.disconnected' | 'webssh.status.failed'> = {
  connecting: 'webssh.status.connecting',
  open: 'webssh.status.connected',
  reconnecting: 'webssh.status.reconnecting',
  closed: 'webssh.status.disconnected',
  failed: 'webssh.status.failed',
}

export function TerminalTabs({
  tabs,
  activeId,
  statuses,
  onSelect,
  onClose,
  onNew,
  onOpenShortcuts,
  onOpenSettings,
  onOpenFiles,
  filesOpen = false,
  filesDisabled = false,
  onOpenAi,
  aiOpen = false,
  aiDisabled = false,
  onOpenSnippets,
  snippetsDisabled = false,
  onOpenReplay,
  replayDisabled = false,
  onOpenRecordingSettings,
  panelId,
}: {
  tabs: readonly TerminalTabView[]
  activeId: string | null
  statuses: Readonly<Record<string, TerminalSessionPhase>>
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onOpenShortcuts: () => void
  onOpenSettings: () => void
  onOpenFiles?: () => void
  filesOpen?: boolean
  filesDisabled?: boolean
  onOpenAi?: () => void
  aiOpen?: boolean
  aiDisabled?: boolean
  onOpenSnippets?: () => void
  snippetsDisabled?: boolean
  onOpenReplay?: () => void
  replayDisabled?: boolean
  onOpenRecordingSettings?: () => void
  panelId: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const focusTab = (index: number) => {
    const clamped = Math.max(0, Math.min(tabs.length - 1, index))
    const tab = tabs[clamped]
    if (!tab) return
    refs.current[clamped]?.focus()
    onSelect(tab.id)
  }

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1.5">
      <div
        role="tablist"
        aria-label={t('webssh.tabs.label')}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        onKeyDown={(event) => {
          const current = tabs.findIndex((tab) => tab.id === activeId)
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            focusTab(current + 1)
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault()
            focusTab(current - 1)
          } else if (event.key === 'Home') {
            event.preventDefault()
            focusTab(0)
          } else if (event.key === 'End') {
            event.preventDefault()
            focusTab(tabs.length - 1)
          }
        }}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const phase = statuses[tab.id] ?? 'connecting'
          return (
            <div
              key={tab.id}
              className={cn(
                'flex shrink-0 items-center rounded-[var(--r-sm)] border',
                active
                  ? 'border-[var(--border-default)] bg-[var(--bg-surface)]'
                  : 'border-transparent hover:bg-[var(--bg-hover)]',
              )}
            >
              <button
                ref={(element) => {
                  refs.current[index] = element
                }}
                type="button"
                role="tab"
                id={`${panelId}-tab-${tab.id}`}
                aria-selected={active}
                aria-controls={`${panelId}-panel-${tab.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                className={cn(
                  'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-l-[var(--r-sm)] pl-2 pr-1 text-[length:var(--text-12)]',
                  active ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                )}
              >
                <Tooltip label={t(DOT_LABEL[phase])}>
                  <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', DOT_TONE[phase])} />
                </Tooltip>
                <span className="max-w-[120px] truncate">{tab.title}</span>
              </button>
              <IconButton
                label={t('webssh.tabs.close', { name: tab.title })}
                size="xs"
                onClick={() => onClose(tab.id)}
                className="mr-0.5 rounded-full"
              >
                <X size={12} aria-hidden="true" />
              </IconButton>
            </div>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip label={t('webssh.tabs.new')}>
          <IconButton label={t('webssh.tabs.new')} size="sm" onClick={onNew}>
            <Plus size={15} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        {onOpenFiles && (
          <Tooltip label={t('webssh.sftp.open')}>
            <IconButton label={t('webssh.sftp.open')} size="sm" active={filesOpen} disabled={filesDisabled} onClick={onOpenFiles}>
              <FolderOpen size={15} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )}
        {onOpenAi && (
          <Tooltip label={t('webssh.ai.open')}>
            <IconButton label={t('webssh.ai.open')} size="sm" active={aiOpen} disabled={aiDisabled} onClick={onOpenAi}>
              <Sparkles size={15} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )}
        {onOpenSnippets && (
          <Tooltip label={t('webssh.snippet.open')}>
            <IconButton label={t('webssh.snippet.open')} size="sm" disabled={snippetsDisabled} onClick={onOpenSnippets}>
              <ScrollText size={15} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )}
        {onOpenReplay && (
          <Tooltip label={t('webssh.replay.open')}>
            <IconButton label={t('webssh.replay.open')} size="sm" disabled={replayDisabled} onClick={onOpenReplay}>
              <History size={15} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )}
        {onOpenRecordingSettings && (
          <Tooltip label={t('webssh.recording.open')}>
            <IconButton label={t('webssh.recording.open')} size="sm" onClick={onOpenRecordingSettings}>
              <Video size={15} aria-hidden="true" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip label={t('webssh.action.shortcuts')}>
          <IconButton label={t('webssh.action.shortcuts')} size="sm" onClick={onOpenShortcuts}>
            <Keyboard size={15} aria-hidden="true" />
          </IconButton>
        </Tooltip>
        <Tooltip label={t('webssh.action.settings')}>
          <IconButton label={t('webssh.action.settings')} size="sm" onClick={onOpenSettings}>
            <Settings2 size={15} aria-hidden="true" />
          </IconButton>
        </Tooltip>
      </div>
    </div>
  )
}
