import { MEMO_PREFERENCES_DEFAULTS } from '@shared/memos/constants'
import type { MemoPreferences } from '@shared/memos/types'
import { memosApi } from './api'
import { useRevision } from './events'
import { useMemoResource, type MemoResource } from './use-resource'

export type MemoPreferencesResource = MemoResource<MemoPreferences> & {
  preferences: MemoPreferences
}

export function useMemoPreferences(): MemoPreferencesResource {
  const revision = useRevision('preferences')
  const resource = useMemoResource((signal) => memosApi.preferences.get(signal), [revision])
  return { ...resource, preferences: resource.data ?? MEMO_PREFERENCES_DEFAULTS }
}
