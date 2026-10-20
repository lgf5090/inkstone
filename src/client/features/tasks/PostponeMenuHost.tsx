/**
 * The overlay that shows the postpone rows.
 *
 * Mounted only while a row has asked for it, and it owns nothing but the menu: choosing a row closes it
 * first, so a slow write cannot leave a panel on screen whose dates are already stale.
 */
import { t } from '../../lib/i18n'
import { Menu } from '../../components/overlay'
import { usePostponeMenu } from './postpone-store'

export function PostponeMenuHost() {
  const request = usePostponeMenu((state) => state.request)
  const close = usePostponeMenu((state) => state.close)
  if (request === null) return null
  return (
    <Menu
      anchor={{ x: request.x, y: request.y }}
      open
      onClose={close}
      label={t('tasks.postpone_action')}
      width={250}
      items={request.items.map((item) => ({
        ...item,
        onSelect: item.onSelect ? () => {
          close()
          item.onSelect?.()
        } : undefined,
      }))}
    />
  )
}
