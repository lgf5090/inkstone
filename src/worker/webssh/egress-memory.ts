/**
 * The per-host placement memory: the last region that actually connected, and the failure streak
 * that invalidates it. Only `regionResolved` is touched, so a concurrent host edit cannot be lost.
 */

export async function rememberRegionSuccess(
  db: D1Database,
  userId: string,
  hostId: string,
  region: string,
  now = Date.now(),
): Promise<void> {
  if (!region) return
  await db.prepare(
    `UPDATE webssh_hosts
        SET egress = json_set(egress, '$.regionResolved',
              json_object('region', ?3, 'at', ?4, 'failures', 0))
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId, region, now)
    .run()
}

/** Two consecutive failures in the remembered region forget it, so the next plan starts fresh. */
export async function rememberRegionFailure(
  db: D1Database,
  userId: string,
  hostId: string,
  region: string,
  now = Date.now(),
): Promise<void> {
  if (!region) return
  await db.prepare(
    `UPDATE webssh_hosts
        SET egress = CASE
          WHEN json_extract(egress, '$.regionResolved.region') = ?3 THEN
            CASE WHEN COALESCE(json_extract(egress, '$.regionResolved.failures'), 0) + 1 >= 2
              THEN json_remove(egress, '$.regionResolved')
              ELSE json_set(egress, '$.regionResolved',
                     json_object('region', ?3, 'at', ?4,
                       'failures', COALESCE(json_extract(egress, '$.regionResolved.failures'), 0) + 1))
            END
          ELSE egress
        END
      WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL`,
  )
    .bind(userId, hostId, region, now)
    .run()
}
