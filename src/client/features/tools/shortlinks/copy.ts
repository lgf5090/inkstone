import { copyText } from '../../../lib/clipboard'
import { t } from '../../../lib/i18n'
import { useUiStore } from '../../../lib/ui-store'

export async function copyShortlinkText(text: string): Promise<boolean> {
  const ok = await copyText(text)
  useUiStore
    .getState()
    .toast(t(ok ? 'tools.shortlinks.links.copied' : 'common.action_failed'), ok ? 'success' : 'error')
  return ok
}
