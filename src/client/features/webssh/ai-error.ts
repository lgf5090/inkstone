/**
 * The one translation of a WebSSH AI failure.
 *
 * The worker answers with stable codes so every surface can say the same thing: "configure a model"
 * and "the daily ceiling is spent" are decisions the reader can act on, while an upstream failure is
 * only worth a retry. The panel, the file dialog and the audit summary all read this function rather
 * than each inventing its own sentence.
 */

import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'

export function websshAiErrorText(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.code === 'webssh_ai_unavailable') return t('webssh.ai.error.unavailable')
    if (caught.code === 'webssh_ai_quota') return t('webssh.ai.error.quota')
    if (caught.code === 'webssh_ai_too_large') return t('webssh.ai.error.too_large')
    if (caught.code === 'webssh_ai_invalid_output') return t('webssh.ai.error.invalid_output')
    if (caught.code === 'webssh_ai_upstream') return t('webssh.ai.error.upstream')
    return caught.message || t('webssh.error.generic')
  }
  return t('webssh.error.generic')
}
