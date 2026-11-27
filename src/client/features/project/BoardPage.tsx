import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, ArrowLeft, Bell, CloudOff, FileDown, History, PanelLeft, Plus, Settings2, Share2, Sparkles, SquareKanban, Trash2, Users } from 'lucide-react'
import type { ProjectActivityEntry, ProjectCard, ProjectProperty, ProjectView, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { projectRoleAtLeast, emptyProjectViewFields, projectPersonLabel } from '@shared/project/model'
import { projectFilterPrefill } from '@shared/project/view-eval'
import { buildProjectAssistantFacts } from '@shared/project/assistant-context'
import type { AssistantPageContext } from '@shared/assistant'
import { t, useLocale } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { PROJECT_OUTBOX_CHANGED_EVENT, PROJECT_OUTBOX_FLUSHED_EVENT } from '../../lib/runtime'
import { discardProjectWriteConflict, pendingProjectWrites, projectWriteConflicts } from './offline-outbox'
import type { OutboxItem } from '../../lib/db'
import { ApiError } from '../../lib/api'
import { useAssistant } from '../chat/assistant-store'
import { AssistantDock } from '../chat/AssistantDock'
import { useUi } from '../../store/ui'
import { Button, IconButton, Avatar } from '../../components/primitives'
import { Input } from '../../components/form'
import { SelectMenu } from '../../components/select-menu'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm, Modal } from '../../components/overlay'
import { batchPatchProjectBoard, createCardFromTemplate, createProjectCard, createProjectView, deleteProjectCard, deleteProjectView, duplicateProjectCard, duplicateProjectView, fetchBoardActivity, fetchBoardCursor, patchProjectBoard, patchProjectCard, patchProjectView, undeleteProjectCard, undeleteProjectView } from './api'
import { createUndoStack } from './undo'
import { useBoardSession } from './use-board-session'
import { useBoardPresence } from './use-board-presence'
import { PROJECT_REALTIME_EVENT, type ProjectRealtimeDetail } from './realtime-events'
import { newProjectId, PROJECT_LIMITS } from '@shared/project/limits'
import type { SkinTone } from '@shared/types'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { randomProjectIcon, readRandomIconPref } from './project-icon'
import { readSidebarOpenPref, writeSidebarOpenPref } from './project-prefs'
import { useSession } from '../../store/session'
import { useProjectStore } from './store'
import { ProjectSidebar } from './ProjectSidebar'
import { ImportDialog } from './ImportDialog'
import { BoardViews } from './BoardViews'
import { BoardPropertiesDialog } from './BoardPropertiesDialog'
import { CardDialog } from './CardDialog'
import { ProjectConflictsDialog } from './ProjectConflictsDialog'
import { ShareDialog } from './ShareDialog'
import { MembersDialog } from './MembersDialog'
import { TrashDialog } from './TrashDialog'
import { useProjectWatch } from './use-watch'
import { useAssistantToolRefresh } from '../chat/tool-refresh'
import { PROJECT_WRITE_TOOL_NAMES } from '@shared/project/assistant-tools'

type Status = 'loading' | 'ready' | 'error' | 'notfound'

function isOfflineReadFailure(reason: unknown): boolean {
  if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403 || reason.status === 404)) return false
  return (typeof navigator !== 'undefined' && !navigator.onLine)
    || (reason instanceof ApiError && (reason.isOffline || reason.status === 429 || reason.status >= 500))
}

const ACTIVITY_VERB: Record<string, Parameters<typeof t>[0]> = {
  post: 'project.dashboard.act_created',
  patch: 'project.dashboard.act_updated',
  delete: 'project.dashboard.act_deleted',
  reminder: 'project.dashboard.act_reminder',
}

function viewPatchSnapshot(view: ProjectView): ProjectViewPatch {
  return { title: view.title, viewType: view.viewType, fields: view.fields, position: view.position }
}

function cardPatchSnapshot(card: ProjectCard, valuePatch?: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, string | null> = { ...card.values }
  const touched = valuePatch?.values
  if (touched && typeof touched === 'object') {
    for (const propertyId of Object.keys(touched)) if (!(propertyId in values)) values[propertyId] = null
  }
  return {
    title: card.title,
    values,
    icon: card.icon,
    parentId: card.parentId,
    contentOrder: card.contentOrder,
    recurrence: card.recurrence ?? null,
  }
}

export function BoardPage({ boardId }: { boardId: string }): ReactElement {
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const {
    bundle, setBundle, bundleRef, refresh, loadMoreCards, loadingMore, cardsError, usingCachedBundle,
    detailCardId, refreshBoard, boardEpoch, forgetCard,
  } = useBoardSession(boardId, setOpenCardId)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [iconOpen, setIconOpen] = useState(false)
  const [iconTone, setIconTone] = useState<SkinTone>(0)
  const [undoStack] = useState(() => createUndoStack())
  useEffect(() => { undoStack.clear() }, [boardId, undoStack])
  const loadGeneration = useRef(0)
  const activityBoard = useRef(boardId)
  activityBoard.current = boardId
  const activityGeneration = useRef(0)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [conflicts, setConflicts] = useState<OutboxItem[]>([])
  const [showConflicts, setShowConflicts] = useState(false)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void Promise.all([pendingProjectWrites(), projectWriteConflicts()])
        .then(([count, items]) => { if (alive) { setPendingWrites(count); setConflicts(items) } })
        .catch((cause: unknown) => { console.warn('[inkstone] project outbox count failed:', cause) })
    }
    const onFlushed = (): void => { read(); void refresh() }
    read()
    window.addEventListener(PROJECT_OUTBOX_CHANGED_EVENT, read)
    window.addEventListener(PROJECT_OUTBOX_FLUSHED_EVENT, onFlushed)
    return () => {
      alive = false
      window.removeEventListener(PROJECT_OUTBOX_CHANGED_EVENT, read)
      window.removeEventListener(PROJECT_OUTBOX_FLUSHED_EVENT, onFlushed)
    }
  }, [refresh])
  const [showProps, setShowProps] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const boardWatch = useProjectWatch('board', boardId)
  const onlineUserIds = useBoardPresence(boardId, status === 'ready' && !usingCachedBundle)
  useEffect(() => {
    const onProjectChange = (event: Event): void => {
      const detail = (event as CustomEvent<ProjectRealtimeDetail>).detail
      if (detail?.boardId !== boardId) return
      void refresh().catch((cause: unknown) => {
        console.warn('[inkstone] project realtime refresh failed:', cause)
      })
    }
    window.addEventListener(PROJECT_REALTIME_EVENT, onProjectChange)
    return () => window.removeEventListener(PROJECT_REALTIME_EVENT, onProjectChange)
  }, [boardId, refresh])
  useAssistantToolRefresh(PROJECT_WRITE_TOOL_NAMES, refresh)
  const [showActivity, setShowActivity] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpenPref)
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([])
  const [activityStatus, setActivityStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const locale = useLocale()

  const assistantDockOpen = useUi((state) => state.assistantDockOpen)
  const currentUserId = useSession((state) => state.user?.id)
  const boards = useProjectStore((state) => state.boards)
  const ensureBoards = useProjectStore((state) => state.ensureBoards)
  useEffect(() => { void ensureBoards() }, [ensureBoards])
  // The sidebar renames and recolours through the store; the open header must read the same copy.
  const listedBoard = boards.find((entry) => entry.id === boardId)
  const headerTitle = listedBoard?.title || bundle?.board.title || t('project.boards.untitled')
  const headerIcon = listedBoard?.icon || bundle?.board.icon

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

  const retryBoard = () => {
    const generation = ++loadGeneration.current
    setStatus('loading')
    setError(null)
    void refresh()
      .then(() => { if (generation === loadGeneration.current && refreshBoard.current === boardId) setStatus('ready') })
      .catch((reason: unknown) => {
        if (generation !== loadGeneration.current || refreshBoard.current !== boardId) return
        if (bundleRef.current && isOfflineReadFailure(reason)) {
          setStatus('ready')
          setError(null)
          return
        }
        const isNotFound = typeof reason === 'object' && reason !== null && 'status' in reason && (reason as { status: number }).status === 404
        setStatus(isNotFound ? 'notfound' : 'error')
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  const openActivity = () => {
    const generation = ++activityGeneration.current
    setShowActivity(true)
    setActivityStatus('loading')
    fetchBoardActivity(boardId)
      .then((entries) => {
        if (generation === activityGeneration.current && activityBoard.current === boardId) {
          setActivity(entries)
          setActivityStatus('ready')
        }
      })
      .catch(() => { if (generation === activityGeneration.current && activityBoard.current === boardId) setActivityStatus('error') })
  }
  const exportMarkdown = () => {
    window.open(`/api/project/boards/${encodeURIComponent(boardId)}/markdown`, '_blank')
  }
  const discardConflict = async (item: OutboxItem): Promise<void> => {
    const ok = await confirm({ title: t('project.offline.conflict_discard_confirm'), tone: 'danger', confirmLabel: t('project.offline.conflict_discard') })
    if (!ok) return
    try {
      await discardProjectWriteConflict(item.id, item.writeId)
      if (conflicts.length <= 1) setShowConflicts(false)
    } catch (reason) {
      useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    }
  }

  useEffect(() => {
    let alive = true
    const generation = ++loadGeneration.current
    setStatus('loading')
    setError(null)
    void refresh()
      .then(() => { if (alive && generation === loadGeneration.current) setStatus('ready') })
      .catch((err: unknown) => {
        if (!alive || generation !== loadGeneration.current) return
        if (bundleRef.current && isOfflineReadFailure(err)) {
          setStatus('ready')
          setError(null)
          return
        }
        const isNotFound = typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 404
        setStatus(isNotFound ? 'notfound' : 'error')
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [boardId, refresh])

  useEffect(() => {
    activityGeneration.current += 1
    setShowActivity(false)
    setActivity([])
    setActivityStatus('idle')
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
          await refresh()
        })
        .catch(() => { /* best-effort convergence poll: a failed refetch keeps the last good bundle */ return undefined })
    }
    const timer = window.setInterval(converge, 30_000)
    let lastRefetch = Date.now()
    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden && Date.now() - lastRefetch > 5_000) {
        lastRefetch = Date.now()
        void refresh().catch(() => { /* best-effort wake-up refetch: the interval still converges on its next beat */ return undefined })
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
  }, [boardId, refresh])

  const refreshAfterCommand = useCallback(() => refresh().catch((reason: unknown) => {
    useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
  }), [refresh])

  const addCard = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed || busy || !bundle) return
    setBusy(true)
    const epoch = boardEpoch.current
    try {
      const values = projectFilterPrefill(bundle.views.find((view) => view.id === activeViewId)?.fields.filter)
      const card = await createProjectCard(boardId, readRandomIconPref() ? { title: trimmed, values, icon: await randomProjectIcon() } : { title: trimmed, values })
      if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
      setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, card.createAt), cards: [...current.cards, card] } : current)
      undoStack.push({
        undo: async () => { await deleteProjectCard(card.id); await refreshAfterCommand() },
        redo: async () => { await undeleteProjectCard(card.id); await refreshAfterCommand() },
      })
      setTitle('')
    } catch (reason) {
      useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }, [title, busy, bundle, boardId, activeViewId, refreshAfterCommand])

  const removeCard = useCallback(async (cardId: string) => {
    const ok = await confirm({ title: t('project.board.delete_card'), tone: 'danger', confirmLabel: t('project.boards.delete_confirm') })
    if (!ok) return
    const epoch = boardEpoch.current
    await deleteProjectCard(cardId)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    forgetCard(cardId)
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, Date.now()), cards: current.cards.filter((card) => card.id !== cardId) } : current)
    undoStack.push({
      undo: async () => { await undeleteProjectCard(cardId); await refreshAfterCommand() },
      redo: async () => { await deleteProjectCard(cardId); await refreshAfterCommand() },
    })
  }, [boardId, undoStack, refreshAfterCommand, forgetCard])

  const patchCard = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const previous = bundle?.cards.find((card) => card.id === id)
    const epoch = boardEpoch.current
    const updated = await patchProjectCard(id, patch)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, updated.updateAt), cards: current.cards.map((card) => (card.id === id ? updated : card)) } : current)
    if (previous) {
      undoStack.push({
        undo: async () => { await patchProjectCard(id, cardPatchSnapshot(previous, patch)); await refreshAfterCommand() },
        redo: async () => { await patchProjectCard(id, patch); await refreshAfterCommand() },
      })
    }
  }, [bundle, boardId, undoStack, refreshAfterCommand])

  const patchCardsBatch = useCallback(async (patches: { id: string, patch: Record<string, unknown> }[]): Promise<void> => {
    const previous = bundle?.cards.filter((card) => patches.some((entry) => entry.id === card.id)) ?? []
    const epoch = boardEpoch.current
    await batchPatchProjectBoard(boardId, { cards: patches })
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? {
      ...current,
      cursor: Math.max(current.cursor, Date.now()),
      cards: current.cards.map((card) => {
        const values = patches.find((entry) => entry.id === card.id)?.patch.values as Record<string, string | null> | undefined
        if (!values) return card
        const merged = { ...card.values }
        for (const [key, value] of Object.entries(values)) {
          if (value === null) delete merged[key]
          else merged[key] = value
        }
        return { ...card, values: merged }
      }),
    } : current)
    if (previous.length) {
      undoStack.push({
        undo: async () => {
          await batchPatchProjectBoard(boardId, { cards: previous.map((card) => ({
            id: card.id,
            patch: cardPatchSnapshot(card, patches.find((entry) => entry.id === card.id)?.patch),
          })) })
          await refreshAfterCommand()
        },
        redo: async () => {
          await batchPatchProjectBoard(boardId, { cards: patches })
          await refreshAfterCommand()
        },
      })
    }
  }, [bundle, boardId, undoStack, refreshAfterCommand])

  const dragCards = useCallback(async (patches: { id: string, patch: Record<string, unknown> }[], cardOrder: string[]) => {
    if (!bundle || !activeViewId) return
    const view = bundle.views.find((entry) => entry.id === activeViewId)
    if (!view) return
    const previous = bundle.cards.filter((card) => patches.some((entry) => entry.id === card.id))
    const epoch = boardEpoch.current
    await batchPatchProjectBoard(boardId, {
      cards: patches,
      views: [{ id: view.id, patch: { fields: { cardOrder } } }],
    })
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    undoStack.push({
      undo: async () => {
        await batchPatchProjectBoard(boardId, {
          cards: previous.map((card) => ({
            id: card.id,
            patch: cardPatchSnapshot(card, patches.find((entry) => entry.id === card.id)?.patch),
          })),
          views: [{ id: view.id, patch: { fields: { cardOrder: view.fields.cardOrder } } }],
        })
        await refreshAfterCommand()
      },
      redo: async () => {
        await batchPatchProjectBoard(boardId, {
          cards: patches,
          views: [{ id: view.id, patch: { fields: { cardOrder } } }],
        })
        await refreshAfterCommand()
      },
    })
    await refreshAfterCommand()
  }, [bundle, boardId, activeViewId, undoStack, refreshAfterCommand])

  const applyProperties = useCallback(async (properties: ProjectProperty[], deletedIds: string[] = []) => {
    if (!bundle) return
    const previous = bundle.properties
    const epoch = boardEpoch.current
    const nextIds = new Set(properties.map((property) => property.id))
    const removedIds = [...new Set([
      ...previous.filter((property) => !nextIds.has(property.id)).map((property) => property.id),
      ...deletedIds,
    ])]
    const deletedValuePatches = removedIds.length
      ? bundle.cards.flatMap((card) => {
          const values = Object.fromEntries(removedIds.flatMap((id) => id in card.values ? [[id, card.values[id]!] as const] : []))
          return Object.keys(values).length ? [{ id: card.id, patch: { values } }] : []
        })
      : []
    const result = await patchProjectBoard(boardId, { updatedCardProperties: properties, deletedCardProperties: removedIds, propertyRevision: bundle.propertyRevision })
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, result.propertyRevision), properties: result.properties, propertyRevision: result.propertyRevision } : current)
    let revision = result.propertyRevision
    const previousIds = new Set(previous.map((property) => property.id))
    const undoDeletedIds = result.properties.filter((property) => !previousIds.has(property.id)).map((property) => property.id)
    undoStack.push({
      undo: async () => {
        const restored = await patchProjectBoard(boardId, { updatedCardProperties: previous, deletedCardProperties: undoDeletedIds, propertyRevision: revision })
        revision = restored.propertyRevision
        for (let at = 0; at < deletedValuePatches.length; at += PROJECT_LIMITS.batchOperations) {
          await batchPatchProjectBoard(boardId, { cards: deletedValuePatches.slice(at, at + PROJECT_LIMITS.batchOperations) })
        }
        await refreshAfterCommand()
      },
      redo: async () => {
        const reapplied = await patchProjectBoard(boardId, { updatedCardProperties: properties, deletedCardProperties: removedIds, propertyRevision: revision })
        revision = reapplied.propertyRevision
        await refreshAfterCommand()
      },
    })
  }, [bundle, boardId, undoStack, refreshAfterCommand])

  const addGroupOption = useCallback(async (propertyId: string, value: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: [...property.options, { id: newProjectId('property'), value, color: '' }] }
      : property))
    await applyProperties(properties)
  }, [bundle, applyProperties])

  // Renaming a column renames the option, so every card wearing it and every other view of it agree.
  const renameGroupOption = useCallback(async (propertyId: string, optionId: string, value: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: property.options.map((option) => (option.id === optionId ? { ...option, value } : option)) }
      : property))
    await applyProperties(properties)
  }, [bundle, applyProperties])

  const setGroupOptionColor = useCallback(async (propertyId: string, optionId: string, color: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: property.options.map((option) => (option.id === optionId ? { ...option, color } : option)) }
      : property))
    await applyProperties(properties)
  }, [bundle, applyProperties])

  const setIcon = useCallback(async (icon: string) => {
    const previous = bundle?.board.icon ?? ''
    const epoch = boardEpoch.current
    await useProjectStore.getState().setBoardIcon(boardId, icon)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, Date.now()), board: { ...current.board, icon } } : current)
    undoStack.push({
      undo: async () => { await useProjectStore.getState().setBoardIcon(boardId, previous); await refreshAfterCommand() },
      redo: async () => { await useProjectStore.getState().setBoardIcon(boardId, icon); await refreshAfterCommand() },
    })
  }, [boardId, bundle, undoStack, refreshAfterCommand])

  const addView = useCallback(async (viewType: ProjectViewType) => {
    const epoch = boardEpoch.current
    const view = await createProjectView(boardId, viewType)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, view.createAt), views: [...current.views, view] } : current)
    undoStack.push({
      undo: async () => { await deleteProjectView(view.id); await refreshAfterCommand() },
      redo: async () => { await undeleteProjectView(view.id); await refreshAfterCommand() },
    })
  }, [boardId, undoStack, refreshAfterCommand])

  const saveProps = useCallback(async (properties: ProjectProperty[], deletedIds: string[]) => {
    await applyProperties(properties, deletedIds)
  }, [applyProperties])

  const patchView = useCallback(async (viewId: string, patch: ProjectViewPatch) => {
    const previous = bundle?.views.find((view) => view.id === viewId)
    const epoch = boardEpoch.current
    const view = await patchProjectView(viewId, patch)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, view.updateAt), views: current.views.map((entry) => (entry.id === viewId ? view : entry)) } : current)
    if (previous) {
      undoStack.push({
        undo: async () => { await patchProjectView(viewId, viewPatchSnapshot(previous)); await refreshAfterCommand() },
        redo: async () => { await patchProjectView(viewId, patch); await refreshAfterCommand() },
      })
    }
  }, [bundle, boardId, undoStack, refreshAfterCommand])

  const removeView = useCallback(async (viewId: string) => {
    const ok = await confirm({ title: t('project.view.delete'), tone: 'danger', confirmLabel: t('common.delete') })
    if (!ok) return
    const previous = bundle?.views.find((view) => view.id === viewId)
    const epoch = boardEpoch.current
    await deleteProjectView(viewId)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, Date.now()), views: current.views.filter((entry) => entry.id !== viewId) } : current)
    if (previous) {
      undoStack.push({
        undo: async () => { await undeleteProjectView(viewId); await refreshAfterCommand() },
        redo: async () => { await deleteProjectView(viewId); await refreshAfterCommand() },
      })
    }
  }, [bundle, boardId, undoStack, refreshAfterCommand])

  const copyView = useCallback(async (viewId: string) => {
    const epoch = boardEpoch.current
    const view = await duplicateProjectView(viewId)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, view.createAt), views: [...current.views, view] } : current)
    undoStack.push({
      undo: async () => { await deleteProjectView(view.id); await refreshAfterCommand() },
      redo: async () => { await undeleteProjectView(view.id); await refreshAfterCommand() },
    })
  }, [boardId, undoStack, refreshAfterCommand])

  const guard = useCallback((action: () => Promise<void>): Promise<void> => {
    return action().catch((reason: unknown) => {
      useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
    })
  }, [])
  const guardedPatchCard = useCallback((id: string, patch: Record<string, unknown>) => guard(() => patchCard(id, patch)), [guard, patchCard])
  const guardedPatchCardsBatch = useCallback((patches: { id: string, patch: Record<string, unknown> }[]) => guard(() => patchCardsBatch(patches)), [guard, patchCardsBatch])
  const guardedDeleteCard = useCallback((id: string) => guard(() => removeCard(id)), [guard, removeCard])
  const runUndo = useCallback(() => guard(async () => { await undoStack.undo() }), [guard, undoStack])
  const runRedo = useCallback(() => guard(async () => { await undoStack.redo() }), [guard, undoStack])
  const duplicateOpenCard = useCallback(() => guard(async () => {
    if (!openCardId) return
    const epoch = boardEpoch.current
    const copy = await duplicateProjectCard(openCardId)
    if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
    undoStack.push({
      undo: async () => { await deleteProjectCard(copy.id); await refreshAfterCommand() },
      redo: async () => { await undeleteProjectCard(copy.id); await refreshAfterCommand() },
    })
    await refreshAfterCommand()
  }), [guard, boardId, openCardId, undoStack, refreshAfterCommand])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      const currentCard = bundle?.cards.find((card) => card.id === openCardId)
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) void runRedo(); else void runUndo() }
      else if (mod && key === 'y') { event.preventDefault(); void runRedo() }
      else if (mod && key === 'd' && openCardId && !document.querySelector('[role="dialog"], [role="menu"]')) { event.preventDefault(); void duplicateOpenCard() }
      else if ((event.key === 'Delete' || event.key === 'Backspace') && openCardId) {
        event.preventDefault()
        if (currentCard && !document.querySelector('[role="dialog"], [role="menu"]')) void removeCard(openCardId)
        else if (!currentCard) setOpenCardId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openCardId, bundle, removeCard, runUndo, runRedo, duplicateOpenCard])

  if (status === 'loading') return <LoadingBlock />
  if (status === 'notfound') return <Empty art="select" title={t('project.board.not_found')} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  if (status === 'error' || !bundle) {
    return <Empty art="select" title={t('project.board.load_failed')} description={error ?? undefined} action={<div className="flex flex-wrap justify-center gap-2"><Button variant="primary" onClick={retryBoard}>{t('project.common.retry')}</Button><Button variant="ghost" onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button></div>} />
  }

  const canEdit = !usingCachedBundle && projectRoleAtLeast(bundle.role, 'editor')
  const isOwner = bundle.board.ownerId === currentUserId
  const openCard = bundle.cards.find((card) => card.id === openCardId) ?? null

  return (
    <div className="flex h-full w-full min-w-0 bg-[var(--bg-base)]" data-project-board-page={boardId}>
      {sidebarOpen && <ProjectSidebar boards={boards} onImport={() => setShowImport(true)} />}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {usingCachedBundle && (
          <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <CloudOff size={15} aria-hidden="true" />
            <span className="font-medium">{t('project.offline.cached_title')}</span>
            <span>{t('project.offline.cached_description')}</span>
            <Button size="sm" variant="ghost" onClick={retryBoard}>{t('project.common.retry')}</Button>
          </div>
        )}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
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
          <button type="button" aria-label={t('project.board.change_icon')} disabled={!canEdit} className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[length:var(--text-14)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50" onClick={() => setIconOpen(true)}>
            {headerIcon || <SquareKanban size={16} className="text-[var(--accent-on-soft)]" />}
          </button>
          <h1 className="min-w-0 truncate text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
            {headerTitle}
          </h1>
          {onlineUserIds.length > 0 && (
            <div
              className="flex shrink-0 items-center -space-x-2"
              role="status"
              aria-label={t('project.presence.label', { count: onlineUserIds.length })}
            >
              {onlineUserIds.slice(0, 4).map((userId) => (
                <span key={userId} title={projectPersonLabel(bundle.people, userId)} className="rounded-full ring-2 ring-[var(--bg-elevated)]">
                  <Avatar src={bundle.people[userId]?.avatarUrl} name={projectPersonLabel(bundle.people, userId)} size={22} />
                </span>
              ))}
              {onlineUserIds.length > 4 && (
                <span className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[var(--bg-sunken)] px-1 text-[length:var(--text-10)] text-[var(--text-secondary)] ring-2 ring-[var(--bg-elevated)]">
                  +{onlineUserIds.length - 4}
                </span>
              )}
            </div>
          )}
          {pendingWrites > 0 && (
            <span role="status" className="shrink-0 rounded-[var(--r-sm)] bg-[var(--accent-soft)] px-2 py-1 text-[length:var(--text-11)] text-[var(--text-secondary)]">
              {t('project.offline.pending', { count: pendingWrites })}
            </span>
          )}
          {conflicts.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setShowConflicts(true)}>
              <AlertTriangle size={14} className="text-[var(--danger)]" aria-hidden="true" />
              {t('project.offline.conflicts_badge', { count: conflicts.length })}
            </Button>
          )}
          <span className="ml-auto shrink-0 text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {bundle.cardsHasMore
              ? t('project.board.cards_loaded', { loaded: bundle.cards.length, total: bundle.cardCount ?? bundle.cards.length })
              : t('project.board.cards_count', { count: bundle.cardCount ?? bundle.cards.length })}
          </span>
          {bundle.cardsHasMore && (
            <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void loadMoreCards()}>
              {loadingMore ? t('common.loading') : t('project.board.load_more')}
            </Button>
          )}
          {cardsError && (
            <span role="alert" className="flex shrink-0 items-center gap-1 text-[length:var(--text-11)] text-[var(--danger)]">
              {t('project.common.load_failed')}
              <Button size="sm" variant="ghost" onClick={() => void loadMoreCards()}>{t('project.common.retry')}</Button>
            </span>
          )}
          {canEdit && (
            <IconButton label={t('project.props.title')} size="sm" onClick={() => setShowProps(true)}>
              <Settings2 size={16} />
            </IconButton>
          )}
          {bundle.role === 'admin' && (
            <IconButton label={t('project.members.title')} size="sm" onClick={() => setShowMembers(true)}>
              <Users size={16} />
            </IconButton>
          )}
          {isOwner && (
            <IconButton label={t('project.share.title')} size="sm" onClick={() => setShowShare(true)}>
              <Share2 size={16} />
            </IconButton>
          )}
          {boardWatch.status === 'error' && !usingCachedBundle && (
            <span role="alert" className="flex items-center gap-1">
              <span className="sr-only text-[length:var(--text-11)] text-[var(--danger)] xl:not-sr-only">{t('project.common.load_failed')}</span>
              <Button size="sm" variant="ghost" onClick={boardWatch.retry}>{t('project.common.retry')}</Button>
            </span>
          )}
          <IconButton label={boardWatch.watching ? t('project.watch.off') : t('project.watch.on')} size="sm" active={boardWatch.watching} disabled={boardWatch.status !== 'ready'} onClick={() => { void boardWatch.toggle() }}><Bell size={16} /></IconButton>
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
            disabled={!canEdit || busy}
            placeholder={t('project.board.card_placeholder')}
            aria-label={t('project.board.card_placeholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!canEdit || busy || !title.trim()} icon={<Plus size={15} />}>
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
                void createCardFromTemplate(boardId, templateId)
                  .then((card) => setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, card.createAt), cards: [...current.cards, card] } : current))
                  .catch((reason: unknown) => { useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' }) })
              }}
              options={bundle.cards.filter((card) => card.isTemplate).map((card) => ({ value: card.id, label: card.title }))}
            />
          )}
        </form>
      )}
      <BoardViews
        bundle={bundle}
        canEdit={canEdit}
        onDeleteCard={guardedDeleteCard}
        onCreateView={(type) => guard(() => addView(type))}
        onOpenCard={setOpenCardId}
        onPatchView={patchView}
        onDeleteView={(id) => guard(() => removeView(id))}
        onDuplicateView={(id) => guard(() => copyView(id))}
        onActiveViewChange={setActiveViewId}
        onPatchCard={guardedPatchCard}
        onPatchCardsBatch={guardedPatchCardsBatch}
        onDragCards={dragCards}
        onAddGroupOption={addGroupOption}
        onRenameGroupOption={renameGroupOption}
        onSetGroupOptionColor={setGroupOptionColor}
        onCardCreated={(card) => setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, card.createAt), cards: [...current.cards, card] } : current)}
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
          canManageVisibility={isOwner}
          onClose={() => setShowMembers(false)}
          onBoardPatched={(patch) => guard(async () => {
            const result = await patchProjectBoard(boardId, patch)
            setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, result.board.updateAt), board: result.board } : current)
          })}
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
          {activityStatus === 'loading'
            ? <LoadingBlock />
            : activityStatus === 'error'
              ? (
                  <div role="alert" className="flex flex-wrap items-center gap-2 text-[length:var(--text-12)] text-[var(--danger)]">
                    {t('project.boards.load_failed')}
                    <Button size="sm" variant="ghost" onClick={openActivity}>{t('project.common.retry')}</Button>
                  </div>
                )
              : (
                <ul className="space-y-2">
                  {activity.map((entry) => {
                    const verb = ACTIVITY_VERB[entry.type]
                    const target = bundle.cards.find((card) => card.id === entry.targetId)
                    return (
                      <li key={entry.id} className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                        <span className="text-[var(--text-tertiary)]">{new Date(entry.createdAt).toLocaleString(locale)}</span> — {verb
                          ? `${t(verb)}${target ? ` ${target.title || t('project.board.untitled_card')}` : ''}`
                          : entry.summary}
                      </li>
                    )
                  })}
                  {activity.length === 0 && <li className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('project.value.empty')}</li>}
                </ul>
              )}
        </Modal>
      )}
      {showConflicts && (
        <ProjectConflictsDialog items={conflicts} onDiscard={(item) => void discardConflict(item)} onClose={() => setShowConflicts(false)} />
      )}
      {openCard && (
        <CardDialog
          key={openCard.id}
          card={openCard}
          properties={bundle.properties}
          members={bundle.members}
          people={bundle.people}
          contents={bundle.contents.filter((content) => content.cardId === openCard.id)}
          siblings={bundle.cards}
          canEdit={canEdit}
          detailTruncated={Boolean(bundle.contentsTruncated || bundle.commentsTruncated || detailCardId === openCardId)}
          onClose={() => setOpenCardId(null)}
          onDelete={(id) => void removeCard(id)}
          onUpdated={(updated) => setBundle((current) => current ? { ...current, cursor: Math.max(current.cursor, updated.updateAt), cards: current.cards.map((card) => (card.id === updated.id ? updated : card)) } : current)}
          onRefresh={() => { void refresh().catch((reason: unknown) => { useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' }) }) }}
          onOpenCard={setOpenCardId}
          onPatchCard={patchCard}
          onCommand={(command) => undoStack.push(command)}
        />
      )}
    </div>
  )
}