import type { ReactElement } from 'react'
import { CornerDownRight } from 'lucide-react'
import type { Memo, MemoRelation } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Skeleton } from '../../../components/feedback'
import { t } from '../../../lib/i18n'
import { memosApi } from '../api'
import { useMemoResource } from '../use-resource'

export interface MemoRelationsProps {
  memo: Memo
  onOpen: (id: string) => void
}

function RelationList({
  label,
  relations,
  onOpen,
}: {
  label: string
  relations: MemoRelation[]
  onOpen: (id: string) => void
}): ReactElement | null {
  if (relations.length === 0) return null
  return (
    <div>
      <p className="text-[length:var(--text-10-5)] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]">
        {label}
      </p>
      <ul className="mt-1 space-y-1">
        {relations.map((relation) => (
          <li key={`${relation.memoId}:${relation.relatedMemoId}`}>
            <button
              type="button"
              onClick={() => onOpen(relation.relatedMemoId)}
              className="flex min-h-10 w-full items-center gap-1.5 rounded-[var(--r-sm)] px-1.5 text-left text-[length:var(--text-11-5)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:min-h-0 md:h-7"
            >
              <CornerDownRight size={11} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
              <span className="min-w-0 flex-1 truncate">{relation.relatedSnippet || relation.relatedMemoId}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MemoRelations({ memo, onOpen }: MemoRelationsProps): ReactElement {
  const pair = useMemoResource((signal) => memosApi.relations.get(memo.id, signal), [memo.id, memo.rev])
  const outgoing = pair.data?.outgoing ?? []
  const incoming = pair.data?.incoming ?? []
  return (
    <section className="border-t border-[var(--border-subtle)] pt-3">
      <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
        {t('memos.relations.heading')}
      </h3>
      {pair.status === 'loading' && pair.data === null ? (
        <div className="mt-1.5 space-y-1">
          <Skeleton className="h-5" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : null}
      {pair.status === 'error' && pair.data === null ? (
        <div className="mt-1.5">
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {pair.error ?? t('memos.relations.error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={pair.reload}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {pair.data && outgoing.length === 0 && incoming.length === 0 ? (
        <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('memos.relations.empty')}
        </p>
      ) : null}
      {pair.data ? (
        <div className="mt-1.5 space-y-2">
          <RelationList label={t('memos.relations.outgoing')} relations={outgoing} onOpen={onOpen} />
          <RelationList label={t('memos.relations.incoming')} relations={incoming} onOpen={onOpen} />
        </div>
      ) : null}
    </section>
  )
}
