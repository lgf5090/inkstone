/**
 * Which provider owns the zone that contains a requested domain.
 *
 * A provider is matched by its configured zone name, not its label: the label is free text, while the
 * zone name is what the token is allowed to write to. The longest matching zone wins, so a provider
 * for `sub.example.com` is preferred over one for `example.com`. The wildcard prefix is dropped before
 * matching because `*.example.com` lives inside the `example.com` zone.
 *
 * Both the request form and the worker's repair path use this: a stored order has to be bound with
 * exactly the same rule the form would have applied, or the two disagree about which zone owns a name.
 */
export function matchProviderForDomain(
  name: string,
  providers: Array<{ id: string; zoneName?: string }>,
): string {
  const host = name.trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '')
  if (!host) return ''
  let best: { id: string; length: number } | null = null
  for (const provider of providers) {
    const zone = (provider.zoneName ?? '').trim().toLowerCase().replace(/\.$/, '')
    if (!zone) continue
    if (host !== zone && !host.endsWith(`.${zone}`)) continue
    if (!best || zone.length > best.length) best = { id: provider.id, length: zone.length }
  }
  return best?.id ?? ''
}
