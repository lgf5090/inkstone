import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, Bell, FileDown, History, PanelLeft, Plus, Settings2, Share2, Sparkles, SquareKanban, Trash2, Users } from 'lucide-react'
import type { ProjectActivityEntry, ProjectBoardBundle, ProjectProperty, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { projectRoleAtLeast, emptyProjectViewFields } from '@shared/project/model'
import { projectFilterPrefill } from '@shared/project/view-eval'
import { buildProjectAssistantFacts } from '@shared/project/assistant-context'
import type { AssistantPageContext } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { navigateToPath, useSearch } from '../../lib/app-history'
import { useAssistant } from '../chat/assistant-store'
import { AssistantDock } from '../chat/AssistantDock'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm, Modal } from '../../components/overlay'
import { createCardFromTemplate, createProjectCard, createProjectView, deleteProjectCard, deleteProjectView, duplicateProjectCard, duplicateProjectView, fetchBoardActivity, fetchBoardCursor, fetchProjectBoardBundle, patchProjectBoard, patchProjectCard, patchProjectView, undeleteProjectCard } from './api'
import { createUndoStack } from './undo'
import { newProjectId } from '@shared/project/limits'
import type { SkinTone } from '@shared/types'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { randomProjectIcon, readRandomIconPref } from './project-icon'
import { readSidebarOpenPref, writeSidebarOpenPref } from './project-prefs'
import { useProjectStore } from './store'
import { ProjectSidebar } from './ProjectSidebar'
import { ImportDialog } from './ImportDialog'
import { BoardViews } from './BoardViews'
import { BoardPropertiesDialog } from './BoardPropertiesDialog'
import { CardDialog } from './CardDialog'
import { ShareDialog } from './ShareDialog'
import { MembersDialog } from './MembersDialog'
import { TrashDialog } from './TrashDialog'
import { useProjectWatch } from './use-watch'
import { useAssistantToolRefresh } from '../chat/tool-refresh'
import { PROJECT_WRITE_TOOL_NAMES } from '@shared/project/assistant-tools'

type Status = 'loading' | 'ready' | 'error' | 'notfound'

export function BoardPage({ boardId }: { boardId: string }): ReactElement {
  const search = useSearch()
  const [bundle, setBundle] = useState<ProjectBoardBundle | null>(null)
  const bundleRef = useRef<ProjectBoardBundle | null>(null)
  bundleRef.current = bundle
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [iconOpen, setIconOpen] = useState(false)
  const [iconTone, setIconTone] = useState<SkinTone>(0)
  const [undoStack] = useState(() => createUndoStack())
  const refresh = useCallback(async () => {
    setBundle(await fetchProjectBoardBundle(boardId))
  }, [boardId])
  useEffect(() => { undoStack.clear() }, [boardId, undoStack])
  const [showProps, setShowProps] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const boardWatch = useProjectWatch('board', boardId)
  useAssistantToolRefresh(PROJECT_WRITE_TOOL_NAMES, refresh)
  const [showActivity, setShowActivity] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpenPref)
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([])

  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const boards = useProjectStore((state) => state.boards)
  const ensureBoards = useProjectStore((state) => state.ensureBoards)
  useEffect(() => { void ensureBoards() }, [ensureBoards])

  const activeView = bundle?.views.find((v) => v.id === activeViewId) ?? bundle?.views[0]
  const assistantContext = useMemo<AssistantPageContext | null>(() => {
    if (!bundle) return null
    return {
      surface: 'project',
      label: bundle.board.title || t('project.boards.untitled'),
      facts: buildProjectAssistantFacts(bundle, activeView?.fields ?? emptyProjectViewFields()),
    }
  }, [bundle, activeView])

  useEffect(() => {
    useAssistant.getState().setDockSurface('project')
    useAssistant.getState().setProjectContext(assistantContext)
    return () => {
      useAssistant.getState().setProjectContext(null)
    }
  }, [assistantContext])

  useEffect(() => {
    const id = new URLSearchParams(search).get('card')
    if (id) setOpenCardId(id)
  }, [search])

  const openActivity = () => {
    setShowActivity(true)
    fetchBoardActivity(boardId).then(setActivity).catch(() => setActivity([]))
  }
  const exportMarkdown = () => {
    window.open(`/api/project/boards/${encodeURIComponent(boardId)}/markdown`, '_blank')
  }

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError(null)
    fetchProjectBoardBundle(boardId, controller.signal)
      .then((result) => {
        setBundle(result)
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const isNotFound = typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404
        setStatus(isNotFound ? 'notfound' : 'error')
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [boardId])

  // Realtime fallback (D-11): the sync hub notifies members on writes, but a tab that misses the
  // notification (or a deployment without the DO) still converges via a quiet 30s refetch.
  useEffect(() => {
    const controller = new AbortController()
    const converge = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      // Ask the cheap question first: an unchanged cursor means the copy on screen is still current,
      // and a busy board's whole-bundle read is the expensive half of this poll.
      fetchBoardCursor(boardId, controller.signal)
        .then(async (cursor) => {
          if (cursor <= (bundleRef.current?.cursor ?? 0)) return
          setBundle(await fetchProjectBoardBundle(boardId, controller.signal))
        })
        .catch(() => { /* best-effort convergence poll: a failed refetch keeps the last good bundle */ return undefined })
    }
    const timer = window.setInterval(converge, 30_000)
    let lastRefetch = Date.now()
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden && Date.now() - lastRefetch > 5_000) {
        lastRefetch = Date.now()
        fetchProjectBoardBundle(boardId, controller.signal)
          .then((fresh) => setBundle(fresh))
          .catch(() => { /* best-effort wake-up refetch: the interval still converges on its next beat */ return undefined })
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      window.clearInterval(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      controller.abort()
    }
  }, [boardId])

  const addCard = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed || busy || !bundle) return
    setBusy(true)
    try {
      const values = projectFilterPrefill(bundle.views.find((view) => view.id === activeViewId)?.fields.filter)
      const card = await createProjectCard(boardId, readRandomIconPref() ? { title: trimmed, values, icon: await randomProjectIcon() } : { title: trimmed, values })
      setBundle((current) => (current ? { ...current, cards: [...current.cards, card] } : current))
      undoStack.push({
        undo: async () => { await deleteProjectCard(card.id); await refresh() },
        redo: async () => { await undeleteProjectCard(card.id); await refresh() },
      })
      setTitle('')
    } finally {
      setBusy(false)
    }
  }, [title, busy, bundle, boardId, activeViewId])

  const removeCard = useCallback(async (cardId: string) => {
    const ok = await confirm({ title: t('project.board.delete_card'), tone: 'danger', confirmLabel: t('project.boards.delete_confirm') })
    if (!ok) return
    await deleteProjectCard(cardId)
    setBundle((current) => (current ? { ...current, cards: current.cards.filter((card) => card.id !== cardId) } : current))
    undoStack.push({
      undo: async () => { await undeleteProjectCard(cardId); await refresh() },
      redo: async () => { await deleteProjectCard(cardId); await refresh() },
    })
  }, [undoStack, refresh])

  const patchCard = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const previous = bundle?.cards.find((card) => card.id === id)
    const updated = await patchProjectCard(id, patch)
    setBundle((current) => (current ? { ...current, cards: current.cards.map((card) => (card.id === id ? updated : card)) } : current))
    if (previous) {
      undoStack.push({
        undo: async () => { await patchProjectCard(id, { title: previous.title, values: previous.values, icon: previous.icon }); await refresh() },
        redo: async () => { await patchProjectCard(id, patch); await refresh() },
      })
    }
  }, [bundle, undoStack, refresh])

  const addGroupOption = useCallback(async (propertyId: string, value: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: [...property.options, { id: newProjectId('property'), value, color: '' }] }
      : property))
    const result = await patchProjectBoard(boardId, { updatedCardProperties: properties })
    setBundle((current) => (current ? { ...current, properties: result.properties } : current))
  }, [bundle, boardId])

  // Renaming a column renames the option, so every card wearing it and every other view of it agree.
  const renameGroupOption = useCallback(async (propertyId: string, optionId: string, value: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: property.options.map((option) => (option.id === optionId ? { ...option, value } : option)) }
      : property))
    const result = await patchProjectBoard(boardId, { updatedCardProperties: properties })
    setBundle((current) => (current ? { ...current, properties: result.properties } : current))
  }, [bundle, boardId])

  const setGroupOptionColor = useCallback(async (propertyId: string, optionId: string, color: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: property.options.map((option) => (option.id === optionId ? { ...option, color } : option)) }
      : property))
    const result = await patchProjectBoard(boardId, { updatedCardProperties: properties })
    setBundle((current) => (current ? { ...current, properties: result.properties } : current))
  }, [bundle, boardId])

  const setIcon = useCallback(async (icon: string) => {
    await patchProjectBoard(boardId, { icon })
    setBundle((current) => (current ? { ...current, board: { ...current.board, icon } } : current))
  }, [boardId])

  const addView = useCallback(async (viewType: ProjectViewType) => {
    const view = await createProjectView(boardId, viewType)
    setBundle((current) => (current ? { ...current, views: [...current.views, view] } : current))
  }, [boardId])

  const saveProps = useCallback(async (properties: ProjectProperty[], deletedIds: string[]) => {
    const result = await patchProjectBoard(boardId, { updatedCardProperties: properties, deletedCardProperties: deletedIds })
    setBundle((current) => (current ? { ...current, properties: result.properties } : current))
  }, [boardId])

  const patchView = useCallback(async (viewId: string, patch: ProjectViewPatch) => {
    const view = await patchProjectView(viewId, patch)
    setBundle((current) => (current ? { ...current, views: current.views.map((entry) => (entry.id === viewId ? view : entry)) } : current))
  }, [])

  const removeView = useCallback(async (viewId: string) => {
    const ok = await confirm({ title: t('project.view.delete'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    await deleteProjectView(viewId)
    setBundle((current) => (current ? { ...current, views: current.views.filter((entry) => entry.id !== viewId) } : current))
  }, [])

  const copyView = useCallback(async (viewId: string) => {
    const view = await duplicateProjectView(viewId)
    setBundle((current) => (current ? { ...current, views: [...current.views, view] } : current))
  }, [])

  const guard = useCallback((action: () => Promise<void>): Promise<void> => {
    return action().catch((reason: unknown) => {
      useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    })
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) void undoStack.redo(); else void undoStack.undo() }
      else if (mod && key === 'y') { event.preventDefault(); void undoStack.redo() }
      else if (mod && key === 'd' && openCardId) { event.preventDefault(); void duplicateProjectCard(openCardId).then(refresh) }
      else if ((event.key === 'Delete' || event.key === 'Backspace') && openCardId) { event.preventDefault(); void removeCard(openCardId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openCardId, undoStack, refresh, removeCard])

  if (status === 'loading') return <LoadingBlock />
  if (status === 'notfound') return <Empty art="select" title={t('project.board.not_found')} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  if (status === 'error' || !bundle) {
    return <Empty art="select" title={t('project.board.load_failed')} description={error ?? undefined} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  }

  const canEdit = projectRoleAtLeast(bundle.role, 'editor')
  const openCard = bundle.cards.find((card) => card.id === openCardId) ?? null

  return (
    <div className="flex h-full w-full min-w-0 bg-[var(--bg-base)]" data-project-board-page={boardId}>
      {sidebarOpen && <ProjectSidebar boards={boards} onImport={() => setShowImport(true)} />}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <IconButton label={t('project.board.back')} size="sm" onClick={() => navigateToPath('/project')}>
            <ArrowLeft size={16} />
          </IconButton>
          <IconButton
            label={t('project.board.toggle_sidebar')}
            size="sm"
            active={sidebarOpen}
            onClick={() => setSidebarOpen((v) => { writeSidebarOpenPref(!v); return !v })}
          >
            <PanelLeft size={16} />
          </IconButton>
          <button type="button" aria-label={t('project.board.change_icon')} className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[length:var(--text-14)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => setIconOpen(true)}>
            {bundle.board.icon || <SquareKanban size={16} className="text-[var(--accent-on-soft)]" />}
          </button>
          <h1 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {bundle.board.title || t('project.boards.untitled')}
          </h1>
          <span className="ml-auto shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('project.board.cards_count', { count: bundle.cards.length })}
          </span>
          {canEdit && (
            <IconButton label={t('project.props.title')} size="sm" onClick={() => setShowProps(true)}>
              <Settings2 size={16} />
            </IconButton>
          )}
          {bundle.role === 'admin' && (
            <>
              <IconButton label={t('project.members.title')} size="sm" onClick={() => setShowMembers(true)}>
                <Users size={16} />
              </IconButton>
              <IconButton label={t('project.share.title')} size="sm" onClick={() => setShowShare(true)}>
                <Share2 size={16} />
              </IconButton>
            </>
          )}
          <IconButton label={boardWatch.watching ? t('project.watch.off') : t('project.watch.on')} size="sm" active={boardWatch.watching} onClick={() => { void boardWatch.toggle() }}><Bell size={16} /></IconButton>
          {bundle.role === 'admin' && (
            <IconButton label={t('project.trash.title')} size="sm" onClick={() => setShowTrash(true)}><Trash2 size={16} /></IconButton>
          )}
          <IconButton label={t('project.board.activity')} size="sm" onClick={openActivity}><History size={16} /></IconButton>
          <IconButton label={t('project.board.export_md')} size="sm" onClick={exportMarkdown}><FileDown size={16} /></IconButton>
          <IconButton
            label={t('assistant.dock.toggle')}
            size="sm"
            active={assistantDockOpen}
            onClick={() => useUi.getState().toggleAssistantDock()}
          >
            <Sparkles size={16} />
          </IconButton>
        </header>
      {canEdit && (
        <form
          className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void addCard()
          }}
        >
          <Input
            className="min-w-0 flex-1"
            value={title}
            placeholder={t('project.board.card_placeholder')}
            aria-label={t('project.board.card_placeholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={busy || !title.trim()} icon={<Plus size={15} />}>
            {t('project.board.new_card')}
          </Button>
          {canEdit && bundle.cards.some((card) => card.isTemplate) && (
            <SelectMenu
              className="w-36"
              value=""
              label={t('project.card.from_template')}
              placeholder={t('project.card.from_template')}
              onChange={(templateId) => {
                if (!templateId) return
                void createCardFromTemplate(boardId, templateId).then((card) => setBundle((current) => (current ? { ...current, cards: [...current.cards, card] } : current)))
              }}
              options={bundle.cards.filter((card) => card.isTemplate).map((card) => ({ value: card.id, label: card.title }))}
            />
          )}
        </form>
      )}
      <BoardViews
        bundle={bundle}
        canEdit={canEdit}
        onDeleteCard={(id) => void removeCard(id)}
        onCreateView={(type) => guard(() => addView(type))}
        onOpenCard={setOpenCardId}
        onPatchView={(id, patch) => guard(() => patchView(id, patch))}
        onDeleteView={(id) => guard(() => removeView(id))}
        onDuplicateView={(id) => guard(() => copyView(id))}
        onActiveViewChange={setActiveViewId}
        onPatchCard={patchCard}
        onAddGroupOption={addGroupOption}
        onRenameGroupOption={renameGroupOption}
        onSetGroupOptionColor={setGroupOptionColor}
        onRefresh={refresh}
      />
      </div>
      {assistantDockOpen && (
        <AssistantDock surface="project" pageContext={assistantContext} />
      )}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
      {showProps && (
        <BoardPropertiesDialog
          boardId={boardId}
          properties={bundle.properties}
          onClose={() => setShowProps(false)}
          onSave={saveProps}
        />
      )}
      {showTrash && <TrashDialog boardId={boardId} onClose={() => setShowTrash(false)} onRestored={() => { void refresh() }} />}
      {showShare && <ShareDialog boardId={boardId} onClose={() => setShowShare(false)} />}
      {showMembers && (
        <MembersDialog
          boardId={boardId}
          boardType={bundle.board.type}
          minimumRole={bundle.board.minimumRole}
          onClose={() => setShowMembers(false)}
          onBoardPatched={async (patch) => {
            const result = await patchProjectBoard(boardId, patch)
            setBundle((current) => (current ? { ...current, board: result.board } : current))
          }}
        />
      )}
      {iconOpen && (
        <Modal open onClose={() => setIconOpen(false)} title={t('project.board.change_icon')} width={420}>
          <div className="space-y-2">
            <EmojiPicker tone={iconTone} onTone={setIconTone} onInsert={(glyph) => { void setIcon(glyph); setIconOpen(false) }} />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { void randomProjectIcon().then((glyph) => { void setIcon(glyph); setIconOpen(false) }) }}>{t('project.board.random_icon')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { void setIcon(''); setIconOpen(false) }}>{t('project.board.remove_icon')}</Button>
            </div>
          </div>
        </Modal>
      )}
      {showActivity && (
        <Modal open onClose={() => setShowActivity(false)} title={t('project.board.activity')} width={480}>
          <ul className="space-y-2">
            {activity.map((entry) => (
              <li key={entry.id} className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                <span className="text-[var(--text-tertiary)]">{new Date(entry.createdAt).toLocaleString()}</span> — {entry.summary}
              </li>
            ))}
            {activity.length === 0 && <li className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">—</li>}
          </ul>
        </Modal>
      )}
      {openCard && (
        <CardDialog
          key={openCard.id}
          card={openCard}
          properties={bundle.properties}
          members={bundle.members}
          contents={bundle.contents.filter((content) => content.cardId === openCard.id)}
          siblings={bundle.cards}
          canEdit={canEdit}
          onClose={() => setOpenCardId(null)}
          onDelete={(id) => void removeCard(id)}
          onUpdated={(updated) => setBundle((current) => (current ? { ...current, cards: current.cards.map((card) => (card.id === updated.id ? updated : card)) } : current))}
          onRefresh={() => { void fetchProjectBoardBundle(boardId).then(setBundle).catch(() => { /* best-effort: dialog stays usable if the refetch fails */ return undefined }) }}
          onOpenCard={setOpenCardId}
        />
      )}
    </div>
  )
}