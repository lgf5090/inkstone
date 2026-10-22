import { LIMITS } from '@shared/constants'

export const EMAIL_TAG_PATH_SEPARATOR = '/'
export const EMAIL_TAG_PATH_MAX_CHARS = 255

export interface EmailTagLike {
  id: string
  name: string
}

export function normalizeEmailTagPath(value: string): string {
  return value
    .split(EMAIL_TAG_PATH_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(EMAIL_TAG_PATH_SEPARATOR)
}

export function isValidEmailTagPath(value: string): boolean {
  const path = normalizeEmailTagPath(value)
  if (!path || path.length > EMAIL_TAG_PATH_MAX_CHARS) return false
  return path.split(EMAIL_TAG_PATH_SEPARATOR).every((segment) =>
    segment.length <= LIMITS.tagNameMaxLength && !/[\u0000-\u001f\u007f\\]/.test(segment)
  )
}

export function emailTagParentPath(path: string): string | null {
  const cut = path.lastIndexOf(EMAIL_TAG_PATH_SEPARATOR)
  return cut > 0 ? path.slice(0, cut) : null
}

export function emailTagLeafName(path: string): string {
  const cut = path.lastIndexOf(EMAIL_TAG_PATH_SEPARATOR)
  return cut >= 0 ? path.slice(cut + 1) : path
}

export function emailTagAncestorPaths(path: string): string[] {
  const segments = normalizeEmailTagPath(path).split(EMAIL_TAG_PATH_SEPARATOR).filter(Boolean)
  const out: string[] = []
  for (let index = 1; index < segments.length; index++) {
    out.push(segments.slice(0, index).join(EMAIL_TAG_PATH_SEPARATOR))
  }
  return out
}

export function emailTagPathTaken(
  tags: readonly EmailTagLike[],
  path: string,
  exceptId?: string,
): boolean {
  const key = normalizeEmailTagPath(path).toLowerCase()
  return tags.some((tag) => tag.id !== exceptId && normalizeEmailTagPath(tag.name).toLowerCase() === key)
}
