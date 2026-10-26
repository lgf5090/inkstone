/**
 * Slugs generation, validation, and collision protection for Short Links.
 */

import { MAX_SLUG_LENGTH, MIN_SLUG_LENGTH } from '@shared/tools/shortlinks/types'

// Unambiguous lowercase characters: removed l, o, 0, 1 to avoid confusion
export const RANDOM_CHARSET = 'abcdefghijkmnpqrstuvwxyz23456789'
export const RANDOM_SLUG_REGEX = /^[a-z0-9]+$/
export const CUSTOM_SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

export const RESERVED_SLUGS = new Set([
  'api',
  'tools',
  'notes',
  'memos',
  'auth',
  'admin',
  'assets',
  'favicon',
  'robots',
  'health',
  'login',
  'logout',
  'register',
  'collections',
  'reading',
  'feeds',
  'hooks',
  'music',
  'email',
  'todo',
  'calendar',
  'chat',
  'projects',
  'nav',
  'subscriptions',
  'oauth',
  'mcp',
  's',
  'c',
  'm',
  'l',
  'n',
])

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase())
}

export function generateRandomSlug(length: number): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => RANDOM_CHARSET[b % RANDOM_CHARSET.length]).join('')
}

export function validateRandomSlug(slug: string): string | null {
  if (slug.length < MIN_SLUG_LENGTH) return `Slug must be at least ${MIN_SLUG_LENGTH} characters`
  if (slug.startsWith('_')) return 'Slug must not start with underscore'
  if (!RANDOM_SLUG_REGEX.test(slug)) return 'Slug must contain only alphanumeric characters'
  if (isReservedSlug(slug)) return 'Slug is reserved by the system'
  return null
}

export function validateCustomSlug(slug: string): string | null {
  if (slug.length < 1) return 'Custom slug must not be empty'
  if (slug.length > MAX_SLUG_LENGTH) return `Custom slug exceeds maximum length of ${MAX_SLUG_LENGTH}`
  if (slug.startsWith('_')) return 'Slug must not start with underscore'
  if (slug.startsWith('-') || slug.endsWith('-')) return 'Custom slug must not start or end with a hyphen'
  if (!CUSTOM_SLUG_REGEX.test(slug)) return 'Custom slug must contain only alphanumeric characters and hyphens'
  if (isReservedSlug(slug)) return 'Slug is reserved by the system'
  return null
}

export function validateSlugLength(length: number): string | null {
  if (!Number.isInteger(length) || length < MIN_SLUG_LENGTH) return `Slug length must be an integer >= ${MIN_SLUG_LENGTH}`
  if (length > MAX_SLUG_LENGTH) return `Slug length must be an integer <= ${MAX_SLUG_LENGTH}`
  return null
}

export async function generateUniqueSlug(
  db: D1Database,
  length: number,
  checkExists: (db: D1Database, slug: string) => Promise<boolean>,
): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const slug = generateRandomSlug(length)
    if (isReservedSlug(slug)) continue
    if (!(await checkExists(db, slug))) {
      return slug
    }
  }
  throw new Error('Failed to generate unique slug after 10 attempts')
}
