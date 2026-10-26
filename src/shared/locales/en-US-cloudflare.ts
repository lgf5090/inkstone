/**
 * The Cloudflare app's catalogue, one language at a time.
 *
 * Loaded by the app when a reader opens it and never by the shell: the module carries 1,200-odd keys
 * of its own, and a reader who never visits /cloudflare should pay none of them.
 */
import { EN_US_CLOUDFLARE_ACCOUNTS } from './en-US-cloudflare-accounts'
import { EN_US_CLOUDFLARE_DASHBOARD } from './en-US-cloudflare-dashboard'
import { EN_US_CLOUDFLARE_DNS } from './en-US-cloudflare-dns'
import { EN_US_CLOUDFLARE_WORKERS } from './en-US-cloudflare-workers'
import { EN_US_CLOUDFLARE_STORAGE } from './en-US-cloudflare-storage'
import { EN_US_CLOUDFLARE_TUNNELS } from './en-US-cloudflare-tunnels'
import { EN_US_CLOUDFLARE_AI } from './en-US-cloudflare-ai'
import { EN_US_CLOUDFLARE_BROWSER_RENDER } from './en-US-cloudflare-browser-render'
import { EN_US_CLOUDFLARE_STORE } from './en-US-cloudflare-store'
import { EN_US_CLOUDFLARE_SETTINGS } from './en-US-cloudflare-settings'

export const EN_US_CLOUDFLARE = {
  ...EN_US_CLOUDFLARE_ACCOUNTS,
  ...EN_US_CLOUDFLARE_DASHBOARD,
  ...EN_US_CLOUDFLARE_DNS,
  ...EN_US_CLOUDFLARE_WORKERS,
  ...EN_US_CLOUDFLARE_STORAGE,
  ...EN_US_CLOUDFLARE_TUNNELS,
  ...EN_US_CLOUDFLARE_AI,
  ...EN_US_CLOUDFLARE_BROWSER_RENDER,
  ...EN_US_CLOUDFLARE_STORE,
  ...EN_US_CLOUDFLARE_SETTINGS,
}
