import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import { ArrowLeft, Pin, X } from 'lucide-react'
import type { MemoVisibility } from '@shared/memos/types'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { Empty, LoadingBlock } from '../../../components/feedback'
import { TagChip } from '../../../components/TagChip'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { fullTime } from '../../../lib/time'
import { parseMemoOutline } from '../memo-outline'
import { memoTagRuleBlursContent, memoTagRulesByTag } from '../tag-rules'
import { useMemos } from '../state'
import { useMemoPreferences } from '../use-memo-preferences'
import { useMemoTaskToggle } from '../use-memo-task-toggle'
import { MemoAttachments } from './MemoAttachments'
import { MemoCardActions } from './MemoCardActions'
import { MemoComments } from './MemoComments'
import { MemoComposer } from './MemoComposer'
import { MemoMaskedBody } from './MemoMaskedBody'
import { MemoReactions } from './MemoReactions'
import { MemoRelations } from './MemoRelations'

const VISIBILITY_KEYS: Record<MemoVisibility, MessageKey> = {
  private: 'memos.visibility.private',
  protected: 'memos.visibility.protected',
  public: 'memos.visibility.public',
}

const VISIBILITY_TONES: Record<MemoVisibility, 'neutral' | 'accent' | 'warning'> = {
  private: 'neutral',
  protected: 'warning',
  public: 'accent',
}

const OUTLINE_INDENT: Record<number, string> = {
  1: 'pl-1.5',
  2: 'pl-4',
  3: 'pl-6',
}

export interface MemoDetailProps {
  memoId: string
  spaceName: string | null
  isNew: boolean
  embedded?: boolean
  onClose: () => void
  onOpen: (id: string) => void
  onTagPress: (tag: string) => void
}

export function MemoDetail({
  memoId,
  spaceName,
  isNew,
  embedded = false,
  onClose,
  onOpen,
  onTagPress,
}: MemoDetailProps): ReactElement {
  const detail = useMemos((state) => state.detail)
  const status = useMemos((state) => state.detailStatus)
  const error = useMemos((state) => state.detailError)
  const preferences = useMemoPreferences()
  const [editing, setEditing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const memo = detail?.id === memoId ? detail : null
  const outline = useMemo(() => (memo ? parseMemoOutline(memo.content) : []), [memo?.content])
  const onToggleTask = useMemoTaskToggle(memo)
  const ruleByTag = useMemo(
    () => memoTagRulesByTag(memo?.tags ?? [], preferences.preferences.tagRules),
    [memo?.tags, preferences.preferences.tagRules],
  )
  const blurred = memo ? memoTagRuleBlursContent(memo.tags, preferences.preferences.tagRules) : false

  useEffect(() => {
    void useMemos.getState().openDetail(memoId)
    return () => {
      if (useMemos.getState().selectedId === memoId) void useMemos.getState().openDetail(null)
    }
  }, [memoId])

  useEffect(() => {
    setEditing(false)
  }, [memoId])

  const jumpToHeading = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const root = scrollRef.current
    if (!root) return
    const heading = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
      .find((element) => element.id === id)
    if (!heading) return
    event.preventDefault()
    heading.focus({ preventScroll: true })
    heading.scrollIntoView({ block: 'start' })
  }

  const toolbar = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] px-2">
      <IconButton
        label={embedded ? t('memos.header.close_detail') : t('memos.detail.back')}
        size="sm"
        onClick={onClose}
      >
        {embedded ? <X size={15} /> : <ArrowLeft size={15} />}
      </IconButton>
      <span className="min-w-0 truncate text-[length:var(--text-12-5)] font-medium text-[var(--text-secondary)]">
        {t('memos.detail.title')}
      </span>
    </div>
  )

  let content: ReactElement
  if (!memo && (status === 'loading' || status === 'idle')) {
    content = <LoadingBlock label={t('memos.common.loading')} />
  } else if (!memo && status === 'error') {
    content = (
      <Empty
        art="notes"
        title={t('memos.detail.error')}
        description={error ?? t('memos.feed.error_description')}
        action={(
          <Button size="sm" onClick={() => void useMemos.getState().openDetail(memoId)}>
            {t('memos.common.retry')}
          </Button>
        )}
      />
    )
  } else if (!memo) {
    content = <Empty art="search" title={t('memos.detail.error')} description={t('memos.feed.error_description')} />
  } else {
    const createdMs = memo.createdAt * 1000
    const updatedMs = memo.updatedAt * 1000
    content = (
      <article className="mx-auto w-full max-w-[760px] px-4 py-4">
        <h2 className="sr-only">{t('memos.detail.title')}</h2>
        <header className="flex flex-wrap items-center gap-1.5">
          <time
            dateTime={new Date(createdMs).toISOString()}
            title={t('memos.card.created_at', { time: fullTime(createdMs) })}
            className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]"
          >
            {fullTime(createdMs)}
          </time>
          {memo.pinned ? (
            <span role="img" aria-label={t('memos.card.pinned')} className="shrink-0 text-[var(--accent)]">
              <Pin size={12} />
            </span>
          ) : null}
          {isNew ? <Badge tone="accent">{t('memos.card.new')}</Badge> : null}
          <Badge tone={VISIBILITY_TONES[memo.visibility]}>{t(VISIBILITY_KEYS[memo.visibility])}</Badge>
          {spaceName ? <Badge>{spaceName}</Badge> : null}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <MemoCardActions
              memo={memo}
              onEdit={memo.state === 'normal' ? () => setEditing(true) : undefined}
              onDeleted={onClose}
            />
          </div>
        </header>
        {updatedMs !== createdMs ? (
          <p className="mt-0.5 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
            {t('memos.card.updated_at', { time: fullTime(updatedMs) })}
          </p>
        ) : null}
        {memo.state === 'archived' ? (
          <p role="status" className="mt-2 rounded-[var(--r-sm)] bg-[var(--bg-raised)] px-2 py-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {t('memos.card.archived_notice')}
          </p>
        ) : null}
        {!editing && outline.length > 1 ? (
          <nav
            aria-label={t('memos.detail.outline')}
            className="mt-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-raised)] px-2 py-1.5"
          >
            <ul className="space-y-px">
              {outline.map((entry) => (
                <li key={entry.id}>
                  <a
                    href={`#${entry.id}`}
                    onClick={(event) => jumpToHeading(event, entry.id)}
                    className={cn(
                      'flex min-h-8 min-w-0 items-center truncate rounded-[var(--r-xs)] pr-1.5 text-[length:var(--text-11-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-7',
                      OUTLINE_INDENT[entry.level],
                    )}
                  >
                    {entry.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        {editing ? (
          <div className="mt-3">
            <MemoComposer memo={memo} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
          </div>
        ) : (
          <MemoMaskedBody
            key={`${memo.id}:${blurred ? 'blurred' : 'clear'}`}
            content={memo.content}
            tagRules={preferences.preferences.tagRules}
            blurred={blurred && memo.content.trim() !== ''}
            onTagPress={onTagPress}
            onToggleTask={onToggleTask}
            className="mt-3"
          />
        )}
        <MemoAttachments attachments={memo.attachments} className="mt-3" />
        {memo.tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            {memo.tags.map((tag) => (
              <TagChip
                key={tag}
                label={tag}
                sigil
                color={ruleByTag.get(tag)?.backgroundColor ?? null}
                onPress={() => onTagPress(tag)}
                ariaLabel={t('memos.card.filter_tag', { tag })}
              />
            ))}
          </div>
        ) : null}
        <div className="mt-3 border-t border-[var(--border-subtle)] pt-2">
          <MemoReactions
            memo={memo}
            reactions={preferences.preferences.reactions}
            readOnly={memo.state === 'archived'}
          />
        </div>
        <div className="mt-3">
          <MemoRelations memo={memo} onOpen={onOpen} />
        </div>
        <div className="mt-3">
          <MemoComments
            memoId={memo.id}
            initialCount={memo.commentCount}
            disabled={memo.state === 'archived'}
            onTagPress={onTagPress}
          />
        </div>
      </article>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-memo-detail={embedded ? 'panel' : 'page'}>
      {toolbar}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">{content}</div>
    </div>
  )
}
