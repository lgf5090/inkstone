/**
 * The provider vocabulary shared by the worker and the list UI.
 *
 * A provider is a stable id, a brand colour and a two-letter monogram; the monogram is the fallback
 * icon when a host has no chosen Lucide/emoji/image icon, so a row never renders a blank tile. Built-in
 * ids are reserved, and a custom provider keeps its own user-scoped id (`custom:<26-char id>`).
 */
export interface WebsshProviderDefinition {
  id: string
  color: string
  short: string
}

export const WEBSSH_BUILTIN_PROVIDERS: readonly WebsshProviderDefinition[] = [
  { id: 'oracle', color: '#c74634', short: 'OR' },
  { id: 'aws', color: '#ff9900', short: 'AWS' },
  { id: 'azure', color: '#0078d4', short: 'AZ' },
  { id: 'huawei', color: '#c7000b', short: 'HW' },
  { id: 'tencent', color: '#0052d9', short: 'TX' },
  { id: 'alibaba', color: '#ff6a00', short: 'AL' },
  { id: 'gcp', color: '#4285f4', short: 'G' },
  { id: 'digitalocean', color: '#0080ff', short: 'DO' },
  { id: 'linode', color: '#00a95c', short: 'LN' },
  { id: 'vultr', color: '#007bfc', short: 'VU' },
  { id: 'cloudflare', color: '#f38020', short: 'CF' },
  { id: 'idc', color: '#6b7280', short: 'IDC' },
  { id: 'other', color: '#475569', short: 'H' },
]

export const WEBSSH_BUILTIN_PROVIDER_IDS = WEBSSH_BUILTIN_PROVIDERS.map((provider) => provider.id)

export function isBuiltinProvider(value: string): boolean {
  return WEBSSH_BUILTIN_PROVIDER_IDS.includes(value)
}

/** Built-in ids stay lowercase ASCII; a custom provider must carry the user-scoped prefix. */
export function normalizeProviderId(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'other'
  if (typeof value !== 'string') return 'other'
  const id = value.trim()
  if (isBuiltinProvider(id)) return id
  if (/^custom:[A-Za-z0-9]{20,32}$/.test(id)) return id
  return 'other'
}

export function providerDefinition(id: string): WebsshProviderDefinition {
  return WEBSSH_BUILTIN_PROVIDERS.find((provider) => provider.id === id) ?? WEBSSH_BUILTIN_PROVIDERS[WEBSSH_BUILTIN_PROVIDERS.length - 1]
}

export function providerShort(value: string, fallbackLabel?: string): string {
  if (isBuiltinProvider(value)) return providerDefinition(value).short
  const label = (fallbackLabel ?? '').trim()
  if (!label) return value.startsWith('custom:') ? 'CU' : 'H'
  return label.slice(0, 2).toUpperCase()
}
