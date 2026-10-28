import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
    ArrowLeft,
    BookmarkPlus,
    Check,
    Circle,
    Copy,
    Eraser,
    ExternalLink,
    Eye,
    Highlighter,
    LassoSelect,
    Paintbrush,
    Pencil,
    FileCode2,
    ImageDown,
    Link2,
    Minus,
    Palette,
    PenLine,
    Redo2,
    Save,
    Square,
    Star,
    Undo2,
    X,
} from 'lucide-react'
import type { NoteSummary } from '@shared/types'
import { Button, IconButton } from '../../components/primitives'
import { Menu, Tooltip, confirm, prompt, useEscape, type MenuItem } from '../../components/overlay'
import { downloadBlob, safeFileName } from '../../lib/export-note'
import { t, useLocale } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { useBreakpoint, useThemeDark } from '../../lib/hooks'
import { INK_BODY_LIMIT_BYTES, inkBodyBytes, parseInkDocumentResult } from '../../lib/inkpad/format'
import { isInkNoteTitle } from '../../lib/inkpad/document'
import { classifyInkLink } from '../../lib/inkpad/link'
import { isMindmapDocumentTitle } from '../../lib/markdown/mindmap/document'
import type { InkTool } from '../../lib/inkpad/types'
import { useNotes } from '../../store/notes'
import { useUi, type WorkspacePane } from '../../store/ui'
import { InkElements } from './ink-elements'
import { InkEngineImpl } from './ink-engine'
import type { InkErrorCode } from './ink-engine-types'
import { InkFilePicker } from './ink-file-picker'
import { InkHud } from './ink-hud'
import { InkToolbar, type InkSaveState } from './ink-toolbar'
import { inkAutoSaveDelayMs, useInkSettingsStore } from './ink-settings-store'
import { NotePicker } from '../notes/NotePicker'

interface Props {
    note: NoteSummary
    content: string
    onChange: (next: string) => void
    onTitleChange?: (title: string) => void
    onMobileBack?: () => void
    pane?: WorkspacePane | 'active'
    grouped?: boolean
}

const WIDTH = 3

function resolveCssColorToHex(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return null
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    try {
        context.fillStyle = '#010203'
        context.fillStyle = trimmed
        if (context.fillStyle === '#010203') return null
        context.fillRect(0, 0, 1, 1)
        const data = context.getImageData(0, 0, 1, 1).data
        return `#${[data[0], data[1], data[2]].map((channel) => (channel ?? 0).toString(16).padStart(2, '0')).join('')}`
    } catch {
        return null
    }
}

function initialColor(defaultColor: string, dark: boolean, canvasBackground: 'theme' | 'dark'): { color: string; auto: boolean } {
    if (defaultColor !== 'auto') return { color: defaultColor, auto: false }
    if (canvasBackground === 'dark') return { color: '#ffffff', auto: true }
    const resolved = resolveCssColorToHex(getComputedStyle(document.documentElement).getPropertyValue('--text-primary'))
    return { color: resolved ?? (dark ? '#ffffff' : '#111827'), auto: true }
}

export function InkNoteEditor({ note, content, onChange, onTitleChange, onMobileBack, pane = 'active' }: Props) {
    const isMobile = useBreakpoint() === 'mobile'
    const locale = useLocale()
    const dark = useThemeDark()
    const toast = useUi((state) => state.toast)
    const closeSecondaryNote = useUi((state) => state.closeSecondaryNote)
    const patchNote = useNotes((state) => state.patchNote)
    const settings = useInkSettingsStore()
    const initial = useMemo(() => initialColor(settings.defaultColor, dark, settings.canvasBackground), [])
    const [viewMode, setViewMode] = useState<'ink' | 'code'>(() => {
        const parsed = parseInkDocumentResult(content)
        return parsed.ok ? 'ink' : 'code'
    })
    const [rawCode, setRawCode] = useState(content)
    const [codeError, setCodeError] = useState<'invalid' | 'too_large' | null>(() => {
        const parsed = parseInkDocumentResult(content)
        return parsed.ok ? null : parsed.reason
    })
    const [ready, setReady] = useState(false)
    const [fatalError, setFatalError] = useState(false)
    const [tool, setTool] = useState<InkTool>('pen')
    const [color, setColor] = useState(initial.color)
    const [autoColor, setAutoColor] = useState(initial.auto)
    const [width, setWidth] = useState(WIDTH)
    const [zoom, setZoom] = useState(1)
    const [selectionCount, setSelectionCount] = useState(0)
    const [hasLink, setHasLink] = useState(false)
    const [elementsVersion, setElementsVersion] = useState(0)
    const [historyVersion, setHistoryVersion] = useState(0)
    const [saveState, setSaveState] = useState<InkSaveState>('saved')
    const [externalChange, setExternalChange] = useState<string | null>(null)
    const [nearLimit, setNearLimit] = useState(false)
    const [tooLarge, setTooLarge] = useState(false)
    const [focusMode, setFocusMode] = useState(false)
    const [titleDraft, setTitleDraft] = useState(note.title)
    const [insertMenuOpen, setInsertMenuOpen] = useState(false)
    const [exportMenuOpen, setExportMenuOpen] = useState(false)
    const [notePickerOpen, setNotePickerOpen] = useState(false)
    const [filePickerOpen, setFilePickerOpen] = useState(false)
    const [quickMenu, setQuickMenu] = useState<{ x: number; y: number } | null>(null)

    const engineRef = useRef<InkEngineImpl | null>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const surfaceRef = useRef<HTMLDivElement>(null)
    const insertButtonRef = useRef<HTMLSpanElement>(null)
    const exportButtonRef = useRef<HTMLSpanElement>(null)
    const lastWrittenRef = useRef(content)
    const dirtyRef = useRef(false)
    const externalRef = useRef<string | null>(null)
    const contentRef = useRef(content)
    const onChangeRef = useRef(onChange)
    const colorRef = useRef(color)
    const widthRef = useRef(width)
    const saveTimerRef = useRef<number | undefined>(undefined)
    const writeNowRef = useRef<() => boolean>(() => false)

    useEffect(() => { onChangeRef.current = onChange }, [onChange])
    useEffect(() => { contentRef.current = content }, [content])
    useEffect(() => { colorRef.current = color; engineRef.current?.setInk(color, widthRef.current) }, [color])
    useEffect(() => { widthRef.current = width; engineRef.current?.setInk(colorRef.current, width) }, [width])
    useEffect(() => { setTitleDraft(note.title) }, [note.id, note.title])
    useEscape(focusMode, () => setFocusMode(false))

    const writeNow = useCallback((): boolean => {
        const engine = engineRef.current
        if (!engine || externalRef.current) return false
        const serialized = engine.serialize()
        if (serialized === lastWrittenRef.current) {
            dirtyRef.current = false
            setSaveState('saved')
            return true
        }
        const bytes = inkBodyBytes(serialized)
        setNearLimit(bytes > INK_BODY_LIMIT_BYTES * 0.8)
        if (bytes > INK_BODY_LIMIT_BYTES) {
            setTooLarge(true)
            setSaveState('error')
            toast({ title: t('ink.save.too_large'), tone: 'danger' })
            return false
        }
        setTooLarge(false)
        setSaveState('saving')
        lastWrittenRef.current = serialized
        dirtyRef.current = false
        setSaveState('saved')
        onChangeRef.current(serialized)
        return true
    }, [toast])
    writeNowRef.current = writeNow

    const saveSoon = useCallback(() => {
        if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = undefined
            writeNowRef.current()
        }, inkAutoSaveDelayMs(useInkSettingsStore.getState().autoSaveIntervalMs))
    }, [])

    const markDirty = useCallback(() => {
        if (externalRef.current) return
        dirtyRef.current = true
        setSaveState('pending')
        setHistoryVersion((version) => version + 1)
        saveSoon()
    }, [saveSoon])

    const flushSave = useCallback((): boolean => {
        if (saveTimerRef.current !== undefined) {
            window.clearTimeout(saveTimerRef.current)
            saveTimerRef.current = undefined
        }
        return dirtyRef.current ? writeNowRef.current() : true
    }, [])

    const applyContent = useCallback((next: string) => {
        const parsed = parseInkDocumentResult(next)
        if (!parsed.ok) {
            setCodeError(parsed.reason)
            setRawCode(next)
            setSaveState('saved')
            setViewMode('code')
            return
        }
        setCodeError(null)
        engineRef.current?.load(parsed.document)
        lastWrittenRef.current = next
        dirtyRef.current = false
        setSaveState('saved')
        setRawCode(next)
    }, [])

    useEffect(() => {
        if (content === lastWrittenRef.current) {
            if (viewMode === 'code') setRawCode(content)
            return
        }
        if (dirtyRef.current) {
            externalRef.current = content
            setExternalChange(content)
            setSaveState('error')
            if (saveTimerRef.current !== undefined) {
                window.clearTimeout(saveTimerRef.current)
                saveTimerRef.current = undefined
            }
            return
        }
        applyContent(content)
    }, [applyContent, content, viewMode])

    useEffect(() => {
        if (viewMode !== 'ink') return
        const canvas = canvasRef.current
        const surface = surfaceRef.current
        if (!canvas || !surface) return
        const parsed = parseInkDocumentResult(contentRef.current)
        if (!parsed.ok) {
            setCodeError(parsed.reason)
            setViewMode('code')
            return
        }
        const engine = new InkEngineImpl({
            settings: () => {
                const current = useInkSettingsStore.getState()
                return { paperStyle: current.paperStyle, pressureResponse: current.pressureResponse }
            },
            onDirty: markDirty,
            onViewportChange: (next) => setZoom(next),
            onToolChange: (next) => setTool(next),
            onSelectionChange: (count, linked) => { setSelectionCount(count); setHasLink(linked) },
            onElementsChange: () => setElementsVersion((version) => version + 1),
            onQuickMenu: (x, y) => setQuickMenu({ x, y }),
            onError: (code: InkErrorCode) => {
                if (code === 'canvas_unavailable') {
                    setFatalError(true)
                    return
                }
                if (code === 'unsupported_file') toast({ title: t('ink.unsupported_file'), tone: 'warning' })
                else if (code === 'empty_content') toast({ title: t('ink.canvas.empty_frame'), tone: 'warning' })
            },
            openNote: (target) => {
                const notes = useNotes.getState().notes
                const id = notes[target] ? target : Object.values(notes).find((item) => item.title === target)?.id
                if (id) openNoteInPane(id, pane)
                else toast({ title: t('ink.note_not_found', { name: target }), tone: 'warning' })
            },
            openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
        })
        engineRef.current = engine
        engine.mount(canvas, surface)
        engine.load(parsed.document)
        engine.setInk(colorRef.current, widthRef.current)
        setReady(true)
        setZoom(engine.zoom())
        setElementsVersion((version) => version + 1)
        setHistoryVersion((version) => version + 1)
        return () => {
            setReady(false)
            engine.destroy()
            if (engineRef.current === engine) engineRef.current = null
        }
    }, [markDirty, note.id, pane, toast, viewMode])

    useEffect(() => {
        const handle = () => {
            if (saveTimerRef.current !== undefined) {
                window.clearTimeout(saveTimerRef.current)
                saveTimerRef.current = undefined
            }
            if (dirtyRef.current && !externalRef.current) writeNowRef.current()
        }
        window.addEventListener('pagehide', handle)
        return () => {
            window.removeEventListener('pagehide', handle)
            handle()
        }
    }, [])

    useEffect(() => {
        engineRef.current?.refreshAppearance()
    }, [settings.paperStyle, settings.pressureResponse])

    useEffect(() => {
        if (!autoColor) return
        if (settings.canvasBackground === 'dark') {
            setColor('#ffffff')
            return
        }
        const resolved = resolveCssColorToHex(getComputedStyle(document.documentElement).getPropertyValue('--text-primary'))
        setColor(resolved ?? (dark ? '#ffffff' : '#111827'))
    }, [autoColor, dark, settings.canvasBackground])

    useEffect(() => {
        if (!externalChange) return
        const handle = () => {
            if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current)
            saveTimerRef.current = undefined
        }
        handle()
    }, [externalChange])

    const openNoteInPane = (id: string, from: WorkspacePane | 'active') => {
        const adjacent = useInkSettingsStore.getState().openInAdjacentPane
        if (!adjacent) {
            void useNotes.getState().openNote(id)
            return
        }
        const target = from === 'secondary' ? 'primary' : 'secondary'
        void useNotes.getState().openNote(id, { pane: target })
    }

    const commitTitle = () => {
        const next = titleDraft.trim()
        if (!next) {
            setTitleDraft(note.title)
            return
        }
        if (next === note.title) return
        flushSave()
        onTitleChange?.(next)
    }

    const toggleCode = () => {
        if (viewMode === 'ink') {
            flushSave()
            setRawCode(engineRef.current?.serialize() ?? contentRef.current)
            setViewMode('code')
            return
        }
        const parsed = parseInkDocumentResult(rawCode)
        if (!parsed.ok) {
            setCodeError(parsed.reason)
            return
        }
        setCodeError(null)
        contentRef.current = rawCode
        lastWrittenRef.current = rawCode
        setViewMode('ink')
    }

    const sourceChanged = (value: string) => {
        setRawCode(value)
        contentRef.current = value
        const bytes = inkBodyBytes(value)
        setNearLimit(bytes > INK_BODY_LIMIT_BYTES * 0.8)
        if (bytes > INK_BODY_LIMIT_BYTES) {
            setTooLarge(true)
            setSaveState('error')
            return
        }
        setTooLarge(false)
        lastWrittenRef.current = value
        dirtyRef.current = false
        setSaveState('saved')
        onChangeRef.current(value)
    }

    const manualSave = async () => {
        const ok = flushSave()
        await useNotes.getState().flush({ immediate: true })
        toast({ title: ok ? t('ink.save.saved') : t('ink.save.error'), tone: ok ? 'success' : 'danger' })
    }

    const reload = async () => {
        const value = externalRef.current
        if (!value) return
        const agreed = await confirm({ title: t('ink.external.reload'), description: t('ink.external.discard_confirm') })
        if (!agreed) return
        externalRef.current = null
        setExternalChange(null)
        dirtyRef.current = false
        applyContent(value)
    }

    const frame = () => {
        if (!engineRef.current?.frameContent()) toast({ title: t('ink.canvas.empty_frame'), tone: 'warning' })
    }

    const insertText = async () => {
        const value = await prompt({ title: t('ink.action.insert_text') })
        if (value?.trim()) engineRef.current?.insertText(value)
    }

    const addBookmark = async () => {
        const value = await prompt({ title: t('ink.bookmark.name') })
        if (value?.trim()) engineRef.current?.addBookmark(value)
    }

    const downloadSvg = () => {
        try {
            const engine = engineRef.current
            const svg = engine?.exportSvgString()
            if (!svg) {
                toast({ title: t('ink.export.empty'), tone: 'warning' })
                return
            }
            const name = `${safeFileName(note.title.replace(/\.ink$/i, '')) || 'Ink'}-ink.svg`
            downloadBlob(name, new Blob([svg], { type: 'image/svg+xml' }))
            toast({ title: t('ink.export.svg_done', { name }), tone: 'success' })
        } catch {
            toast({ title: t('ink.export.failed'), tone: 'danger' })
        }
    }
    const downloadPng = async () => {
        try {
            const blob = await engineRef.current?.exportPngBlob()
            if (!blob) {
                toast({ title: t('ink.export.empty'), tone: 'warning' })
                return
            }
            const name = `${safeFileName(note.title.replace(/\.ink$/i, '')) || 'Ink'}-ink.png`
            downloadBlob(name, blob)
            toast({ title: t('ink.export.png_done', { name }), tone: 'success' })
        } catch {
            toast({ title: t('ink.export.failed'), tone: 'danger' })
        }
    }
    const downloadSelection = async () => {
        if (!selectionCount) {
            toast({ title: t('ink.export.no_selection'), tone: 'warning' })
            return
        }
        try {
            const blob = await engineRef.current?.exportSelectionPngBlob()
            if (!blob) {
                toast({ title: t('ink.export.no_selection'), tone: 'warning' })
                return
            }
            const name = `${safeFileName(note.title.replace(/\.ink$/i, '')) || 'Ink'}-selection.png`
            downloadBlob(name, blob)
            toast({ title: t('ink.export.selection_done', { name }), tone: 'success' })
        } catch {
            toast({ title: t('ink.export.failed'), tone: 'danger' })
        }
    }

    const linkSelection = async () => {
        const value = await prompt({ title: t('ink.quick.link'), defaultValue: '' })
        if (value === null) return
        if (value.trim() && classifyInkLink(value).kind === 'invalid') {
            toast({ title: t('ink.link.invalid'), tone: 'warning' })
            return
        }
        engineRef.current?.linkSelection(value)
    }

    const quickItems: MenuItem[] = []
    const engine = engineRef.current
    if (engine) {
        quickItems.push(
            { id: 'undo', label: t('ink.quick.undo'), icon: <Undo2 size={14} />, disabled: !engine.canUndo(), onSelect: () => engine.undo() },
            { id: 'redo', label: t('ink.quick.redo'), icon: <Redo2 size={14} />, disabled: !engine.canRedo(), onSelect: () => engine.redo() },
            { id: 'bookmark', label: t('ink.quick.save_position'), icon: <BookmarkPlus size={14} />, separatorBefore: true, onSelect: () => void addBookmark() },
        )
        for (const bookmark of engine.bookmarks()) {
            quickItems.push({ id: `bookmark-${bookmark.id}`, label: bookmark.name, icon: <BookmarkPlus size={14} />, onSelect: () => engine.goToBookmark(bookmark.id) })
        }
        if (selectionCount) {
            quickItems.push(
                { id: 'duplicate', label: t('ink.quick.duplicate'), icon: <Copy size={14} />, separatorBefore: true, onSelect: () => engine.duplicateSelection() },
                { id: 'color', label: t('ink.quick.apply_color'), icon: <Palette size={14} />, onSelect: () => engine.applyColorToSelection() },
                { id: 'link', label: t('ink.quick.link'), icon: <Link2 size={14} />, onSelect: () => void linkSelection() },
                { id: 'export-selection', label: t('ink.quick.export_selection'), icon: <ImageDown size={14} />, onSelect: () => void downloadSelection() },
                { id: 'to-line', label: t('ink.quick.to_line'), icon: <Minus size={14} />, onSelect: () => engine.convertSelection('line') },
                { id: 'to-rectangle', label: t('ink.quick.to_rectangle'), icon: <Square size={14} />, onSelect: () => engine.convertSelection('rectangle') },
                { id: 'to-ellipse', label: t('ink.quick.to_ellipse'), icon: <Circle size={14} />, onSelect: () => engine.convertSelection('ellipse') },
            )
            if (hasLink) quickItems.push({ id: 'open-link', label: t('ink.quick.open_link'), icon: <ExternalLink size={14} />, onSelect: () => engine.openSelectionLink() })
        }
        for (const [toolName, label, icon] of [
            ['pen', t('ink.tool.pen'), <PenLine key="pen" size={14} />],
            ['pencil', t('ink.tool.pencil'), <Pencil key="pencil" size={14} />],
            ['marker', t('ink.tool.marker'), <Paintbrush key="marker" size={14} />],
            ['highlighter', t('ink.tool.highlighter'), <Highlighter key="highlighter" size={14} />],
            ['eraser', t('ink.tool.eraser'), <Eraser key="eraser" size={14} />],
            ['lasso', t('ink.tool.lasso'), <LassoSelect key="lasso" size={14} />],
            ['line', t('ink.tool.line'), <Minus key="line" size={14} />],
            ['arrow', t('ink.tool.arrow'), <ExternalLink key="arrow" size={14} />],
            ['rectangle', t('ink.tool.rectangle'), <Square key="rectangle" size={14} />],
            ['ellipse', t('ink.tool.ellipse'), <Circle key="ellipse" size={14} />],
        ] as Array<[InkTool, string, ReactNode]>) {
            quickItems.push({ id: `tool-${toolName}`, label, icon, checked: tool === toolName, separatorBefore: toolName === 'pen' || toolName === 'line', onSelect: () => engine.setTool(toolName) })
        }
    }

    const insertItems: MenuItem[] = [
        { id: 'insert-note', label: t('ink.action.insert_note'), icon: <FileCode2 size={14} />, onSelect: () => setNotePickerOpen(true) },
        { id: 'insert-file', label: t('ink.action.insert_file'), icon: <ImageDown size={14} />, onSelect: () => setFilePickerOpen(true) },
    ]
    const exportItems: MenuItem[] = [
        { id: 'export-svg', label: t('ink.action.export_svg'), icon: <FileCode2 size={14} />, onSelect: downloadSvg },
        { id: 'export-png', label: t('ink.action.export_png'), icon: <ImageDown size={14} />, onSelect: () => void downloadPng() },
        { id: 'export-selection', label: t('ink.action.export_selection_png'), icon: <ImageDown size={14} />, disabled: selectionCount === 0, onSelect: () => void downloadSelection() },
    ]

    const codeBanner = codeError
        ? <div role="alert" className="border-b border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{codeError === 'too_large' ? t('ink.code.too_large') : t('ink.code.invalid')}</div>
        : null

    return (
        <div className="relative flex h-full min-h-0 w-full flex-col bg-[var(--bg-base)] text-[var(--text-primary)]" data-inkpad-editor data-ink-history-version={historyVersion} data-locale={locale}>
            {!focusMode && (
                <header className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3 select-none">
                    <div className="flex min-w-0 items-center gap-2">
                        {isMobile && onMobileBack && (
                            <IconButton label={t('workspace.back_to_notes')} size="sm" onClick={onMobileBack}>
                                <ArrowLeft size={16} />
                            </IconButton>
                        )}
                        <PenLine size={16} className="shrink-0 text-[var(--accent)]" />
                        <input
                            type="text"
                            value={titleDraft}
                            maxLength={512}
                            aria-label={t('workspace.note_title')}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onBlur={commitTitle}
                            onKeyDown={(event) => {
                                if (isImeComposing(event)) return
                                if (event.key !== 'Enter') return
                                event.preventDefault()
                                commitTitle()
                                event.currentTarget.blur()
                            }}
                            className="min-w-0 max-w-[280px] truncate rounded bg-transparent px-1.5 py-0.5 text-sm font-semibold text-[var(--text-primary)] focus:bg-[var(--bg-surface)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] md:max-w-md"
                        />
                    </div>
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={() => void manualSave()} className="mr-1 inline-flex items-center gap-1 rounded-[var(--r-sm)] px-1.5 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]" aria-label={t('ink.action.save')}>
                            {saveState === 'saved' ? <Check size={13} className="text-[var(--accent)]" /> : <Save size={13} className="text-[var(--warning)]" />}
                            <span className="hidden sm:inline">{saveState === 'saved' ? t('ink.save.saved') : saveState === 'error' ? t('ink.save.error') : saveState === 'saving' ? t('ink.save.saving') : t('ink.save.pending')}</span>
                        </button>
                        <Tooltip label={viewMode === 'ink' ? t('ink.action.open_source') : t('ink.action.open_canvas')}>
                            <IconButton label={viewMode === 'ink' ? t('ink.action.open_source') : t('ink.action.open_canvas')} size="sm" onClick={toggleCode}>
                                {viewMode === 'ink' ? <FileCode2 size={15} /> : <Eye size={15} />}
                            </IconButton>
                        </Tooltip>
                        <Tooltip label={note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')}>
                            <IconButton label={note.isStarred ? t('common.remove_from_favorites') : t('navigation.favorites')} size="sm" active={note.isStarred} onClick={() => void patchNote(note.id, { isStarred: !note.isStarred })}>
                                <Star size={14} className={note.isStarred ? 'fill-current' : undefined} />
                            </IconButton>
                        </Tooltip>
                        {pane === 'secondary' && (
                            <Tooltip label={t('workspace.close_right_note')}>
                                <IconButton label={t('workspace.close_right_note')} size="sm" onClick={closeSecondaryNote}>
                                    <X size={15} />
                                </IconButton>
                            </Tooltip>
                        )}
                    </div>
                </header>
            )}
            {externalChange && (
                <div role="alert" className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">
                    <span>{t('ink.external.message')}</span>
                    <Button size="sm" variant="secondary" onClick={() => void reload()}>{t('ink.external.reload')}</Button>
                </div>
            )}
            {codeBanner}
            {tooLarge && <div role="alert" className="border-b border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-[length:var(--text-12)] text-[var(--danger)]">{t('ink.save.too_large')}</div>}
            {nearLimit && !tooLarge && <div role="status" className="border-b border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-[length:var(--text-11)] text-[var(--warning)]">{t('ink.save.near_limit')}</div>}
            {!focusMode && ready && viewMode === 'ink' && (
                <InkToolbar
                    engine={engine!}
                    tool={tool}
                    saveState={saveState}
                    selectionCount={selectionCount}
                    canUndo={engine?.canUndo() ?? false}
                    canRedo={engine?.canRedo() ?? false}
                    focusMode={focusMode}
                    insertButtonRef={insertButtonRef}
                    exportButtonRef={exportButtonRef}
                    onTool={(next) => engine?.setTool(next)}
                    onSave={() => void manualSave()}
                    onInsertMenu={() => setInsertMenuOpen((open) => !open)}
                    onInsertText={() => void insertText()}
                    onExportMenu={() => setExportMenuOpen((open) => !open)}
                    onFrame={frame}
                    onFocus={() => setFocusMode((value) => !value)}
                />
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
                <div ref={surfaceRef} data-canvas={settings.canvasBackground} className={viewMode === 'code' ? 'hidden' : 'inkpad-surface'}>
                    <canvas
                        ref={canvasRef}
                        className="inkpad-canvas"
                        tabIndex={0}
                        role="application"
                        aria-label={t('ink.canvas.label')}
                        aria-describedby="inkpad-canvas-help"
                    />
                    {ready && (
                        <InkElements
                            engine={engine!}
                            version={elementsVersion}
                            onOpenNote={(id) => openNoteInPane(id, pane)}
                        />
                    )}
                    {ready && (
                        <InkHud
                            engine={engine!}
                            zoom={zoom}
                            saveState={saveState}
                            color={color}
                            width={width}
                            autoColor={autoColor}
                            focusMode={focusMode}
                            onColor={(next) => { setAutoColor(false); setColor(next) }}
                            onWidth={setWidth}
                            onAutoColor={() => setAutoColor(true)}
                            onResetZoom={() => engine?.resetZoom()}
                            onFrame={frame}
                            onFocus={() => setFocusMode((value) => !value)}
                        />
                    )}
                    <p id="inkpad-canvas-help" className="sr-only">{t('ink.canvas.help')}</p>
                    {fatalError && <div role="alert" className="absolute inset-0 grid place-items-center bg-[var(--bg-base)] p-4 text-center text-[length:var(--text-13)] text-[var(--danger)]">{t('ink.canvas.unavailable')}</div>}
                </div>
                {viewMode === 'code' && (
                    <textarea
                        value={rawCode}
                        readOnly={externalChange !== null}
                        onChange={(event) => sourceChanged(event.target.value)}
                        aria-label={t('ink.action.open_source')}
                        className="h-full w-full resize-none border-0 bg-[var(--bg-inset)] p-4 font-mono text-[length:var(--text-12)] leading-relaxed text-[var(--text-primary)] outline-none"
                    />
                )}
            </div>
            <Menu anchor={insertButtonRef} open={insertMenuOpen} onClose={() => setInsertMenuOpen(false)} items={insertItems} />
            <Menu anchor={exportButtonRef} open={exportMenuOpen} onClose={() => setExportMenuOpen(false)} items={exportItems} />
            <Menu anchor={quickMenu ?? { x: 0, y: 0 }} open={quickMenu !== null} onClose={() => setQuickMenu(null)} items={quickItems} />
            <NotePicker
                open={notePickerOpen}
                title={t('ink.note_picker.title')}
                excludeNoteId={note.id}
                filter={(candidate) => !isInkNoteTitle(candidate.title) && !candidate.title.endsWith('.excalidraw') && !isMindmapDocumentTitle(candidate.title)}
                onClose={() => setNotePickerOpen(false)}
                onSelect={(picked) => engineRef.current?.insertNote(picked)}
            />
            <InkFilePicker
                open={filePickerOpen}
                noteId={note.id}
                onClose={() => setFilePickerOpen(false)}
                onPick={(file) => engineRef.current?.insertFile(file)}
            />
        </div>
    )
}
