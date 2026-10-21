import type { MemoSpace } from '@shared/memos/types'
import { memosApi } from './api'
import { useRevision } from './events'
import { useMemoResource, type MemoResource } from './use-resource'

export function useMemoSpaces(): MemoResource<MemoSpace[]> {
  const revision = useRevision('spaces')
  return useMemoResource(
    (signal) => memosApi.spaces.list(signal).then((page) => page.spaces),
    [revision],
  )
}
