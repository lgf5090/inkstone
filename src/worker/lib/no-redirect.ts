/**
 * workerd accepts only `follow` and `manual` for `RequestRedirect`; passing `'error'` throws before the
 * request leaves the isolate, so an endpoint that meant to refuse redirects instead reports every upstream
 * as unreachable. Node (the vite dev proxy) does accept `'error'`, which is why a local unit test on the
 * literal never sees this. Guard the status ourselves instead.
 */
export const NO_REDIRECT = 'manual' as const

export function isRedirectResponse(res: Response): boolean {
  return res.status >= 300 && res.status < 400
}
