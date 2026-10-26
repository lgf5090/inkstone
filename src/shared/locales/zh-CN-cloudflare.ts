/**
 * The Cloudflare app's catalogue, one language at a time.
 *
 * Loaded by the app when a reader opens it and never by the shell: the module carries 1,200-odd keys
 * of its own, and a reader who never visits /cloudflare should pay none of them.
 */
import { ZH_CN_CLOUDFLARE_ACCOUNTS } from './zh-CN-cloudflare-accounts'
import { ZH_CN_CLOUDFLARE_DASHBOARD } from './zh-CN-cloudflare-dashboard'
import { ZH_CN_CLOUDFLARE_DNS } from './zh-CN-cloudflare-dns'
import { ZH_CN_CLOUDFLARE_WORKERS } from './zh-CN-cloudflare-workers'
import { ZH_CN_CLOUDFLARE_STORAGE } from './zh-CN-cloudflare-storage'
import { ZH_CN_CLOUDFLARE_TUNNELS } from './zh-CN-cloudflare-tunnels'
import { ZH_CN_CLOUDFLARE_AI } from './zh-CN-cloudflare-ai'
import { ZH_CN_CLOUDFLARE_BROWSER_RENDER } from './zh-CN-cloudflare-browser-render'
import { ZH_CN_CLOUDFLARE_STORE } from './zh-CN-cloudflare-store'
import { ZH_CN_CLOUDFLARE_SETTINGS } from './zh-CN-cloudflare-settings'

export const ZH_CN_CLOUDFLARE = {
  ...ZH_CN_CLOUDFLARE_ACCOUNTS,
  ...ZH_CN_CLOUDFLARE_DASHBOARD,
  ...ZH_CN_CLOUDFLARE_DNS,
  ...ZH_CN_CLOUDFLARE_WORKERS,
  ...ZH_CN_CLOUDFLARE_STORAGE,
  ...ZH_CN_CLOUDFLARE_TUNNELS,
  ...ZH_CN_CLOUDFLARE_AI,
  ...ZH_CN_CLOUDFLARE_BROWSER_RENDER,
  ...ZH_CN_CLOUDFLARE_STORE,
  ...ZH_CN_CLOUDFLARE_SETTINGS,
}
