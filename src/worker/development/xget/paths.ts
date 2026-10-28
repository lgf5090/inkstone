import { XGET_PROXY_PREFIX } from '@shared/development/xget/constants'

export function isXgetProxyPath(pathname: string): boolean {
  if (pathname === XGET_PROXY_PREFIX || pathname === `${XGET_PROXY_PREFIX}/`) return true
  if (!pathname.startsWith(`${XGET_PROXY_PREFIX}/`)) return false
  const rest = pathname.slice(XGET_PROXY_PREFIX.length)
  return !(
    rest === '/settings' ||
    rest.startsWith('/settings/') ||
    rest === '/stats' ||
    rest.startsWith('/stats/')
  )
}
