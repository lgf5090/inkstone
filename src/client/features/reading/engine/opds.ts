export interface OpdsEntry {
  title: string
  url: string
  type: string
}

export interface OpdsFeed {
  title: string
  entries: OpdsEntry[]
  navigation: OpdsEntry[]
}

export function parseOpdsFeed(xml: string, baseUrl: string): OpdsFeed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid OPDS feed')
  const base = new URL(baseUrl)
  const resolve = (value: string) => new URL(value, base).toString()
  const title = doc.querySelector('feed > title')?.textContent?.trim() || 'OPDS'
  const entries: OpdsEntry[] = []
  const navigation: OpdsEntry[] = []
  for (const node of Array.from(doc.querySelectorAll('feed > entry'))) {
    const name = node.querySelector('title')?.textContent?.trim()
    if (!name) continue
    for (const link of Array.from(node.querySelectorAll('link'))) {
      const href = link.getAttribute('href')
      const type = link.getAttribute('type') ?? ''
      if (!href) continue
      if (link.getAttribute('rel') === 'http://opds-spec.org/acquisition' && /epub|pdf|cbz/i.test(type)) {
        entries.push({ title: name, url: resolve(href), type })
      }
    }
  }
  for (const link of Array.from(doc.querySelectorAll('feed > link'))) {
    const href = link.getAttribute('href')
    if (!href || link.getAttribute('rel') === 'http://opds-spec.org/acquisition') continue
    navigation.push({ title: link.getAttribute('title') ?? 'Browse', url: resolve(href), type: link.getAttribute('type') ?? '' })
  }
  return { title, entries, navigation }
}
