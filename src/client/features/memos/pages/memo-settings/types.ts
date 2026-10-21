import type { MemoPreferences, MemoPreferencesPatch } from '@shared/memos/types'

export interface MemoSettingsSectionProps {
  preferences: MemoPreferences
  saving: boolean
  save: (patch: MemoPreferencesPatch) => Promise<MemoPreferences | null>
}
