import type { MemoState, MemoVisibility } from '@shared/memos/types'

export function isPubliclyReadable(visibility: MemoVisibility, state: MemoState): boolean {
  return state === 'normal' && visibility === 'public'
}

export function isProtectedReadable(
  viewerId: string | null,
  visibility: MemoVisibility,
  state: MemoState,
): boolean {
  return state === 'normal' && visibility === 'protected' && viewerId !== null
}

export function canReadMemo(
  viewerId: string | null,
  memo: { userId: string; visibility: MemoVisibility; state: MemoState },
): boolean {
  const owner = viewerId !== null && viewerId === memo.userId
  return owner
    || isPubliclyReadable(memo.visibility, memo.state)
    || isProtectedReadable(viewerId, memo.visibility, memo.state)
}
