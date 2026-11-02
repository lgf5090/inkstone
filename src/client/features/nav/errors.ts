import { ApiError } from '../../lib/api'
import { t } from '../../lib/i18n'

/**
 * What a failed navigation request should say, in the reader's language.
 *
 * `navFetch` already turns a coded error into a localised line, but a request that never reached the
 * server rejects with a bare `TypeError: Failed to fetch`, and an unmapped code falls back to whatever
 * the route wrote in English. Both used to be shown as-is, and each call site had its own one-line
 * version of this rule.
 */
export function navErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isOffline) return t('nav.error.offline')
    return error.message || t('nav.error.generic')
  }
  if (error instanceof TypeError) return t('nav.error.offline')
  if (error instanceof Error) return error.message || t('nav.error.generic')
  return t('nav.error.generic')
}

/**
 * The same failure as a toast payload, with the route's own sentence kept.
 *
 * A mapped code answers one line for every kind of mistake it covers — `nav_webdav_failed` says only
 * "WebDAV request failed" — while the route usually names what it could not reach. Dropping that made
 * the backup panel undiagnosable, so it rides along as the toast's description instead of replacing the
 * localised title.
 */
export function navErrorToast(error: unknown): { title: string; description?: string } {
  const title = navErrorMessage(error)
  if (error instanceof ApiError && error.serverMessage && error.serverMessage !== title) {
    return { title, description: error.serverMessage }
  }
  return { title }
}

/**
 * The same failure as one line, for the surfaces that carry a status strip instead of a toast.
 *
 * The backup panel reports inside the dialog, where there is no second line to put the route's
 * sentence on — and without it, every rejected address reads as the same one generic "bad request"
 * line, and the reader cannot tell that HTTPS was the problem.
 */
export function navErrorLine(error: unknown): string {
  const toast = navErrorToast(error)
  return toast.description ? `${toast.title} · ${toast.description}` : toast.title
}
