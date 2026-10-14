import { tagKey } from '@shared/markdown-utils'

/**
 * Whether a tag filter list already holds this name. The store dedups, drops and matches tags by the
 * case- and width-insensitive `tagKey`, so a row's highlight has to ask the same question — a plain
 * `includes` would leave `Work` and `work` as two slots over the same notes while one row lit up and
 * the other did not.
 */
export function hasTagFilter(list: readonly string[], name: string): boolean {
  const key = tagKey(name)
  return list.some((item) => tagKey(item) === key)
}

/** The list with every spelling of `name` removed, folded the way `hasTagFilter` matches. */
export function dropTagFilter(list: readonly string[], name: string): string[] {
  const key = tagKey(name)
  return list.filter((item) => tagKey(item) !== key)
}

/** The list with every spelling of `from` rewritten to `to`, so a rename keeps one filter slot. */
export function mapTagFilter(list: readonly string[], from: string, to: string): string[] {
  const key = tagKey(from)
  return list.map((item) => tagKey(item) === key ? to : item)
}
