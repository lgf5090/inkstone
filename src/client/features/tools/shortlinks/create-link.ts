import type { ShortLink } from '@shared/tools/shortlinks/types'
import type { CreateLinkInput } from '@shared/tools/shortlinks/schemas'
import { confirm } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { ApiError } from '../../../lib/api'
import { shortlinksApi } from './api'

export async function createShortlinkSafely(input: CreateLinkInput): Promise<ShortLink | null> {
  try {
    return await shortlinksApi.createLink(input)
  } catch (err) {
    if (!(err instanceof ApiError) || !err.isConflict) throw err
    const proceed = await confirm({
      title: t('tools.shortlinks.modal.duplicate_title'),
      description: t('tools.shortlinks.modal.duplicate_body'),
      confirmLabel: t('tools.shortlinks.modal.duplicate_confirm'),
      cancelLabel: t('common.cancel'),
    })
    if (!proceed) return null
    return shortlinksApi.createLink({ ...input, allow_duplicate: true })
  }
}
