export interface RecentReconcileRow {
  accountId: string
  authoritative: number
  localEffective: number
  delta: number
  outcome: string
  checkedAt: number
}

export async function listRecentReconcile(db: D1Database, userId: string): Promise<RecentReconcileRow[]> {
  const { results } = await db.prepare(
    `SELECT account_id, authoritative_neurons, local_effective, delta, outcome, checked_at
       FROM ai_gateway_reconcile_snapshots
      WHERE user_id = ?1
      ORDER BY checked_at DESC LIMIT 10`,
  ).bind(userId).all<{
    account_id: string
    authoritative_neurons: number
    local_effective: number
    delta: number
    outcome: string
    checked_at: number
  }>()
  return (results ?? []).map((row) => ({
    accountId: row.account_id,
    authoritative: row.authoritative_neurons,
    localEffective: row.local_effective,
    delta: row.delta,
    outcome: row.outcome,
    checkedAt: row.checked_at,
  }))
}

export interface ReconcileSnapshotRow {
  id: string
  accountId: string
  day: string
  authoritative: number
  localEffective: number
  delta: number
  outcome: string
  checkedAt: number
  note: string | null
}

export interface ReconcilePageFilter {
  page: number
  pageSize: number
  accountId: string | null
}

export async function listReconcilePage(
  db: D1Database,
  userId: string,
  filter: ReconcilePageFilter,
): Promise<{ total: number; items: ReconcileSnapshotRow[] }> {
  const where = ['user_id = ?']
  const values: unknown[] = [userId]
  if (filter.accountId) { where.push('account_id = ?'); values.push(filter.accountId) }
  const [count, rows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS total FROM ai_gateway_reconcile_snapshots WHERE ${where.join(' AND ')}`)
      .bind(...values).first<{ total: number }>(),
    db.prepare(
      `SELECT id, account_id, day, authoritative_neurons, local_effective, delta, outcome, checked_at, note
         FROM ai_gateway_reconcile_snapshots
        WHERE ${where.join(' AND ')}
        ORDER BY checked_at DESC
        LIMIT ? OFFSET ?`,
    ).bind(...values, filter.pageSize, (filter.page - 1) * filter.pageSize).all<{
      id: string
      account_id: string
      day: string
      authoritative_neurons: number
      local_effective: number
      delta: number
      outcome: string
      checked_at: number
      note: string | null
    }>(),
  ])
  return {
    total: count?.total ?? 0,
    items: (rows.results ?? []).map((row) => ({
      id: row.id,
      accountId: row.account_id,
      day: row.day,
      authoritative: row.authoritative_neurons,
      localEffective: row.local_effective,
      delta: row.delta,
      outcome: row.outcome,
      checkedAt: row.checked_at,
      note: row.note,
    })),
  }
}
