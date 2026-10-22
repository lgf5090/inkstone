import { useEffect, useState, type ReactElement } from 'react'
import { CornerDownRight, Plus, X } from 'lucide-react'
import type { Memo, MemoRelation } from '@shared/memos/types'
import { Button, IconButton } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { memosApi, type MemoRelationsPair } from '../api'
import { memoErrorMessage } from '../errors'
import { useMemoResource } from '../use-resource'
import { MemoRelationPicker } from './MemoRelationPicker'

export interface MemoRelationsProps {
  memo: Memo
  onOpen: (id: string) => void
}

function RelationList({
  label,
  relations,
  onOpen,
  onRemove,
  removingId,
}: {
  label: string
  relations: MemoRelation[]
  onOpen: (id: string) => void
  onRemove?: (relation: MemoRelation) => void
  removingId?: string | null
}): ReactElement | null {
  if (relations.length === 0) return null
  return (
    <div>
      <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]">
        {label}
      </p>
      <ul className="mt-1 space-y-1">
        {relations.map((relation) => (
          <li key={`${relation.memoId}:${relation.relatedMemoId}`} className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => onOpen(relation.relatedMemoId)}
              className="flex min-h-10 w-full min-w-0 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 text-left text-[length:var(--text-11-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:min-h-0 md:h-7"
            >
              <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
              <span className="min-w-0 flex-1 truncate">{relation.relatedSnippet || relation.relatedMemoId}</span>
            </button>
            {onRemove ? (
              <IconButton
                label={t('memos.relations.remove', { name: relation.relatedSnippet || relation.relatedMemoId })}
                size="xs"
                disabled={removingId !== null}
                onClick={() => onRemove(relation)}
              >
                <X size={12} />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MemoRelations({ memo, onOpen }: MemoRelationsProps): ReactElement {
  const resource = useMemoResource((signal) => memosApi.relations.get(memo.id, signal), [memo.id, memo.rev])
  const [savedPair, setSavedPair] = useState<MemoRelationsPair | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const pair = savedPair ?? resource.data
  const outgoing = pair?.outgoing ?? []
  const incoming = pair?.incoming ?? []

  useEffect(() => {
    setSavedPair(null)
  }, [memo.id, memo.rev])

  const removeOutgoing = async (relation: MemoRelation): Promise<void> => {
    if (removingId) return
    const accepted = await confirm({
      title: t('memos.relations.remove_title'),
      description: t('memos.relations.remove_description'),
      confirmLabel: t('memos.relations.remove_confirm'),
      tone: 'danger',
    })
    if (!accepted) return
    setRemovingId(relation.relatedMemoId)
    setActionError(null)
    const remaining: string[] = []
    for (const outgoingRelation of outgoing) {
      if (outgoingRelation.relatedMemoId === relation.relatedMemoId) continue
      if (!remaining.includes(outgoingRelation.relatedMemoId)) remaining.push(outgoingRelation.relatedMemoId)
    }
    try {
      const next = await memosApi.relations.put(memo.id, remaining)
      setSavedPair(next)
    } catch (error) {
      setActionError(memoErrorMessage(error))
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <section className="border-t border-[var(--border-subtle)] pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
          {t('memos.relations.heading')}
        </h3>
        {pair ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-1.5"
            icon={<Plus size={12} />}
            onClick={() => setPickerOpen(true)}
          >
            {t('memos.relations.add')}
          </Button>
        ) : null}
      </div>
      {resource.status === 'loading' && pair === null ? (
        <div className="mt-1.5 space-y-1">
          <Skeleton className="h-5" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : null}
      {resource.status === 'error' && pair === null ? (
        <div className="mt-1.5">
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {resource.error ?? t('memos.relations.error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={resource.reload}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {pair && outgoing.length === 0 && incoming.length === 0 ? (
        <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('memos.relations.empty')}
        </p>
      ) : null}
      {pair ? (
        <div className="mt-1.5 space-y-2">
          <RelationList
            label={t('memos.relations.outgoing')}
            relations={outgoing}
            onOpen={onOpen}
            onRemove={(relation) => void removeOutgoing(relation)}
            removingId={removingId}
          />
          <RelationList
            label={t('memos.relations.incoming')}
            relations={incoming}
            onOpen={onOpen}
          />
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="mt-2 text-[length:var(--text-11)] text-[var(--danger)]">
          {actionError}
        </p>
      ) : null}
      {pickerOpen && pair ? (
        <MemoRelationPicker
          memo={memo}
          existingOutgoingIds={outgoing.map((relation) => relation.relatedMemoId)}
          onSaved={(next) => setSavedPair(next)}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </section>
  )
}
