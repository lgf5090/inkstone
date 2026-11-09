import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ArrowLeft, FileDown, History, Plus, Settings2, Share2, SquareKanban } from 'lucide-react'
import type { ProjectActivityEntry, ProjectBoardBundle, ProjectProperty, ProjectViewPatch, ProjectViewType } from '@shared/project/model'
import { projectRoleAtLeast, emptyProjectViewFields } from '@shared/project/model'
import { projectFilterPrefill } from '@shared/project/view-eval'
import { buildProjectAssistantFacts } from '@shared/project/assistant-context'
import { t } from '../../lib/i18n'
import { navigateToPath } from '../../lib/app-history'
import { useAssistant } from '../chat/assistant-store'
import { useUi } from '../../store/ui'
import { Button, IconButton } from '../../components/primitives'
import { Input, Select } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { confirm, Modal } from '../../components/overlay'
import { createCardFromTemplate, createProjectCard, createProjectView, deleteProjectCard, deleteProjectView, duplicateProjectView, fetchBoardActivity, fetchProjectBoardBundle, patchProjectBoard, patchProjectCard, patchProjectView } from './api'
import { newProjectId } from '@shared/project/limits'
import { BoardViews } from './BoardViews'
import { BoardPropertiesDialog } from './BoardPropertiesDialog'
import { CardDialog } from './CardDialog'
import { ShareDialog } from './ShareDialog'

type Status = 'loading' | 'ready' | 'error' | 'notfound'

export function BoardPage({ boardId }: { boardId: string }): ReactElement {
  const [bundle, setBundle] = useState<ProjectBoardBundle | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)
  const [activeViewId, setActiveViewId] = useState<string | null>(null)
  const [showProps, setShowProps] = useState(false)
  const [showShare, setShowShare] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([])

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('card')
    if (id) setOpenCardId(id)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('inkstone.project.lastBoard', boardId)
    } catch { /* best-effort: remembering the last board is optional */
    }
  }, [boardId])

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
    const timer = window.setInterval(() => {
      fetchProjectBoardBundle(boardId, controller.signal)
        .then((fresh) => setBundle(fresh))
        .catch(() => { /* best-effort convergence poll: a failed refetch keeps the last good bundle */ return undefined })
    }, 30_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [boardId])

  useEffect(() => {
    if (!bundle) return
    const store = useAssistant.getState()
    store.setDockSurface('project')
    store.setProjectContext({
      surface: 'project',
      label: bundle.board.title || t('project.boards.untitled'),
      facts: buildProjectAssistantFacts(bundle, bundle.views[0]?.fields ?? emptyProjectViewFields()),
    })
    return () => { useAssistant.getState().setProjectContext(null) }
  }, [bundle])

  const addCard = useCallback(async () => {
    const trimmed = title.trim()
    if (!trimmed || busy || !bundle) return
    setBusy(true)
    try {
      const values = projectFilterPrefill(bundle.views.find((view) => view.id === activeViewId)?.fields.filter)
      const card = await createProjectCard(boardId, { title: trimmed, values })
      setBundle((current) => (current ? { ...current, cards: [...current.cards, card] } : current))
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
  }, [])

  const patchCard = useCallback(async (id: string, patch: Record<string, unknown>) => {
    const updated = await patchProjectCard(id, patch)
    setBundle((current) => (current ? { ...current, cards: current.cards.map((card) => (card.id === id ? updated : card)) } : current))
  }, [])

  const addGroupOption = useCallback(async (propertyId: string, value: string) => {
    if (!bundle) return
    const properties = bundle.properties.map((property) => (property.id === propertyId
      ? { ...property, options: [...property.options, { id: newProjectId('property'), value, color: '' }] }
      : property))
    const result = await patchProjectBoard(boardId, { updatedCardProperties: properties })
    setBundle((current) => (current ? { ...current, properties: result.properties } : current))
  }, [bundle, boardId])

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

  if (status === 'loading') return <LoadingBlock />
  if (status === 'notfound') return <Empty art="select" title={t('project.board.not_found')} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  if (status === 'error' || !bundle) {
    return <Empty art="select" title={t('project.board.load_failed')} description={error ?? undefined} action={<Button onClick={() => navigateToPath('/project')}>{t('project.board.back')}</Button>} />
  }

  const canEdit = projectRoleAtLeast(bundle.role, 'editor')
  const openCard = bundle.cards.find((card) => card.id === openCardId) ?? null
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-project-board-page={boardId}>
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <IconButton label={t('project.board.back')} size="sm" onClick={() => navigateToPath('/project')}>
          <ArrowLeft size={16} />
        </IconButton>
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[length:var(--text-14)]">
          {bundle.board.icon || <SquareKanban size={16} className="text-[var(--accent-on-soft)]" />}
        </span>
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
          <IconButton label={t('project.share.title')} size="sm" onClick={() => setShowShare(true)}>
            <Share2 size={16} />
          </IconButton>
        )}
        <IconButton label={t('project.board.activity')} size="sm" onClick={openActivity}><History size={16} /></IconButton>
        <IconButton label={t('project.board.export_md')} size="sm" onClick={exportMarkdown}><FileDown size={16} /></IconButton>
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
            <Select
              className="w-36"
              value=""
              aria-label={t('project.card.from_template')}
              onChange={(event) => {
                const templateId = event.target.value
                if (!templateId) return
                void createCardFromTemplate(boardId, templateId).then((card) => setBundle((current) => (current ? { ...current, cards: [...current.cards, card] } : current)))
              }}
            >
              <option value="">{t('project.card.from_template')}</option>
              {bundle.cards.filter((card) => card.isTemplate).map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}
            </Select>
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
      />
      {showProps && (
        <BoardPropertiesDialog
          boardId={boardId}
          properties={bundle.properties}
          onClose={() => setShowProps(false)}
          onSave={saveProps}
        />
      )}
      {showShare && <ShareDialog boardId={boardId} onClose={() => setShowShare(false)} />}
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
        />
      )}
    </div>
  )
}