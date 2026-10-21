import { useEffect, useRef, useState, type ReactElement } from 'react'
import { SmilePlus } from 'lucide-react'
import { MEMO_DEFAULT_REACTIONS } from '@shared/memos/constants'
import type { Memo, MemoReactionSummary } from '@shared/memos/types'
import { IconButton } from '../../../components/primitives'
import { Menu, type MenuItem } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { memosApi } from '../api'
import { memoErrorMessage } from '../errors'
import { bump } from '../events'

export interface MemoReactionsProps {
  memo: Memo
  readOnly?: boolean
  reactions?: readonly string[]
  className?: string
}

function toggleReaction(
  current: MemoReactionSummary[],
  type: string,
  nextReacted: boolean,
): MemoReactionSummary[] {
  const index = current.findIndex((reaction) => reaction.type === type)
  if (index < 0) {
    return nextReacted ? [...current, { type, count: 1, reacted: true }] : current
  }
  const reaction = current[index]!
  const count = reaction.count + (nextReacted ? 1 : -1)
  if (count <= 0) return current.filter((_, position) => position !== index)
  const next = [...current]
  next[index] = { ...reaction, reacted: nextReacted, count }
  return next
}

export function MemoReactions({
  memo,
  readOnly = false,
  reactions: reactionChoices,
  className,
}: MemoReactionsProps): ReactElement | null {
  const [reactions, setReactions] = useState<MemoReactionSummary[]>(memo.reactions)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const pending = useRef(new Set<string>())
  const choices = reactionChoices && reactionChoices.length > 0
    ? [...new Set(reactionChoices)]
    : MEMO_DEFAULT_REACTIONS
  useEffect(() => {
    setReactions(memo.reactions)
  }, [memo.id, memo.reactions])

  if (readOnly && reactions.length === 0) return null

  const toggle = async (type: string, nextReacted: boolean): Promise<void> => {
    if (readOnly || pending.current.has(type)) return
    pending.current.add(type)
    const previous = reactions
    setReactions((current) => toggleReaction(current, type, nextReacted))
    try {
      const result = nextReacted
        ? await memosApi.reactions.upsert(memo.id, { type })
        : await memosApi.reactions.delete(memo.id, type)
      setReactions(result.reactions)
      bump('list')
      bump('detail')
    } catch (error) {
      setReactions(previous)
      useUi.getState().toast({
        title: t('memos.reactions.failed'),
        description: memoErrorMessage(error),
        tone: 'danger',
      })
    } finally {
      pending.current.delete(type)
    }
  }

  const items: MenuItem[] = choices.map((type) => ({
    id: `reaction-${type}`,
    label: t('memos.reactions.react_with', { emoji: type }),
    icon: <span className="text-[length:var(--text-14)]">{type}</span>,
    onSelect: () => {
      const existing = reactions.find((reaction) => reaction.type === type)
      void toggle(type, !(existing?.reacted ?? false))
    },
  }))

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {reactions.map((reaction) => {
        const label = t(reaction.reacted ? 'memos.reactions.remove' : 'memos.reactions.react_with', {
          emoji: reaction.type,
        })
        const shape = cn(
          'inline-flex min-h-10 items-center gap-1 rounded-full border px-2 text-[length:var(--text-11)] md:min-h-0 md:h-6',
          reaction.reacted
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
            : 'border-[var(--border-subtle)] text-[var(--text-secondary)]',
        )
        return readOnly ? (
          <span key={reaction.type} className={shape} aria-label={`${reaction.type} ${reaction.count}`}>
            <span aria-hidden="true">{reaction.type}</span>
            <span className="tabular text-[length:var(--text-10-5)]">{reaction.count}</span>
          </span>
        ) : (
          <button
            key={reaction.type}
            type="button"
            aria-pressed={reaction.reacted}
            aria-label={label}
            onClick={() => void toggle(reaction.type, !reaction.reacted)}
            className={cn(shape, 'transition-colors hover:bg-[var(--bg-hover)]')}
          >
            <span aria-hidden="true">{reaction.type}</span>
            <span className="tabular text-[length:var(--text-10-5)]">{reaction.count}</span>
          </button>
        )
      })}
      {!readOnly ? (
        <>
          <IconButton
            ref={anchorRef}
            label={t('memos.reactions.add')}
            size="sm"
            active={open}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <SmilePlus size={14} />
          </IconButton>
          <Menu
            anchor={anchorRef}
            open={open}
            onClose={() => setOpen(false)}
            items={items}
            label={t('memos.reactions.label')}
            width={210}
          />
        </>
      ) : null}
    </div>
  )
}
