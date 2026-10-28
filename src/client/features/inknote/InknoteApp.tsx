import { useEffect, useRef, useState } from 'react'
import { Library, MoreHorizontal, PanelRight, Plus, Settings, Sparkles, X } from 'lucide-react'
import { t } from '../../lib/i18n'
import { isImeComposing } from '../../lib/ime'
import { cn } from '../../lib/cn'
import { useBreakpoint } from '../../lib/hooks'
import { replaceAddress } from '../../lib/app-history'
import { Button, IconButton } from '../../components/primitives'
import { ConfirmHost, Drawer, Menu, Modal, PromptHost, confirm, type MenuItem } from '../../components/overlay'
import { Empty, LoadingBlock } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { inknoteApi } from './api'
import { inknoteTextDefaults, inknoteToolState } from './tool-state'
import { DEFAULT_INKNOTE_SETTINGS } from '@shared/inknote/constants'
import { serializePageContent } from '@shared/inknote/parse'
import { randomLocalId } from '../../lib/random-id'
import { answerTextBoxes } from '../../lib/inknote/assistant-answer'
import type { InknoteFavorite, InknoteSettings } from '@shared/inknote/types'
import { useInknoteStore } from './store'
import { InkCanvasArea } from './components/InkCanvasArea'
import { InkPagesPanel } from './components/InkPagesPanel'
import { InkToolbar } from './components/InkToolbar'
import { LibraryPanel } from './library/LibraryPanel'
import { NotePickerDialog } from './library/NotePickerDialog'
import { SettingsDrawer } from './panels/SettingsDrawer'
import { FindDialog, OutlineDialog, StatsDialog } from './panels/NoteToolsDialogs'
import { TemplateCenter } from './panels/TemplateCenter'
import { ShortcutsDialog, WelcomeDialog } from './panels/InkHelpDialogs'
import { useInknoteHotkeys } from './use-inknote-hotkeys'
import { PresentationOverlay } from './tools/PresentationOverlay'
import { RecordingPanel } from './tools/RecordingPanel'
import { AssistantDock } from '../chat/AssistantDock'
import { AttachmentsDialog } from './io/AttachmentsDialog'
import { ExportPdfDialog } from './io/ExportPdfDialog'
import { ExportLibraryPdfDialog } from './io/ExportLibraryPdfDialog'
import { PdfImportDialog } from './io/PdfImportDialog'
import { ScanDialog } from './io/ScanDialog'
import { ImportNoteDialog } from './io/ImportNoteDialog'
import { useInknoteTts } from './tools/use-inknote-tts'
import { exportLongImage, exportNotebookFile, exportNoteFile, exportPagePng, exportTextFile, insertImage } from './io/operations'
import type { InknoteEngineApi } from './engine/inknote-engine'
import type { InknoteToolState } from './engine/inknote-engine-types'

export function InknoteApp() {
  const initialized = useInknoteStore((state) => state.initialized)
  const loading = useInknoteStore((state) => state.loading)
  const error = useInknoteStore((state) => state.error)
  const library = useInknoteStore((state) => state.library)
  const note = useInknoteStore((state) => state.note)
  const pages = useInknoteStore((state) => state.pages)
  const activePageId = useInknoteStore((state) => state.activePageId)
  const tabs = useInknoteStore((state) => state.tabs)
  const saveState = useInknoteStore((state) => state.saveState)
  const conflicts = useInknoteStore((state) => state.conflicts)
  const drafts = useInknoteStore((state) => state.drafts)
  const restoreDrafts = useInknoteStore((state) => state.restoreDrafts)
  const discardDrafts = useInknoteStore((state) => state.discardDrafts)
  const replayOfflineDrafts = useInknoteStore((state) => state.replayOfflineDrafts)
  const bootstrap = useInknoteStore((state) => state.bootstrap)
  const openNote = useInknoteStore((state) => state.openNote)
  const closeTab = useInknoteStore((state) => state.closeTab)
  const setActivePage = useInknoteStore((state) => state.setActivePage)
  const createNote = useInknoteStore((state) => state.createNote)
  const createPage = useInknoteStore((state) => state.createPage)
  const duplicatePage = useInknoteStore((state) => state.duplicatePage)
  const deletePage = useInknoteStore((state) => state.deletePage)
  const clearPage = useInknoteStore((state) => state.clearPage)
  const deleteBlankPages = useInknoteStore((state) => state.deleteBlankPages)
  const reorderPages = useInknoteStore((state) => state.reorderPages)
  const updateNoteMeta = useInknoteStore((state) => state.updateNoteMeta)
  const updateSettings = useInknoteStore((state) => state.updateSettings)
  const saveAll = useInknoteStore((state) => state.saveAll)
  const savePage = useInknoteStore((state) => state.savePage)
  const copyPageTo = useInknoteStore((state) => state.copyPageTo)
  const clearConflict = useInknoteStore((state) => state.clearConflict)
  const toast = useUi((state) => state.toast)
  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const toggleAssistantDock = useUi((state) => state.toggleAssistantDock)
  const breakpoint = useBreakpoint()
  const compact = breakpoint !== 'desktop'
  const [selectedNotebook, setSelectedNotebook] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [libraryVisible, setLibraryVisible] = useState(true)
  const [pagesOpen, setPagesOpen] = useState(false)
  const [pagesVisible, setPagesVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)
  const [presentationOpen, setPresentationOpen] = useState(false)
  const [recordingOpen, setRecordingOpen] = useState(false)
const [findOpen, setFindOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [pdfExportOpen, setPdfExportOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<'open' | 'copy' | null>(null)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [libraryPdfOpen, setLibraryPdfOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const attachInput = useRef<HTMLInputElement>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const [markup, setMarkup] = useState(false)
  const [title, setTitle] = useState('')
  const engineRef = useRef<InknoteEngineApi | null>(null)
  const settings = library?.settings
  const activePage = pages.find((page) => page.id === activePageId) ?? pages[0] ?? null
  const activeIndex = activePage ? pages.findIndex((page) => page.id === activePage.id) : 0
  const tool = settings ? inknoteToolState(settings) : inknoteToolState(DEFAULT_INKNOTE_SETTINGS)
  const assistantContext = note ? {
    noteId: note.id,
    noteTitle: note.title,
    notebookName: library?.notebooks.find((entry) => entry.id === note.notebookId)?.name ?? '',
    pageIndex: activeIndex,
    pageCount: pages.length,
    pageText: (activePage?.content.texts ?? []).map((item) => item.text).join('\n').slice(0, 6000),
    noteText: pages.map((page) => page.content.texts.map((item) => item.text).join('\n')).join('\n\n').slice(0, 12000),
    ...(settings?.aiPrompt ? { rolePrompt: settings.aiPrompt } : {}),
  } : null

  useEffect(() => { void bootstrap() }, [bootstrap])
  useEffect(() => { if (note) setTitle(note.title) }, [note?.id, note?.title])
  useEffect(() => {
    if (note) replaceAddress(`/inknote/note/${note.id}`)
  }, [initialized, note?.id])
  useEffect(() => {
    if (!initialized || note) return
    const match = /^\/inknote\/note\/([0-9a-hjkmnp-tv-z]{26})(?:\/page\/(\d+))?\/?$/.exec(window.location.pathname)
    if (!match) return
    void openNote(match[1]!, match[2] ? Number(match[2]) : 0)
  }, [initialized, note, openNote])

  useEffect(() => {
    if (!initialized || !settings) return
    const same = tabs.length === settings.openTabs.length && tabs.every((id, index) => id === settings.openTabs[index])
    if (same) return
    const timer = window.setTimeout(() => { void updateSettings({ openTabs: tabs }) }, 500)
    return () => window.clearTimeout(timer)
  }, [initialized, settings, tabs, updateSettings])


  useEffect(() => {
    const handler = () => { void saveAll() }
    const online = () => { void saveAll(); void replayOfflineDrafts() }
    window.addEventListener('pagehide', handler)
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', handler)
    return () => { window.removeEventListener('pagehide', handler); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', handler) }
  }, [saveAll, replayOfflineDrafts])

  const persistTitle = () => {
    if (!note) return
    const next = title.trim()
    if (!next) { setTitle(note.title); return }
    if (next !== note.title) void updateNoteMeta({ title: next })
  }

  const clearActivePage = () => {
    if (!activePage) return
    void confirm({ title: t('inknote.page.clear'), description: t('inknote.page.clear_confirm'), confirmLabel: t('inknote.page.clear') }).then((ok) => ok ? clearPage(activePage.id) : undefined)
  }

  const removeBlankPages = () => {
    void deleteBlankPages().then((count) => toast({ title: count > 0 ? t('inknote.page.blank_removed', { count: String(count) }) : t('inknote.page.no_blank') }))
  }

  useInknoteHotkeys({
    enabled: () => Boolean(useInknoteStore.getState().note),
    undo: () => { engineRef.current?.undo(); engineRef.current?.renderNow() },
    redo: () => { engineRef.current?.redo(); engineRef.current?.renderNow() },
    save: () => { void saveAll(); toast({ title: t('inknote.saved') }) },
    newNote: () => { void createNote(note?.notebookId ?? library?.notebooks[0]?.id) },
    find: () => setFindOpen(true),
    outline: () => setOutlineOpen(true),
    present: () => { if (note) setPresentationOpen(true) },
    exportPage: () => { if (note && activePage && settings) void exportPagePng(note, activePage, settings) },
    previousPage: () => { const state = useInknoteStore.getState(); const previous = state.pages[state.activePageIndex - 1]; if (previous) state.setActivePage(previous.id) },
    nextPage: () => { const state = useInknoteStore.getState(); const next = state.pages[state.activePageIndex + 1]; if (next) state.setActivePage(next.id) },
    selectAll: () => { engineRef.current?.selectAll(); engineRef.current?.renderNow() },
    copySelection: () => { engineRef.current?.copySelection() },
    pasteSelection: () => { engineRef.current?.pasteSelection(); engineRef.current?.renderNow() },
    deleteSelection: () => { engineRef.current?.deleteSelection(); engineRef.current?.renderNow() },
  })

  const changeTool = (patch: Partial<InknoteToolState>) => {
    if (!settings) return
    if (patch.tool !== undefined) { void updateSettings({ tool: patch.tool }); return }
    if (patch.color !== undefined) {
      if (settings.tool === 'highlighter') void updateSettings({ hlColor: patch.color, color: patch.color })
      else if (settings.tool === 'pen') void updateSettings({ penColor: patch.color, color: patch.color })
      else if (settings.tool === 'ballpen') void updateSettings({ ballpenColor: patch.color, color: patch.color })
      else void updateSettings({ color: patch.color })
      return
    }
    if (patch.width !== undefined) {
      if (settings.tool === 'highlighter') void updateSettings({ hlWidth: patch.width })
      else if (settings.tool === 'pen') void updateSettings({ penWidth: patch.width })
      else void updateSettings({ ballpenWidth: patch.width })
      return
    }
    if (patch.style !== undefined) void updateSettings(settings.tool === 'pen' ? { penStyle: patch.style } : { ballpenStyle: patch.style })
    if (patch.shape !== undefined) void updateSettings({ shape: patch.shape })
    if (patch.eraserSize !== undefined) void updateSettings({ eraserSize: patch.eraserSize })
    if (patch.eraserMode !== undefined) void updateSettings({ eraserMode: patch.eraserMode })
  }

  const tts = useInknoteTts({
    pages,
    activePageId,
    activePageIndex: activeIndex,
    rate: settings?.ttsRate ?? 1,
    language: typeof document === 'undefined' ? 'zh-CN' : document.documentElement.lang || 'zh-CN',
    onPage: setActivePage,
    onCue: (cue) => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('inknote:tts-cue', { detail: cue })) },
  })

  const insertAssistantAnswer = (text: string) => {
    const engine = engineRef.current
    const page = activePage
    if (!engine || !page || !settings || !note) return
    const before = serializePageContent(page.content)
    for (const box of answerTextBoxes(text, { pageHeight: note.pageHeight, textSize: settings.textSize })) {
      page.content.texts.push({ ...inknoteTextDefaults(), id: randomLocalId(), ...box })
    }
    if (engine.commitExternal(before, serializePageContent(page.content), 'assistant')) {
      engine.renderNow()
      void savePage()
      toast({ title: t('assistant.inknote.inserted') })
    }
  }

  const readAssistantAnswer = (text: string) => {
    if (typeof window.speechSynthesis === 'undefined') { toast({ title: t('inknote.read.unsupported'), tone: 'danger' }); return }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = document.documentElement.lang || 'zh-CN'
    utterance.rate = settings?.ttsRate ?? 1
    window.speechSynthesis.speak(utterance)
  }

  const saveFavorite = () => {
    if (!settings) return
    const state = inknoteToolState(settings)
    const favorite: InknoteFavorite = { tool: state.tool, color: state.color, width: state.width, style: state.style, eraserSize: state.eraserSize }
    const same = (entry: InknoteFavorite) => entry.tool === favorite.tool && entry.color === favorite.color && entry.width === favorite.width && entry.style === favorite.style && entry.eraserSize === favorite.eraserSize
    void updateSettings({ favorites: [favorite, ...settings.favorites.filter((entry) => !same(entry))].slice(0, 20), favoritesBar: true })
  }

  const applyFavorite = (favorite: InknoteFavorite) => {
    if (!settings) return
    const patch: Partial<InknoteSettings> = { tool: favorite.tool, color: favorite.color, eraserSize: favorite.eraserSize }
    if (favorite.tool === 'highlighter') { patch.hlColor = favorite.color; patch.hlWidth = favorite.width }
    else if (favorite.tool === 'pen') { patch.penColor = favorite.color; patch.penWidth = favorite.width; patch.penStyle = favorite.style }
    else if (favorite.tool === 'ballpen') { patch.ballpenColor = favorite.color; patch.ballpenWidth = favorite.width; patch.ballpenStyle = favorite.style }
    void updateSettings(patch)
  }

  const readAloud = () => {
    if (!tts.supported) { toast({ title: t('inknote.read.unsupported' as never), tone: 'danger' }); return }
    if (tts.active) { tts.stop(); return }
    if ((activePage?.content.texts ?? []).every((item) => !item.text.trim())) { toast({ title: t('inknote.read.empty' as never) }); return }
    tts.togglePage()
  }

  const readWholeNote = () => {
    if (!tts.supported) { toast({ title: t('inknote.read.unsupported' as never), tone: 'danger' }); return }
    if (tts.active) { tts.stop(); return }
    if (pages.every((page) => page.content.texts.every((item) => !item.text.trim()))) { toast({ title: t('inknote.read.empty' as never) }); return }
    tts.readAll()
  }

  function moreItems(): MenuItem[] {
    if (!note || !settings) return []
    return [
      { id: 'image', label: t('inknote.action.add_image' as never), onSelect: () => { setMoreMenu(null); imageInput.current?.click() } },
      { id: 'camera', label: t('inknote.action.camera' as never), onSelect: () => { setMoreMenu(null); cameraInput.current?.click() } },
      { id: 'scan', label: t('inknote.action.scan' as never), onSelect: () => { setMoreMenu(null); setScanOpen(true) } },
      { id: 'pdf', label: t('inknote.action.import_pdf' as never), onSelect: () => { setMoreMenu(null); pdfInput.current?.click() } },
      { id: 'attach', label: t('inknote.action.attach' as never), onSelect: () => { setMoreMenu(null); attachInput.current?.click() } },
      { id: 'attachments', label: t('inknote.attachments.title' as never), onSelect: () => { setMoreMenu(null); setAttachmentsOpen(true) } },
      { id: 'import', label: t('inknote.action.import' as never), onSelect: () => { setMoreMenu(null); importInput.current?.click() } },
      { id: 'present', label: t('inknote.action.presentation' as never), separatorBefore: true, onSelect: () => { setMoreMenu(null); setPresentationOpen(true) } },
      { id: 'pdf-export', label: t('inknote.action.export_pdf' as never), separatorBefore: true, onSelect: () => { setMoreMenu(null); setPdfExportOpen(true) } },
      { id: 'png-export', label: t('inknote.action.export_page_png' as never), onSelect: () => { setMoreMenu(null); if (activePage) void exportPagePng(note, activePage, settings) } },
      { id: 'library-pdf', label: t('inknote.action.export_library_pdf' as never), onSelect: () => { setMoreMenu(null); setLibraryPdfOpen(true) } },
      { id: 'long-image', label: t('inknote.action.export_long_image' as never), onSelect: () => { setMoreMenu(null); void exportLongImage(note, pages, settings, { title: note.title }).then((ok) => { if (ok) toast({ title: t('inknote.export.long_done') }) }).catch((error) => toast({ title: String(error), tone: 'danger' })) } },
      { id: 'note-export', label: t('inknote.action.export_note' as never), onSelect: () => { setMoreMenu(null); void exportNoteFile(note, pages) } },
      { id: 'notebook-export', label: t('inknote.action.export_notebook' as never), onSelect: () => { setMoreMenu(null); void exportNotebookFile() } },
      { id: 'text-export', label: t('inknote.action.export_text' as never), onSelect: () => { setMoreMenu(null); exportTextFile(note, pages, 'txt') } },
      { id: 'md-export', label: t('inknote.action.export_markdown' as never), onSelect: () => { setMoreMenu(null); exportTextFile(note, pages, 'md') } },
      { id: 'rtf-export', label: t('inknote.action.export_rtf' as never), onSelect: () => { setMoreMenu(null); exportTextFile(note, pages, 'rtf') } },
      { id: 'find', label: t('inknote.action.find' as never), separatorBefore: true, onSelect: () => { setMoreMenu(null); setFindOpen(true) } },
      { id: 'outline', label: t('inknote.action.outline' as never), onSelect: () => { setMoreMenu(null); setOutlineOpen(true) } },
      { id: 'stats', label: t('inknote.action.stats' as never), onSelect: () => { setMoreMenu(null); setStatsOpen(true) } },
      { id: 'templates', label: t('inknote.action.templates' as never), onSelect: () => { setMoreMenu(null); setTemplatesOpen(true) } },
      { id: 'read-all', label: t('inknote.action.read_all' as never), onSelect: () => { setMoreMenu(null); readWholeNote() } },
      { id: 'snapshot', label: t('inknote.settings.snapshots'), onSelect: () => { setMoreMenu(null); setSnapshotsOpen(true) } },
    ]
  }

  if (!initialized && loading) return <div className="flex h-full items-center justify-center bg-[var(--bg-base)]"><LoadingBlock /></div>
  if (error && !library) return <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"><p className="text-[length:var(--text-13)] text-[var(--danger)]">{error}</p><button type="button" className="text-[length:var(--text-12)] underline" onClick={() => void bootstrap()}>{t('inknote.reload')}</button></div>

  const showLibrary = !compact && !markup && libraryVisible
  const showPages = !compact && !markup && pagesVisible
  const leftToolbar = !compact && !markup && settings?.toolbar === 'left'
  const conflictPage = activePage ? conflicts[activePage.id] : undefined

  return (
    <div className="inknote-app relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--bg-base)]">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2">
        <IconButton label={t('inknote.library')} size="sm" active={!compact && libraryVisible} onClick={() => compact ? setLibraryOpen(true) : setLibraryVisible((value) => !value)}><Library size={16}/></IconButton>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={persistTitle}
          onKeyDown={(event) => { if (isImeComposing(event)) return; if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
          placeholder={t('inknote.untitled')}
          aria-label={t('inknote.rename')}
          className="min-w-0 flex-1 bg-transparent text-[length:var(--text-14)] font-semibold outline-none"
          disabled={!note}
        />
        <span data-save-state={saveState} aria-live="polite" className="hidden shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)] sm:inline">
          {saveState === 'saving' ? t('inknote.saving') : saveState === 'pending' ? t('inknote.save') : saveState === 'offline' ? t('inknote.offline') : saveState === 'error' ? t('inknote.save_failed') : t('inknote.saved')}
        </span>
        <IconButton label={t('inknote.action.ai')} size="sm" onClick={() => toggleAssistantDock()}><Sparkles size={15}/></IconButton>
        <IconButton label={t('inknote.action.more')} size="sm" onClick={(event) => setMoreMenu({ x: event.clientX, y: event.clientY, items: moreItems() })}><MoreHorizontal size={15}/></IconButton>
        <IconButton label={t('inknote.action.settings')} size="sm" onClick={() => setSettingsOpen(true)}><Settings size={15}/></IconButton>
        {compact && <IconButton label={t('inknote.action.pages')} size="sm" onClick={() => setPagesOpen(true)}><PanelRight size={16}/></IconButton>}
      </header>

      {!markup && settings && !leftToolbar && (
        <div className={cn('relative z-[var(--z-float)] shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]', settings.toolbar === 'bottom' && 'order-3 border-b-0 border-t')}>
          <InkToolbar
            engine={engineRef.current}
            tool={tool}
            onChange={changeTool}
            onPages={() => compact ? setPagesOpen(true) : setPagesVisible((value) => !value)}
            onSettings={() => setSettingsOpen(true)}
            onRecord={() => setRecordingOpen(true)}
            onRead={readAloud}
            onMarkup={() => setMarkup((value) => !value)}
            onAi={() => toggleAssistantDock()}
            favorites={settings.favorites}
            showFavorites={settings.favoritesBar}
            onApplyFavorite={applyFavorite}
            onSaveFavorite={saveFavorite}
          />
        </div>
      )}

      {conflictPage && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-3 py-1.5 text-[length:var(--text-12)]">
          <span className="min-w-0 flex-1 truncate">{t('inknote.conflict')}</span>
          <button type="button" className="underline" onClick={() => { if (activePage) { clearConflict(activePage.id); void openNote(note!.id, activeIndex) } }}>{t('inknote.reload')}</button>
          <button type="button" className="underline" onClick={() => { if (activePage && note) { const content = JSON.stringify(activePage.content); clearConflict(activePage.id); void inknoteApi.createPage(note.id, { afterPageId: activePage.id, content }).then(() => openNote(note.id)) } }}>{t('inknote.save_as_new_page')}</button>
        </div>
      )}

      {Object.keys(drafts).length > 0 && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-1.5 text-[length:var(--text-12)]">
          <span className="min-w-0 flex-1 truncate">{t('inknote.drafts.found', { count: String(Object.keys(drafts).length) })}</span>
          <button type="button" className="underline" onClick={() => void restoreDrafts()}>{t('inknote.drafts.restore')}</button>
          <button type="button" className="underline" onClick={discardDrafts}>{t('inknote.drafts.discard')}</button>
        </div>
      )}
      {saveState === 'offline' && !conflictPage && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-1.5 text-[length:var(--text-12)]">
          <span className="min-w-0 flex-1 truncate">{t('inknote.offline_hint')}</span>
          <button type="button" className="underline" onClick={() => void saveAll()}>{t('inknote.retry')}</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showLibrary && (
          <div className="w-[282px] shrink-0">
            <LibraryPanel selectedNotebookId={selectedNotebook} onSelectNotebook={setSelectedNotebook} />
          </div>
        )}
        <main className={cn('flex min-w-0 flex-1 overflow-hidden', leftToolbar ? 'flex-row' : 'flex-col')}>
          {leftToolbar && settings && (
            <div className="relative z-[var(--z-float)] w-11 shrink-0 border-r border-[var(--border-subtle)] bg-[var(--bg-surface)]">
              <InkToolbar
                engine={engineRef.current}
                tool={tool}
                orientation="vertical"
                onChange={changeTool}
                onPages={() => setPagesOpen(true)}
                onSettings={() => setSettingsOpen(true)}
                onRecord={() => setRecordingOpen(true)}
                onRead={readAloud}
                onMarkup={() => setMarkup((value) => !value)}
                onAi={() => toggleAssistantDock()}
                favorites={settings.favorites}
                showFavorites={settings.favoritesBar}
                onApplyFavorite={applyFavorite}
                onSaveFavorite={saveFavorite}
              />
            </div>
          )}
          {note && activePage && settings
            ? <InkCanvasArea
                note={note}
                page={activePage}
                pageIndex={activeIndex}
                pageCount={pages.length}
                previousPage={pages[activeIndex - 1] ?? null}
                nextPage={pages[activeIndex + 1] ?? null}
                settings={settings}
                tool={tool}
                onPrevPage={() => { const previous = pages[activeIndex - 1]; if (previous) setActivePage(previous.id) }}
                onNextPage={() => { const next = pages[activeIndex + 1]; if (next) setActivePage(next.id) }}
                onSelectPage={setActivePage}
                onEngine={(engine) => { engineRef.current = engine }}
              />
            : <div className="flex h-full items-center justify-center p-6">
                <Empty title={t('inknote.no_notes')} description={t('inknote.welcome.body')} action={<button type="button" className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1.5 text-[length:var(--text-12)] text-[var(--accent-contrast)]" onClick={() => void createNote(library?.notebooks[0]?.id)}>{t('inknote.new_note')}</button>} />
              </div>}
        </main>
        {showPages && note && settings && (
          <InkPagesPanel note={note} pages={pages} activePageId={activePageId} settings={settings} onSelect={setActivePage} onClear={clearActivePage} onDeleteBlank={removeBlankPages} onCopyTo={() => setPickerMode('copy')} onAdd={() => void createPage(activePageId ?? undefined)} onDuplicate={(id) => void duplicatePage(id)} onDelete={(id) => void confirm({ title: t('inknote.page.delete'), description: t('inknote.confirm_delete_note'), confirmLabel: t('inknote.delete') }).then((ok) => ok ? deletePage(id) : undefined)} onMove={(id, direction) => {
            const index = pages.findIndex((page) => page.id === id)
            const target = pages[index + direction]
            if (!target) return
            const ids = pages.map((page) => page.id)
            ids.splice(index, 1)
            ids.splice(index + direction, 0, id)
            void reorderPages(ids)
          }} />
        )}
        {assistantDockOpen && <AssistantDock surface="inknote" inknote={assistantContext} onInsertAnswer={insertAssistantAnswer} onReadAnswer={readAssistantAnswer}/>}
      </div>

      {tabs.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-t border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-1" role="tablist" aria-label={t('inknote.library')}>
          {tabs.map((id) => {
            const meta = library?.notes.find((entry) => entry.id === id)
            if (!meta) return null
            return (
              <div key={id} className={cn('flex max-w-40 shrink-0 items-center rounded-[var(--r-xs)]', note?.id === id ? 'bg-[var(--bg-surface)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]')}>
                <button type="button" role="tab" aria-selected={note?.id === id} onClick={() => void openNote(id)} className="min-w-0 flex-1 truncate px-2 py-1 text-left text-[length:var(--text-11)]">
                  {meta.title}
                </button>
                <IconButton label={t('inknote.close')} size="xs" onClick={() => { closeTab(id); if (note?.id === id) replaceAddress('/inknote') }}><X size={10}/></IconButton>
              </div>
            )
          })}
          <IconButton label={t('inknote.open_note')} size="xs" onClick={() => setPickerMode('open')}><Plus size={11}/></IconButton>
        </div>
      )}

      <Drawer open={libraryOpen} onClose={() => setLibraryOpen(false)} title={t('inknote.library')} side="left" width={300}>
        <LibraryPanel selectedNotebookId={selectedNotebook} onSelectNotebook={setSelectedNotebook} onAfterOpen={() => setLibraryOpen(false)} />
      </Drawer>
      <Drawer open={pagesOpen} onClose={() => setPagesOpen(false)} title={t('inknote.action.pages')} side="right" width={190}>
        {note && settings && <InkPagesPanel note={note} pages={pages} activePageId={activePageId} settings={settings} onSelect={(id) => { setActivePage(id); setPagesOpen(false) }} onClear={clearActivePage} onDeleteBlank={removeBlankPages} onCopyTo={() => setPickerMode('copy')} onAdd={() => void createPage(activePageId ?? undefined)} onDuplicate={(id) => void duplicatePage(id)} onDelete={(id) => void deletePage(id)} onMove={(id, direction) => {
          const index = pages.findIndex((page) => page.id === id)
          const ids = pages.map((page) => page.id)
          ids.splice(index, 1)
          ids.splice(index + direction, 0, id)
          void reorderPages(ids)
        }} />}
      </Drawer>
      {settings && <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} note={note} settings={settings} onOpenSnapshots={() => { setSettingsOpen(false); setSnapshotsOpen(true) }} onOpenShortcuts={() => { setSettingsOpen(false); setShortcutsOpen(true) }} onOpenTemplates={() => { setSettingsOpen(false); setTemplatesOpen(true) }} />}
      <SnapshotsDialog open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
      <RecordingPanel open={recordingOpen} noteId={note?.id ?? null} onClose={() => setRecordingOpen(false)} getEngine={() => engineRef.current} onPage={setActivePage} />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file && note && activePage) void insertImage(file, note, activePage).then(() => toast({ title: t('inknote.saved') })).catch((error) => toast({ title: String(error), tone: 'danger' })) }} />
      <input ref={imageInput} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file && note && activePage) void insertImage(file, note, activePage).then(() => toast({ title: t('inknote.saved') })).catch((error) => toast({ title: String(error), tone: 'danger' })) }} />
      <input ref={pdfInput} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) setPdfFile(file) }} />
      <input ref={attachInput} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file && note) void inknoteApi.uploadAsset(file, 'attachment', note.id).then(() => toast({ title: t('inknote.saved') })).catch((error) => toast({ title: String(error), tone: 'danger' })) }} />
      <input ref={importInput} type="file" accept=".note,.notebook,.json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) setImportFile(file) }} />
      {moreMenu && <Menu anchor={{ x: moreMenu.x, y: moreMenu.y }} open onClose={() => setMoreMenu(null)} items={moreMenu.items} />}
      {note && <FindDialog open={findOpen} onClose={() => setFindOpen(false)} pages={pages} onJump={(id) => { setActivePage(id); setFindOpen(false) }}/>}
      {note && <OutlineDialog open={outlineOpen} onClose={() => setOutlineOpen(false)} pages={pages} onJump={(id) => { setActivePage(id); setOutlineOpen(false) }}/>}
      {note && <StatsDialog open={statsOpen} onClose={() => setStatsOpen(false)} pages={pages} note={note}/>}
      <NotePickerDialog open={pickerMode !== null} onClose={() => setPickerMode(null)} title={pickerMode === 'copy' ? t('inknote.copy_page_to') : t('inknote.open_note')} excludeIds={pickerMode === 'open' ? tabs : []} onPick={(picked) => {
        if (pickerMode === 'copy') {
          if (!activePageId) return
          void copyPageTo(picked.id, activePageId).then(() => toast({ title: t('inknote.copied_page', { title: picked.title }) })).catch((error) => toast({ title: String(error), tone: 'danger' }))
          return
        }
        void openNote(picked.id)
      }}/>
      <TemplateCenter open={templatesOpen} onClose={() => setTemplatesOpen(false)} notebookId={note?.notebookId ?? library?.notebooks[0]?.id ?? null}/>
      <AttachmentsDialog open={attachmentsOpen} onClose={() => setAttachmentsOpen(false)} note={note}/>
      <ScanDialog open={scanOpen} onClose={() => setScanOpen(false)} notebookId={note?.notebookId ?? library?.notebooks[0]?.id ?? null}/>
      {note && settings && <ExportLibraryPdfDialog open={libraryPdfOpen} onClose={() => setLibraryPdfOpen(false)} notes={(library?.notes ?? []).filter((entry) => entry.notebookId === note.notebookId)} settings={settings}/>}
      <ImportNoteDialog open={importFile !== null} onClose={() => setImportFile(null)} file={importFile} notebookId={note?.notebookId ?? library?.notebooks[0]?.id ?? null}/>
      <PdfImportDialog open={pdfFile !== null} onClose={() => setPdfFile(null)} file={pdfFile} notebookId={note?.notebookId ?? library?.notebooks[0]?.id ?? null}/>
      {note && settings && <ExportPdfDialog open={pdfExportOpen} onClose={() => setPdfExportOpen(false)} note={note} pages={pages} settings={settings}/>}
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)}/>
      {settings && <WelcomeDialog open={initialized && !settings.welcomeSeen} onStart={() => void updateSettings({ welcomeSeen: true })} onClose={() => void updateSettings({ welcomeSeen: true })}/>}
      {presentationOpen && note && <PresentationOverlay note={note} pages={pages} initialIndex={activeIndex} onClose={() => setPresentationOpen(false)} />}
      <ConfirmHost />
      <PromptHost />
    </div>
  )
}

function snapSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function SnapshotsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useUi((state) => state.toast)
  const [items, setItems] = useState<{ id: string; label: string; noteCount: number; size: number; createdAt: number }[]>([])
  const [busy, setBusy] = useState(false)
  const load = () => { if (open) inknoteApi.snapshots().then((response) => setItems(response.snapshots)).catch(() => setItems([])) }
  useEffect(load, [open])
  return (
    <Modal open={open} onClose={onClose} title={t('inknote.settings.snapshots')} width={520}>
      <div className="space-y-1">
        <div className="mb-2 flex items-center gap-2">
          <Button size="sm" variant="primary" loading={busy} onClick={() => { setBusy(true); void inknoteApi.createSnapshot('manual').then(load).finally(() => setBusy(false)) }}>{t('inknote.settings.snapshots')}</Button>
          <span className="text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">{t('inknote.snapshots.retention')}</span>
        </div>
        {items.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.snapshots.empty')}</p>}
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)]">{new Date(item.createdAt).toLocaleString()} · {t('inknote.snapshots.notes', { count: String(item.noteCount) })} · {snapSize(item.size)}{item.label !== 'manual' ? ` · ${item.label}` : ''}</span>
            <button type="button" className="text-[length:var(--text-11)] underline" onClick={() => void (async () => {
              const ok = await confirm({ title: t('inknote.restore'), description: t('inknote.snapshots.restore_confirm'), confirmLabel: t('inknote.restore') })
              if (!ok) return
              try {
                await inknoteApi.restoreSnapshot(item.id)
                onClose()
                void useInknoteStore.getState().bootstrap()
              } catch (error) {
                toast({ title: String(error), tone: 'danger' })
              }
            })()}>{t('inknote.restore')}</button>
            <button type="button" className="text-[length:var(--text-11)] text-[var(--danger)]" onClick={() => void inknoteApi.deleteSnapshot(item.id).then(load)}>{t('inknote.delete')}</button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
