import {
  expiringSoonCutoff,
  type ShareSelection,
  type ShareStatusFilter,
  type ShareTarget,
  type VisitLogFilter,
  type VisitTrafficFilters,
} from '@shared/share-selection'

/**
 * The SQL half of the rules in `@shared/share-selection`. Every statement that selects shares goes
 * through here — the owner's list, its count columns, the tag counts, a collection's members, the
 * batch toggles — because the two halves of the app are written separately and the only way a tag
 * collection and a tag filter cannot drift apart is if they were never written apart.
 *
 * Fragments carry the first bind number they were given and hand back the next free one, so a caller
 * can compose several of them without renumbering placeholders afterwards.
 */

/** The aliases a statement addresses the two tables by. Both default to the list query's own. */
export interface ShareSqlAliases {
  share?: string
  note?: string
}

export interface SqlFragment {
  sql: string
  binds: Array<string | number>
  nextBind: number
}

export interface ShareSqlConditions {
  conditions: string[]
  binds: Array<string | number>
  nextBind: number
}

const DEFAULT_SHARE_ALIAS = 's'
const DEFAULT_NOTE_ALIAS = 'n'

/** A condition no row satisfies: what an address that no longer resolves selects. */
export const NO_ROWS_CONDITION = '0'

function aliasesOf(aliases: ShareSqlAliases | undefined): { share: string; note: string } {
  return { share: aliases?.share ?? DEFAULT_SHARE_ALIAS, note: aliases?.note ?? DEFAULT_NOTE_ALIAS }
}

/**
 * `is_enabled` is `NOT NULL DEFAULT 1` — the column was added that way and the payload reads it as
 * `!== 0` — so "enabled" is one value and not a value plus a missing case. Spelling the rule with an
 * extra `OR is_enabled IS NULL` arm is a missing case the schema cannot produce, and carrying it in
 * one statement but not another is how a rule starts to differ from itself.
 */
export function shareStatusSql(
  status: ShareStatusFilter,
  now: number,
  firstBind: number,
  aliases?: ShareSqlAliases,
): SqlFragment | null {
  const { share, note } = aliasesOf(aliases)
  const fragment = (sql: string, binds: Array<string | number> = []): SqlFragment => ({
    sql,
    binds,
    nextBind: firstBind + binds.length,
  })
  switch (status) {
    case 'all':
      return null
    case 'active':
      return fragment(
        `${share}.is_enabled = 1 AND (${share}.expires_at IS NULL OR ${share}.expires_at > ?${firstBind})`,
        [now],
      )
    case 'paused':
      return fragment(`${share}.is_enabled = 0`)
    case 'pinned':
      return fragment(`${note}.is_pinned = 1`)
    case 'starred':
      return fragment(`${note}.is_starred = 1`)
    case 'password':
      return fragment(`${share}.password_hash IS NOT NULL`)
    case 'expiring_soon':
      return fragment(
        `${share}.expires_at IS NOT NULL AND ${share}.expires_at > ?${firstBind} AND ${share}.expires_at <= ?${firstBind + 1}`,
        [now, expiringSoonCutoff(now)],
      )
    case 'expiring':
      return fragment(`${share}.expires_at IS NOT NULL AND ${share}.expires_at > ?${firstBind}`, [now])
    case 'permanent':
      return fragment(`${share}.expires_at IS NULL`)
    case 'expired':
      return fragment(`${share}.expires_at IS NOT NULL AND ${share}.expires_at <= ?${firstBind}`, [now])
  }
}

/**
 * The element test: the stored value has to be one element of the share's tag array, not a substring
 * of its text. A substring test is what `%"name"%` approximates, and it needs the name to carry no
 * quote, no backslash and no `LIKE` wildcard to be right.
 *
 * `rhs` is a bind placeholder or a column — the tag counts compare against `share_tags.name` — so the
 * one rule serves both. The nested `CASE` is the guard for a corrupt array: `json_type` and
 * `json_each` throw on malformed JSON, `AND` does not promise to short-circuit, and a single legacy
 * row taking the whole list down with a 500 is a worse answer than "this share does not carry it".
 */
export function shareTagElementSql(shareAlias: string, rhs: string): string {
  const array = `CASE WHEN json_valid(${shareAlias}.tags) THEN (CASE WHEN json_type(${shareAlias}.tags) = 'array' THEN ${shareAlias}.tags ELSE '[]' END) ELSE '[]' END`
  return `EXISTS (SELECT 1 FROM json_each(${array}) WHERE json_each.value = ${rhs})`
}

export function shareTargetSql(
  target: ShareTarget,
  firstBind: number,
  aliases?: ShareSqlAliases,
): SqlFragment {
  const { share } = aliasesOf(aliases)
  if (target.type === 'none') return { sql: NO_ROWS_CONDITION, binds: [], nextBind: firstBind }
  if (target.type === 'folder') {
    return { sql: `${share}.folder_id = ?${firstBind}`, binds: [target.value], nextBind: firstBind + 1 }
  }
  return {
    sql: shareTagElementSql(share, `?${firstBind}`),
    binds: [target.value],
    nextBind: firstBind + 1,
  }
}

/**
 * Everything a list, a collection page or a batch toggle selects, as conditions to join with `AND`.
 * The target comes before the status so the placeholders read in the order the list builds them,
 * which keeps the query plans and the diffs stable.
 */
export function shareSelectionSql(
  selection: ShareSelection,
  params: { now: number; firstBind: number; aliases?: ShareSqlAliases },
): ShareSqlConditions {
  const conditions: string[] = []
  const binds: Array<string | number> = []
  let nextBind = params.firstBind
  if (selection.target) {
    const target = shareTargetSql(selection.target, nextBind, params.aliases)
    conditions.push(target.sql)
    binds.push(...target.binds)
    nextBind = target.nextBind
  }
  const status = selection.status
    ? shareStatusSql(selection.status, params.now, nextBind, params.aliases)
    : null
  if (status) {
    conditions.push(status.sql)
    binds.push(...status.binds)
    nextBind = status.nextBind
  }
  return { conditions, binds, nextBind }
}

/**
 * The single-choice log filter as a WHERE fragment, or null for `all` (no condition). `real` is the
 * three toggles at once — the same call `visitMatchesLogFilter` makes — so the log view's "real
 * visitors" cannot come to mean a different set of rows from the reading's.
 */
export function visitLogFilterSql(filter: VisitLogFilter, alias = ''): string | null {
  const prefix = alias ? `${alias}.` : ''
  switch (filter) {
    case 'all':
      return null
    case 'real':
      return `${prefix}is_bot = 0 AND ${prefix}is_self_referrer = 0 AND ${prefix}is_owner = 0`
    case 'bot':
      return `${prefix}is_bot = 1`
    case 'owner':
      return `${prefix}is_owner = 1`
    case 'self':
      return `${prefix}is_self_referrer = 1`
  }
}

/**
 * The visit-table half of the traffic filters, as a clause the callers append to their own `WHERE`.
 * An empty string means no filter is on, which is why the three defaults live in the shared predicate
 * and are read here in the same order.
 */
export function visitTrafficSql(filters: VisitTrafficFilters, alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  const parts: string[] = []
  if (filters.excludeBots !== false) parts.push(`${prefix}is_bot = 0`)
  if (filters.excludeSelfReferrers === true) parts.push(`${prefix}is_self_referrer = 0`)
  if (filters.excludeOwner === true) parts.push(`${prefix}is_owner = 0`)
  return parts.length ? ` AND ${parts.join(' AND ')}` : ''
}
