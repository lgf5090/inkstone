/**
 * Music copy is served from the `music` locale fragment. Until that fragment carries a key, `t`
 * answers with the key itself, which is readable in development and keeps a half-translated label
 * from drifting into copy that has to be translated twice. The cast is the seam the fragment removes.
 */
import type { MessageKey } from '@shared/locales/en-US'
import { t } from '../../../lib/i18n'

type MusicTextParams = Record<string, string | number | boolean | null | undefined>

export function musicText(key: string, params?: MusicTextParams): string {
  return t(key as MessageKey, params)
}
