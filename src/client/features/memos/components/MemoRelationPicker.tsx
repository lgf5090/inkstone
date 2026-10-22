import { useMemo, useState, type ReactElement } from 'react'
import { Search } from 'lucide-react'
import type { Memo } from '@shared/memos/types'
import { Button } from '../../../components/primitives'
import { Checkbox, Input } from '../../../components/form'
import { Skeleton } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { useDebounced } from '../../../lib/hooks'
import { isImeComposing } from '../../../lib/ime'
import { t } from '../../../lib/i18n'
import { memosApi, type MemoRelationsPair } from '../api'
import { memoErrorMessage } from '../errors'
import { useMemoResource } from '../use-resource'

export interface MemoRelationPickerProps {
  memo: Memo
  existingOutgoingIds: string[]
  onSaved: (pair: MemoRelationsPair) => void
  onClose: () => void
}

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_LIMIT = 8

function candidateLabel(candidate: Memo): string {
  return candidate.title.trim()
    || candidate.snippet.trim()
    || t('memos.attachments.library.source_memo_untitled')
}

export function MemoRelationPicker({
  memo,
  existingOutgoingIds,
  onSaved,
  onClose,
}: MemoRelationPickerProps): ReactElement {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Map<string, Memo>>(() => new Map())
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const debouncedQuery = useDebounced(query, SEARCH_DEBOUNCE_MS)
  const excluded = useMemo(
    () => new Set([memo.id, ...existingOutgoingIds]),
    [existingOutgoingIds, memo.id],
  )
  const search = useMemoResource((signal) => {
    const needle = debouncedQuery.trim()
    return memosApi.list({
      filter: needle ? `content.contains(${JSON.stringify(needle)})` : undefined,
      limit: SEARCH_LIMIT,
    }, signal)
  }, [debouncedQuery])
  const candidates = (search.data?.items ?? []).filter((candidate) => !excluded.has(candidate.id))

  const toggle = (candidate: Memo): void => {
    setSelected((current) => {
      const next = new Map(current)
      if (next.has(candidate.id)) next.delete(candidate.id)
      else next.set(candidate.id, candidate)
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (saving || selected.size === 0) return
    setSaving(true)
    setSaveError(null)
    const ids = [...existingOutgoingIds]
    for (const id of selected.keys()) {
      if (!ids.includes(id)) ids.push(id)
    }
    try {
      const pair = await memosApi.relations.put(memo.id, ids)
      onSaved(pair)
      onClose()
    } catch (error) {
      setSaveError(memoErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const footer = (
    <>
      <Button variant="ghost" disabled={saving} onClick={onClose}>
        {t('memos.common.cancel')}
      </Button>
      <Button
        variant="primary"
        loading={saving}
        disabled={selected.size === 0}
        onClick={() => void save()}
      >
        {t('memos.common.save')}
      </Button>
    </>
  )

  return (
    <Modal
      open
      onClose={onClose}
      title={t('memos.relations.add_title')}
      description={t('memos.relations.add_description')}
      width={520}
      dismissible={!saving}
      footer={footer}
    >
      <Input
        data-autofocus
        type="search"
        value={query}
        leading={<Search size={13} />}
        placeholder={t('memos.relations.search_placeholder')}
        aria-label={t('memos.relations.search_placeholder')}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !isImeComposing(event)) event.preventDefault()
        }}
      />
      <div className="mt-2 min-h-16">
        {search.status === 'loading' && search.data === null ? (
          <div className="space-y-1.5" role="status" aria-label={t('memos.common.loading')}>
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9 w-4/5" />
          </div>
        ) : null}
        {search.status === 'error' && search.data === null ? (
          <div>
            <p role="alert" className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
              {search.error ?? t('memos.relations.error')}
            </p>
            <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={search.reload}>
              {t('memos.common.retry')}
            </Button>
          </div>
        ) : null}
        {search.data && candidates.length === 0 ? (
          <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('memos.relations.no_results')}
          </p>
        ) : null}
        {candidates.length > 0 ? (
          <ul className="space-y-0.5">
            {candidates.map((candidate) => (
              <li key={candidate.id}>
                <Checkbox
                  checked={selected.has(candidate.id)}
                  onChange={() => toggle(candidate)}
                  className="w-full min-w-0 rounded-[var(--r-sm)] px-1.5 hover:bg-[var(--bg-hover)] [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
                  label={(
                    <span className="flex min-w-0 flex-1 flex-col py-0.5 text-left">
                      <span className="truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">
                        {candidateLabel(candidate)}
                      </span>
                      {candidate.snippet.trim() && candidate.title.trim() ? (
                        <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {candidate.snippet}
                        </span>
                      ) : null}
                    </span>
                  )}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {saveError ? (
        <p role="alert" className="mt-2 text-[length:var(--text-11)] text-[var(--danger)]">
          {saveError}
        </p>
      ) : null}
    </Modal>
  )
}
