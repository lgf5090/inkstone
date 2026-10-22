import { useRef } from 'react'
import type { Memo } from '@shared/memos/types'
import { t } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import { useMemos } from './state'

export function useMemoTaskToggle(
  memo: Pick<Memo, 'id' | 'rev'> | null,
): (nextContent: string) => void {
  const pending = useRef(false)
  return (nextContent: string): void => {
    if (!memo || pending.current) return
    pending.current = true
    void useMemos.getState().patch(memo.id, { rev: memo.rev, content: nextContent })
      .then((saved) => {
        if (saved) return
        useUi.getState().toast({
          title: t('memos.card.task_failed'),
          description: useMemos.getState().mutationError ?? undefined,
          tone: 'danger',
        })
      })
      .catch((error: unknown) => {
        console.warn('[inkstone] Memo task toggle failed', error)
        useUi.getState().toast({
          title: t('memos.card.task_failed'),
          description: error instanceof Error && error.message ? error.message : undefined,
          tone: 'danger',
        })
      })
      .finally(() => {
        pending.current = false
      })
  }
}
