/**
 * One xterm instance per terminal tab, wired to the transport through callbacks.
 *
 * The hook owns everything that has to outlive React renders (the terminal, the fit addon and the
 * resize observer) and hands back a small imperative surface; the pane owns the buttons and dialogs.
 * Terminal-local shortcuts are mapped in `shortcuts.ts` so the help dialog and the handler share one
 * definition.
 */
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef, type RefObject } from 'react'
import { useEvent } from '../../lib/hooks'
import { terminalShortcutAction } from './shortcuts'

export interface XtermOptions {
  theme: ITheme
  fontSize: number
  cursorBlink: boolean
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  onSelectionChange: (hasSelection: boolean) => void
  onCopyRequest: () => void
  onPasteRequest: () => void
  onClearRequest: () => void
  /** Absent in a replay surface, where the browser's own find should keep the keystroke. */
  onSearchRequest?: () => void
  onFullscreenRequest?: () => void
  onSearchResults?: (event: ISearchResultChangeEvent) => void
  onReady?: () => void
}

export interface XtermController {
  write: (data: string) => void
  focus: () => void
  fit: () => void
  clear: () => void
  getSelection: () => string
  selectAll: () => void
  clearSelection: () => void
  paste: (text: string) => void
  input: (data: string) => void
  findNext: (term: string, options: ISearchOptions) => boolean
  findPrevious: (term: string, options: ISearchOptions) => boolean
  clearSearch: () => void
  dimensions: () => { cols: number; rows: number }
  /** The last `maxLines` of scrollback as plain text, for the AI panel's context. */
  getTranscript: (maxLines?: number) => string
  /** The line under the cursor, prompt included; the caller strips the prompt. */
  getCurrentLine: () => string
  /** True while a full-screen program (vim, less, top) owns the alternate buffer. */
  isAlternateScreen: () => boolean
}

function monoFontFamily(): string {
  if (typeof document === 'undefined') return 'monospace'
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return value || 'monospace'
}

export function useXterm(containerRef: RefObject<HTMLDivElement | null>, options: XtermOptions): XtermController {
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)

  const onInput = useEvent(options.onInput)
  const onResize = useEvent(options.onResize)
  const onSelectionChange = useEvent(options.onSelectionChange)
  const onCopyRequest = useEvent(options.onCopyRequest)
  const onPasteRequest = useEvent(options.onPasteRequest)
  const onClearRequest = useEvent(options.onClearRequest)
  const onSearchRequest = useEvent(options.onSearchRequest ?? (() => {}))
  const onFullscreenRequest = useEvent(options.onFullscreenRequest ?? (() => {}))
  const onSearchResults = useEvent(options.onSearchResults ?? (() => {}))
  const onReady = useEvent(options.onReady ?? (() => {}))

  const initialOptions = useRef(options)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      // Search highlighting paints through xterm's decoration API, which is still an experimental
      // surface: without this flag `registerDecoration` throws and the search bar takes the app down.
      allowProposedApi: true,
      cursorBlink: initialOptions.current.cursorBlink,
      convertEol: false,
      fontFamily: monoFontFamily(),
      fontSize: initialOptions.current.fontSize,
      lineHeight: 1.25,
      rightClickSelectsWord: true,
      screenReaderMode: true,
      scrollback: 5000,
      theme: initialOptions.current.theme,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    const searchAddon = new SearchAddon({ highlightLimit: 500 })
    terminal.loadAddon(searchAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    const fit = () => {
      // A hidden tab has no box to fit; the observer calls again when it is shown.
      if (!container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fitAddon.fit()
      } catch (error) {
        // The renderer can be mid-teardown when a hidden panel is disposed; the next resize refits.
        console.warn('[inkstone] webssh fit skipped', error)
      }
    }

    const dataSubscription = terminal.onData((data) => onInput(data))
    const resizeSubscription = terminal.onResize(({ cols, rows }) => onResize(cols, rows))
    const selectionSubscription = terminal.onSelectionChange(() => onSelectionChange(terminal.hasSelection()))
    const resultsSubscription = searchAddon.onDidChangeResults((event) => onSearchResults(event))

    terminal.attachCustomKeyEventHandler((event) => {
      const action = terminalShortcutAction(event)
      if (!action) return true
      if (action === 'search' && !initialOptions.current.onSearchRequest) return true
      if (action === 'fullscreen' && !initialOptions.current.onFullscreenRequest) return true
      event.preventDefault()
      if (action === 'copy') onCopyRequest()
      else if (action === 'paste') onPasteRequest()
      else if (action === 'search') onSearchRequest()
      else if (action === 'fullscreen') onFullscreenRequest()
      else onClearRequest()
      return false
    })

    const observer = new ResizeObserver(() => fit())
    observer.observe(container)
    const frame = requestAnimationFrame(() => {
      fit()
      terminal.focus()
      onReady()
    })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      resultsSubscription.dispose()
      selectionSubscription.dispose()
      resizeSubscription.dispose()
      dataSubscription.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      searchAddonRef.current = null
    }
  }, [containerRef, onClearRequest, onCopyRequest, onFullscreenRequest, onInput, onPasteRequest, onReady, onResize, onSearchRequest, onSearchResults, onSelectionChange])

  // Theme and type are options, not a new terminal: changing them keeps scrollback and selection.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = options.theme
    terminal.options.fontSize = options.fontSize
    terminal.options.cursorBlink = options.cursorBlink
    requestAnimationFrame(() => fitAddonRef.current?.fit())
  }, [options.theme, options.fontSize, options.cursorBlink])

  const controller = useRef<XtermController>({
    write: (data) => terminalRef.current?.write(data),
    focus: () => terminalRef.current?.focus(),
    fit: () => {
      const container = containerRef.current
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fitAddonRef.current?.fit()
      } catch (error) {
        console.warn('[inkstone] webssh fit skipped', error)
      }
    },
    clear: () => terminalRef.current?.clear(),
    getSelection: () => terminalRef.current?.getSelection() ?? '',
    selectAll: () => terminalRef.current?.selectAll(),
    clearSelection: () => terminalRef.current?.clearSelection(),
    paste: (text) => terminalRef.current?.paste(text),
    input: (data) => terminalRef.current?.input(data),
    findNext: (term, searchOptions) => {
      if (!term) {
        searchAddonRef.current?.clearDecorations()
        return false
      }
      return searchAddonRef.current?.findNext(term, searchOptions) ?? false
    },
    findPrevious: (term, searchOptions) => {
      if (!term) {
        searchAddonRef.current?.clearDecorations()
        return false
      }
      return searchAddonRef.current?.findPrevious(term, searchOptions) ?? false
    },
    clearSearch: () => searchAddonRef.current?.clearDecorations(),
    dimensions: () => ({
      cols: terminalRef.current?.cols ?? 80,
      rows: terminalRef.current?.rows ?? 24,
    }),
    getTranscript: (maxLines = 1200) => {
      const terminal = terminalRef.current
      if (!terminal) return ''
      const buffer = terminal.buffer.active
      const start = Math.max(0, buffer.length - Math.max(1, maxLines))
      const lines: string[] = []
      for (let index = start; index < buffer.length; index += 1) {
        const line = buffer.getLine(index)
        if (!line) continue
        lines.push(line.translateToString(true))
      }
      return lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trimEnd()
    },
    getCurrentLine: () => {
      const terminal = terminalRef.current
      if (!terminal) return ''
      const buffer = terminal.buffer.active
      const line = buffer.getLine(buffer.baseY + buffer.cursorY)
      return line?.translateToString(true) ?? ''
    },
    isAlternateScreen: () => terminalRef.current?.buffer.active.type === 'alternate',
  })
  return controller.current
}
