/**
 * A shared board, as a stranger reads it.
 *
 * The slug and the passcode are the whole capability — there is no session on this page, so every byte
 * comes from the one public answer. The board is drawn by the same views a member sees with editing
 * off, rather than by a second renderer that could drift from what the owner previewed; the member-only
 * reads (dependencies, exports, attachments) are not offered because they would answer 401.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Lock, SquareKanban } from 'lucide-react'
import type { ProjectBoardBundle, ProjectCard } from '@shared/project/model'
import { projectPropertyDisplayText } from '@shared/project/view-eval'
import { t } from '../../lib/i18n'
import { ApiError } from '../../lib/api'
import { Button } from '../../components/primitives'
import { Input } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { Modal } from '../../components/overlay'
import { readPublicProjectBoard } from './api'
import { BoardViews } from './BoardViews'

type ReadState = 'loading' | 'ready' | 'locked' | 'throttled' | 'gone'

export function ProjectSharePage({ slug }: { slug: string }): ReactElement {
  const [bundle, setBundle] = useState<ProjectBoardBundle | null>(null)
  const [state, setState] = useState<ReadState>('loading')
  const [password, setPassword] = useState('')
  const [wrongPasscode, setWrongPasscode] = useState(false)
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  const load = useCallback(async (passcode: string) => {
    setState('loading')
    try {
      setBundle(await readPublicProjectBoard(slug, passcode || undefined))
      setState('ready')
    } catch (error) {
      // A refusal is the passcode's answer, not a broken page: the server hands over no board at all
      // until the gate is passed, so treating it as "gone" would hide the one control that gets in.
      if (error instanceof ApiError && error.status === 401) {
        setState('locked')
        setWrongPasscode(passcode.length > 0)
        return
      }
      setState(error instanceof ApiError && error.status === 429 ? 'throttled' : 'gone')
    }
  }, [slug])

  useEffect(() => { void load('') }, [load])

  if (state === 'loading') return <LoadingBlock />

  if (state === 'locked') {
    return (
      <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center gap-4 px-6">
        <h1 className="flex items-center gap-2 text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          <Lock size={16} aria-hidden="true" />{t('project.share.page_locked_title')}
        </h1>
        <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('project.share.page_locked_desc')}</p>
        <form className="flex flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void load(password) }}>
          <Input
            type="password"
            value={password}
            aria-label={t('project.share.password')}
            autoComplete="current-password"
            invalid={wrongPasscode}
            onChange={(event) => setPassword(event.target.value)}
          />
          {wrongPasscode && <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">{t('project.share.page_wrong_passcode')}</p>}
          <Button type="submit" variant="primary" disabled={password.length === 0}>{t('project.share.page_enter')}</Button>
        </form>
      </main>
    )
  }

  if (state !== 'ready' || !bundle) {
    return (
      <main className="mx-auto flex min-h-screen max-w-[640px] flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-[length:var(--text-18)] font-semibold text-[var(--text-primary)]">
          {state === 'throttled' ? t('project.share.page_throttled') : t('project.share.page_gone_title')}
        </h1>
        <p className="text-[length:var(--text-13)] text-[var(--text-tertiary)]">{t('project.share.page_gone_desc')}</p>
      </main>
    )
  }

  const openCard = bundle.cards.find((card) => card.id === openCardId) ?? null
  return (
    <main className="flex h-screen flex-col bg-[var(--bg-base)]" data-project-public-board={bundle.board.id}>
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[var(--r-md)] bg-[var(--accent-soft)] text-[length:var(--text-14)]">
          {bundle.board.icon || <SquareKanban size={16} className="text-[var(--accent-on-soft)]" />}
        </span>
        <h1 className="min-w-0 truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">
          {bundle.board.title || t('project.boards.untitled')}
        </h1>
        <span className="ml-auto shrink-0 rounded-[var(--r-sm)] bg-[var(--bg-hover)] px-1.5 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
          {t('project.share.page_readonly')}
        </span>
      </header>
      <BoardViews
        bundle={bundle}
        canEdit={false}
        publicView
        onDeleteCard={() => {}}
        onCreateView={() => {}}
        onOpenCard={setOpenCardId}
        onPatchView={async () => {}}
        onDeleteView={() => {}}
        onDuplicateView={() => {}}
        onActiveViewChange={() => {}}
        onPatchCard={async () => {}}
        onAddGroupOption={async () => {}}
        onRenameGroupOption={async () => {}}
        onSetGroupOptionColor={async () => {}}
        onRefresh={async () => {}}
      />
      {openCard && <PublicCardDetail card={openCard} bundle={bundle} onClose={() => setOpenCardId(null)} />}
    </main>
  )
}
function PublicCardDetail({ card, bundle, onClose }: { card: ProjectCard, bundle: ProjectBoardBundle, onClose: () => void }): ReactElement {
  const parent = card.parentId ? bundle.cards.find((entry) => entry.id === card.parentId) : undefined
  const blocks = bundle.contents.filter((block) => block.cardId === card.id)
  const comments = bundle.comments.filter((comment) => comment.cardId === card.id)
  return (
    <Modal open onClose={onClose} title={card.title || t('project.board.untitled_card')} width={560}>
      <div className="space-y-4">
        {parent && (
          <p className="text-[length:var(--text-12)] text-[var(--text-tertiary)]">
            {t('project.card.subtasks')} · {parent.title || t('project.board.untitled_card')}
          </p>
        )}
        <section aria-label={t('project.card.properties')} className="space-y-1.5">
          {bundle.properties.map((property) => (
            <div key={property.id} className="flex items-start gap-3 text-[length:var(--text-13)]">
              <span className="w-28 shrink-0 text-[var(--text-secondary)]">{property.name}</span>
              <span className="min-w-0 flex-1 text-[var(--text-primary)]">{projectPropertyDisplayText(card, property) || '—'}</span>
            </div>
          ))}
        </section>
        {blocks.length > 0 && (
          <section aria-label={t('project.card.content')} className="space-y-2">
            {blocks.map((block) => (
              <div key={block.id} className="text-[length:var(--text-13)] text-[var(--text-primary)]">
                {block.type === 'divider'
                  ? <hr className="border-[var(--border-subtle)]" />
                  : block.type === 'image' || block.type === 'attachment'
                    ? <p className="text-[var(--text-tertiary)]">{block.title} — {t('project.share.page_file_unavailable')}</p>
                    : <p className="whitespace-pre-wrap">{block.type === 'checkbox' ? `${block.fields.checked === true ? '☑' : '☐'} ` : ''}{block.title}</p>}
              </div>
            ))}
          </section>
        )}
        {comments.length > 0 && (
          <section aria-label={t('project.card.comments')} className="space-y-2">
            {comments.map((comment) => (
              <div key={comment.id} className="rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2">
                <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{new Date(comment.createAt).toLocaleDateString()}</p>
                <p className="whitespace-pre-wrap text-[length:var(--text-13)] text-[var(--text-primary)]">{comment.body}</p>
              </div>
            ))}
          </section>
        )}
      </div>
    </Modal>
  )
}
