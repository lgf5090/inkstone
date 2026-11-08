import { XGET_KNOWN_METHODS } from './constants'

const KNOWN_METHODS = new Set<string>(XGET_KNOWN_METHODS)

export interface ReadMethodsResult {
  methods: string[]
  unknown: string[]
  isArray: boolean
}

export function readMethods(value: unknown): ReadMethodsResult {
  if (!Array.isArray(value)) return { methods: [], unknown: [], isArray: false }
  const methods: string[] = []
  const unknown: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const method = entry.trim().toUpperCase()
    if (!method) continue
    if (!KNOWN_METHODS.has(method)) {
      if (!unknown.includes(method)) unknown.push(method)
      continue
    }
    if (!methods.includes(method)) methods.push(method)
  }
  return { methods, unknown, isArray: true }
}

export function readOrigin(value: string): string | null {
  if (value === '*') return '*'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null
  return parsed.origin
}

export interface ReadOriginsResult {
  origins: string[]
  invalid: string[]
}

export function readOrigins(value: unknown): ReadOriginsResult {
  if (!Array.isArray(value)) return { origins: [], invalid: [] }
  const entries = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.includes('*')) return { origins: ['*'], invalid: [] }

  const origins: string[] = []
  const invalid: string[] = []
  for (const entry of entries) {
    const origin = readOrigin(entry)
    if (!origin) {
      if (!invalid.includes(entry)) invalid.push(entry)
      continue
    }
    if (!origins.includes(origin)) origins.push(origin)
  }
  return { origins, invalid }
}
