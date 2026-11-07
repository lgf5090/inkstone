/**
 * The handful of sentences served by the public `/l/:slug` pages.
 *
 * These pages are rendered by the worker, outside the app shell, so they cannot reach the client
 * catalog. Keeping the copy in its own module keeps the language pair together without pulling the
 * whole interface vocabulary into every redirect.
 */
export const EN_US_SHORTLINKS_PUBLIC = {
  passwordTitle: 'Protected link',
  passwordHeading: 'Protected short link',
  passwordMessage: 'This short link is password protected. Enter the access password to continue.',
  passwordLabel: 'Access password',
  passwordPlaceholder: 'Enter the access password',
  passwordSubmit: 'Verify and continue',
  tooManyAttempts: 'Too many wrong attempts. Try again in {minutes} minute(s).',
  wrongPassword: 'The access password is incorrect. Try again.',
  notFoundTitle: 'Short link not found',
  notFoundMessage: 'This short link does not exist or has been deleted.',
  disabledTitle: 'Link disabled',
  disabledMessage: 'The creator has temporarily disabled this short link.',
  expiredTitle: 'Link expired',
  expiredMessage: 'This short link has passed its expiry time.',
  invalidTargetTitle: 'Link unavailable',
  invalidTargetMessage: 'This short link does not point to a web address that can be opened.',
  unsafeTitle: 'This link may be unsafe',
  unsafeMessage: 'The creator flagged this destination as one that may be unexpected or unsafe. Continue only if you trust the person who shared it.',
  unsafeConfirm: 'Continue to the destination',
  unsafeCancel: 'Go back to Inkstone',
}

export type ShortlinksPublicCopy = typeof EN_US_SHORTLINKS_PUBLIC
