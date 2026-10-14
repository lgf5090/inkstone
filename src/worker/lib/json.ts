/**
 * Reading back a column this app wrote as JSON.
 *
 * Four routes each used to carry their own copy of the same three lines — `JSON.parse` inside a
 * `try`, one `typeof` guard, `{}` on failure — and each copy silently settled for a different
 * shape when the stored text was not a plain object. These are the three shapes a stored column
 * actually holds, so the shape a route asks for is the one it gets. A malformed or hand-edited row
 * is a data problem to recover from, never a reason to fail the request that reads it, so every
 * one of these answers with its fallback rather than throwing.
 */

/** The parsed value, or `undefined` when the text is not valid JSON. */
export function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** A plain object, or `{}` for anything else — an array, a primitive, or malformed text. */
export function storedObject(raw: string): Record<string, unknown> {
  const value = parseStoredJson(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** The members of a stored JSON array, keeping only the ones that are strings. */
export function storedStringArray(raw: string): string[] {
  const value = parseStoredJson(raw)
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}
