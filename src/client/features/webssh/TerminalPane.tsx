/**
 * One tab's terminal, its connection banner and its controls.
 *
 * The transport is created by the factory the workspace passes in, and the status surface never
 * claims more than the transport reports: only the server's `ready` frame lets the pane call a
 * session connected.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search'
import {
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Eraser,
  Keyboard,
  Maximize2,
  Minimize2,
  Power,
  RefreshCw,
  Search,
  WifiOff,
} from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { copyText } from '../../lib/clipboard'
import { useMediaQuery } from '../../lib/hooks'
import { useUi } from '../../store/ui'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Tooltip, useEscape, useLockScroll } from '../../components/overlay'
import { MobileKeyBar } from './MobileKeyBar'
import type { WebsshAppearance } from './appearance'
import { resolveTerminalTheme } from './terminal-themes'
import { TerminalSearchBar } from './TerminalSearchBar'
import type { TerminalSettings } from './prefs'
import type { TerminalTransportFactory } from './transport/types'
import { MAX_RECONNECT_ATTEMPTS } from './session-retry'
import { useTerminalSession, type TerminalSessionPhase } from './use-terminal-session'
import { useXterm, type XtermController } from './use-xterm'
import { parseOsc7Path, resolveCdCommand } from './use-terminal-cwd'

export interface TerminalPaneSession {
  id: string
  title: string
}

/** What the workspace can ask a tab to do: insert text, run text, and whether the tab can run it. */
export interface TerminalPaneController {
  insert: (text: string) => boolean
  send: (text: string) => boolean
  isOpen: () => boolean
}

const SEARCH_DECORATIONS_DARK = {
  matchBackground: '#3a2f28',
  matchBorder: '#6b5749',
  matchOverviewRuler: '#e0664a',
  activeMatchBackground: '#e0664a',
  activeMatchBorder: '#f08a78',
  activeMatchColorOverviewRuler: '#e0664a',
}

const SEARCH_DECORATIONS_LIGHT = {
  matchBackground: '#f3e2d9',
  matchBorder: '#d8b9a8',
  matchOverviewRuler: '#bb4430',
  activeMatchBackground: '#bb4430',
  activeMatchBorder: '#a33327',
  activeMatchColorOverviewRuler: '#bb4430',
}

const PHASE_TONE: Record<TerminalSessionPhase, string> = {
  connecting: 'text-[var(--warning)]',
  open: 'text-[var(--success)]',
  reconnecting: 'text-[var(--warning)]',
  closed: 'text-[var(--text-tertiary)]',
  failed: 'text-[var(--danger)]',
}

const PHASE_DOT: Record<TerminalSessionPhase, string> = {
  connecting: 'bg-[var(--warning)]',
  open: 'bg-[var(--success)]',
  reconnecting: 'bg-[var(--warning)]',
  closed: 'bg-[var(--text-quaternary)]',
  failed: 'bg-[var(--danger)]',
}

export function TerminalPane({
  session,
  active,
  settings,
  appearance,
  isDark,
  createTransport,
  panelId,
  homePath,
  onPhaseChange,
  onSessionId,
  onCwd,
  onController,
  insertRequest,
}: {
  session: TerminalPaneSession
  active: boolean
  settings: TerminalSettings
  appearance: WebsshAppearance
  isDark: boolean
  createTransport: TerminalTransportFactory
  panelId: string
  homePath: string
  onPhaseChange?: (id: string, phase: TerminalSessionPhase) => void
  onSessionId?: (sessionId: string) => void
  onCwd?: (path: string) => void
  onController?: (id: string, controller: TerminalPaneController | null) => void
  /** A snippet the workspace asked to type into this tab; `token` makes repeats distinguishable. */
  insertRequest?: { text: string; token: number } | null
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const writeRef = useRef<(data: string) => void>(() => {})
  const apiRef = useRef<XtermController | null>(null)
  const insertTokenRef = useRef(0)
  const cwdRef = useRef(homePath)
  const commandRef = useRef('')
  const hintId = useId()
  const [hasSelection, setHasSelection] = useState(false)
  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 })
  const [keysOverride, setKeysOverride] = useState<boolean | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false)
  const [searchRegex, setSearchRegex] = useState(false)
  const [searchResults, setSearchResults] = useState({ resultIndex: -1, resultCount: 0 })

  const coarsePointer = useMediaQuery('(pointer: coarse)')
  const narrow = useMediaQuery('(max-width: 767px)')
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const showKeys = keysOverride ?? (coarsePointer || narrow)

  useEscape(fullscreen, () => setFullscreen(false))
  useLockScroll(fullscreen)

  const theme = useMemo(
    () => resolveTerminalTheme(settings.theme, isDark, appearance.terminalColors, appearance.surfaceOpacity),
    [settings.theme, isDark, appearance.terminalColors, appearance.surfaceOpacity],
  )

  const connection = useTerminalSession({
    createTransport,
    initialCols: dimensions.cols,
    initialRows: dimensions.rows,
    onOutput: (data) => {
      const oscPath = parseOsc7Path(data)
      if (oscPath) {
        cwdRef.current = oscPath
        onCwd?.(oscPath)
      }
      writeRef.current(data)
    },
    onSessionId,
  })

  const trackCommand = (data: string) => {
    for (const character of data) {
      if (character === '\r' || character === '\n') {
        const line = commandRef.current
        commandRef.current = ''
        const nextPath = resolveCdCommand(line, cwdRef.current, homePath)
        if (nextPath) {
          cwdRef.current = nextPath
          onCwd?.(nextPath)
        }
        continue
      }
      if (character === '\x7f') {
        commandRef.current = commandRef.current.slice(0, -1)
        continue
      }
      if (character === '\x03' || character === '\x15') {
        commandRef.current = ''
        continue
      }
      if (character < ' ') continue
      if (commandRef.current.length < 4096) commandRef.current += character
    }
    connection.send(data)
  }

  const toast = (title: string, tone: 'success' | 'warning' | 'danger' = 'success') => {
    useUi.getState().toast({ title, tone })
  }

  const copySelection = () => {
    const api = apiRef.current
    const text = api?.getSelection() ?? ''
    if (!text) {
      toast(t('webssh.toast.copy_empty'), 'warning')
      return
    }
    void copyText(text).then((ok) => {
      toast(ok ? t('webssh.toast.copied') : t('webssh.toast.copy_failed'), ok ? 'success' : 'danger')
    })
  }

  const copyAll = () => {
    const api = apiRef.current
    if (!api) return
    api.selectAll()
    const text = api.getSelection()
    api.clearSelection()
    if (!text) {
      toast(t('webssh.toast.copy_empty'), 'warning')
      return
    }
    void copyText(text).then((ok) => {
      toast(ok ? t('webssh.toast.copied') : t('webssh.toast.copy_failed'), ok ? 'success' : 'danger')
    })
  }

  const pasteFromClipboard = () => {
    const api = apiRef.current
    if (!api) return
    const clipboard = navigator.clipboard
    if (!clipboard?.readText) {
      toast(t('webssh.toast.paste_failed'), 'danger')
      return
    }
    void clipboard.readText().then(
      (text) => {
        if (!text) {
          toast(t('webssh.toast.paste_empty'), 'warning')
          return
        }
        api.paste(text)
        api.focus()
      },
      () => toast(t('webssh.toast.paste_failed'), 'danger'),
    )
  }

  const clearTerminal = () => {
    apiRef.current?.clear()
    apiRef.current?.focus()
  }

  const searchOptions = (): ISearchOptions => ({
    caseSensitive: searchCaseSensitive,
    regex: searchRegex,
    incremental: true,
    decorations: isDark ? SEARCH_DECORATIONS_DARK : SEARCH_DECORATIONS_LIGHT,
  })

  const find = (direction: 'next' | 'previous') => {
    if (!searchTerm) {
      apiRef.current?.clearSearch()
      setSearchResults({ resultIndex: -1, resultCount: 0 })
      return
    }
    if (direction === 'next') apiRef.current?.findNext(searchTerm, searchOptions())
    else apiRef.current?.findPrevious(searchTerm, searchOptions())
  }

  const closeSearch = () => {
    setSearchOpen(false)
    setSearchResults({ resultIndex: -1, resultCount: 0 })
    apiRef.current?.clearSearch()
    apiRef.current?.focus()
  }

  const sendText = (text: string): boolean => {
    if (connection.phase !== 'open') return false
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    if (!normalized.trim()) return false
    connection.send(normalized.split('\n').join('\r') + '\r')
    apiRef.current?.focus()
    return true
  }

  const insertText = (text: string): boolean => {
    if (!text) return false
    apiRef.current?.paste(text.replace(/\r?\n$/, ''))
    apiRef.current?.focus()
    return true
  }

  const paneController = useMemo<TerminalPaneController>(
    () => ({
      insert: insertText,
      send: sendText,
      isOpen: () => connection.phase === 'open',
    }),
    [connection.phase, connection.send],
  )

  const xterm = useXterm(containerRef, {
    theme,
    fontSize: settings.fontSize,
    cursorBlink: !reducedMotion,
    onInput: trackCommand,
    onResize: (cols, rows) => {
      setDimensions({ cols, rows })
      connection.resize(cols, rows)
    },
    onSelectionChange: setHasSelection,
    onCopyRequest: copySelection,
    onPasteRequest: pasteFromClipboard,
    onClearRequest: clearTerminal,
    onSearchRequest: () => setSearchOpen(true),
    onFullscreenRequest: () => setFullscreen((value) => !value),
    onSearchResults: (event: ISearchResultChangeEvent) => setSearchResults(event),
  })
  writeRef.current = xterm.write
  apiRef.current = xterm

  const notifyPhase = onPhaseChange
  useEffect(() => {
    notifyPhase?.(session.id, connection.phase)
  }, [notifyPhase, session.id, connection.phase])

  useEffect(() => {
    if (!onController) return
    onController(session.id, paneController)
    return () => onController(session.id, null)
  }, [onController, paneController, session.id])

  useEffect(() => {
    if (!searchOpen || !searchTerm) return
    // A fresh search each edit: the addon keeps its own cursor, and after an option change (case or
    // regex) an incremental search from the old cursor can keep answering "no match" for a term that
    // is there. Clearing first makes the first match the answer again.
    apiRef.current?.clearSearch()
    apiRef.current?.findNext(searchTerm, {
      caseSensitive: searchCaseSensitive,
      regex: searchRegex,
      incremental: true,
      decorations: isDark ? SEARCH_DECORATIONS_DARK : SEARCH_DECORATIONS_LIGHT,
    })
  }, [searchOpen, searchTerm, searchCaseSensitive, searchRegex, isDark])

  useEffect(() => {
    if (!fullscreen) return
    const frame = requestAnimationFrame(() => {
      apiRef.current?.fit()
      apiRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [fullscreen])

  useEffect(() => {
    if (!active) setFullscreen(false)
  }, [active])

  /**
   * Pasting keeps a snippet from running on arrival: a trailing newline is dropped and xterm's
   * bracketed-paste path leaves the command at the prompt for the user to submit.
   */
  useEffect(() => {
    if (!active || !insertRequest || insertRequest.token === insertTokenRef.current) return
    insertTokenRef.current = insertRequest.token
    apiRef.current?.paste(insertRequest.text.replace(/\r?\n$/, ''))
    apiRef.current?.focus()
  }, [active, insertRequest])

  const phaseLabel = () => {
    if (connection.phase === 'open') return t('webssh.status.connected')
    if (connection.phase === 'connecting') return t('webssh.status.connecting')
    if (connection.phase === 'reconnecting') {
      return t('webssh.status.reconnecting', { attempt: connection.attempt, max: MAX_RECONNECT_ATTEMPTS })
    }
    if (connection.phase === 'failed') return t('webssh.status.failed')
    return connection.manual ? t('webssh.status.closed_by_user') : t('webssh.status.disconnected')
  }

  const banner = () => {
    if (connection.phase === 'open') return null
    if (connection.phase === 'connecting') {
      return (
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-3 py-2">
          <Spinner size={13} />
          <span className="text-[length:var(--text-12)] text-[var(--text-secondary)]">{t('webssh.banner.connecting')}</span>
        </div>
      )
    }
    const reconnecting = connection.phase === 'reconnecting'
    const failed = connection.phase === 'failed'
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2',
          failed ? 'border-[var(--danger)]/30 bg-[var(--danger-soft)]' : 'border-[var(--warning)]/30 bg-[var(--warning-softer)]',
        )}
      >
        <WifiOff size={14} aria-hidden="true" className={failed ? 'text-[var(--danger)]' : 'text-[var(--warning)]'} />
        <span className="min-w-0 flex-1 text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {reconnecting
            ? t('webssh.banner.reconnecting', { attempt: connection.attempt, max: MAX_RECONNECT_ATTEMPTS })
            : failed
              ? t('webssh.banner.failed', { reason: connection.error ?? t('webssh.banner.unknown_reason') })
              : connection.manual
                ? t('webssh.banner.closed_by_user')
                : t('webssh.banner.disconnected')}
        </span>
        <Button size="sm" variant="secondary" onClick={() => connection.reconnectNow()}>
          {t('webssh.banner.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div
      role={fullscreen ? 'dialog' : 'tabpanel'}
      id={`${panelId}-panel-${session.id}`}
      aria-modal={fullscreen || undefined}
      aria-label={fullscreen ? t('webssh.fullscreen.label', { name: session.title }) : undefined}
      aria-labelledby={fullscreen ? undefined : `${panelId}-tab-${session.id}`}
      aria-hidden={!active}
      className={cn(
        'flex min-h-0 flex-col',
        fullscreen
          ? 'fixed inset-0 z-[var(--z-top)] bg-[var(--bg-base)]'
          : cn('absolute inset-0', appearance.background ? 'bg-transparent' : 'bg-[var(--bg-editor)]'),
        active || fullscreen ? 'visible' : 'pointer-events-none invisible',
        !fullscreen && active && 'z-10',
      )}
    >
      {banner()}
      <TerminalSearchBar
        open={searchOpen}
        term={searchTerm}
        caseSensitive={searchCaseSensitive}
        regex={searchRegex}
        resultIndex={searchResults.resultIndex}
        resultCount={searchResults.resultCount}
        onTermChange={setSearchTerm}
        onCaseSensitiveChange={setSearchCaseSensitive}
        onRegexChange={setSearchRegex}
        onNext={() => find('next')}
        onPrevious={() => find('previous')}
        onClose={closeSearch}
      />
      <div className="webssh-terminal-host relative min-h-0 flex-1 overflow-hidden" onClick={() => apiRef.current?.focus()}>
        <div
          ref={containerRef}
          role="region"
          aria-label={t('webssh.terminal.label', { name: session.title })}
          aria-describedby={hintId}
          className="webssh-terminal h-full w-full px-2 py-1"
        />
      </div>
      <p id={hintId} className="sr-only">
        {t('webssh.terminal.hint')}
      </p>
      {showKeys && (
        <MobileKeyBar disabled={connection.phase !== 'open'} onKey={(data) => apiRef.current?.input(data)} />
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2 py-1">
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={cn('inline-flex min-w-0 items-center gap-1.5 text-[length:var(--text-11-5)] font-medium', PHASE_TONE[connection.phase])}
        >
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', PHASE_DOT[connection.phase])} />
          <span className="truncate">{phaseLabel()}</span>
        </span>
        <span className="min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{session.title}</span>
        <span className="tabular text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('webssh.status.size_value', { cols: dimensions.cols, rows: dimensions.rows })}
        </span>
        <div className="ms-auto flex items-center gap-0.5">
          <Tooltip label={t('webssh.action.search')} combo="mod+f">
            <IconButton label={t('webssh.action.search')} size="sm" active={searchOpen} onClick={() => setSearchOpen(true)}>
              <Search size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('webssh.action.copy')} combo="mod+shift+c">
            <IconButton label={t('webssh.action.copy')} size="sm" onClick={copySelection} disabled={!hasSelection}>
              <Copy size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('webssh.action.copy_all')}>
            <IconButton label={t('webssh.action.copy_all')} size="sm" onClick={copyAll}>
              <ClipboardCopy size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('webssh.action.paste')} combo="mod+shift+v">
            <IconButton label={t('webssh.action.paste')} size="sm" onClick={pasteFromClipboard} disabled={connection.phase !== 'open'}>
              <ClipboardPaste size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('webssh.action.clear')} combo="mod+shift+k">
            <IconButton label={t('webssh.action.clear')} size="sm" onClick={clearTerminal}>
              <Eraser size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={t('webssh.action.keyboard')}>
            <IconButton
              label={t('webssh.action.keyboard')}
              size="sm"
              active={showKeys}
              onClick={() => setKeysOverride(!showKeys)}
            >
              <Keyboard size={14} aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip
            label={fullscreen ? t('webssh.action.exit_fullscreen') : t('webssh.action.fullscreen')}
            combo="mod+shift+f"
          >
            <IconButton
              label={fullscreen ? t('webssh.action.exit_fullscreen') : t('webssh.action.fullscreen')}
              size="sm"
              active={fullscreen}
              onClick={() => setFullscreen((value) => !value)}
            >
              {fullscreen ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            </IconButton>
          </Tooltip>
          {connection.phase === 'open' && (
            <Tooltip label={t('webssh.action.disconnect')}>
              <IconButton label={t('webssh.action.disconnect')} size="sm" onClick={() => connection.disconnect()}>
                <Power size={14} aria-hidden="true" />
              </IconButton>
            </Tooltip>
          )}
          {(connection.phase === 'closed' || connection.phase === 'failed') && (
            <Tooltip label={t('webssh.action.reconnect')}>
              <IconButton label={t('webssh.action.reconnect')} size="sm" onClick={() => connection.reconnectNow()}>
                <RefreshCw size={14} aria-hidden="true" />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}
