/**
 * Translation lookup for the CloudDrive media/settings shards.
 *
 * The core catalog and the new shards are merged by the locale loader; until that import lands the
 * keys are outside `MessageKey`, so this helper widens the type once instead of every call site
 * casting. Runtime lookup is the ordinary `t()`.
 */
import type { MessageKey } from '@shared/locales/en-US'
import type { EN_US_CLOUDDRIVE_MEDIA } from '@shared/locales/en-US-clouddrive-media'
import { t } from '../../lib/i18n'

export type CloudDriveMediaKey = keyof typeof EN_US_CLOUDDRIVE_MEDIA
export type CloudDriveMessageKey = MessageKey | CloudDriveMediaKey
type Params = Record<string, string | number | boolean | null | undefined>

export function ct(key: CloudDriveMessageKey, params?: Params): string {
  return t(key as MessageKey, params)
}
