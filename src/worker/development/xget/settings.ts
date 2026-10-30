import type { XgetConfigOverrides } from '@shared/development/xget/types'

const TOKEN_HASH_PATTERN = /^$|^[a-f0-9]{64}$/

export async function readXgetSettingsRow(
  db: D1Database,
): Promise<{ overrides: XgetConfigOverrides; tokenHash: string }> {
  const row = await db
    .prepare('SELECT config_json, proxy_token_hash FROM development_xget_settings WHERE id = 1')
    .first<{ config_json: string; proxy_token_hash: string }>()
  if (!row) return { overrides: {}, tokenHash: '' }

  let overrides: XgetConfigOverrides = {}
  try {
    const parsed: unknown = JSON.parse(row.config_json)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      overrides = parsed as XgetConfigOverrides
    } else {
      console.warn('[inkstone] xget settings config_json is not an object')
    }
  } catch (error) {
    console.warn('[inkstone] xget settings config_json is not valid JSON', error)
  }

  return { overrides, tokenHash: row.proxy_token_hash }
}

export async function readXgetOverrides(db: D1Database): Promise<XgetConfigOverrides> {
  return (await readXgetSettingsRow(db)).overrides
}

export async function writeXgetOverrides(
  db: D1Database,
  overrides: XgetConfigOverrides,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO development_xget_settings (id, config_json, proxy_token_hash, updated_at)
       VALUES (1, ?1, '', ?2)
       ON CONFLICT(id) DO UPDATE SET
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(overrides), now)
    .run()
}

export async function writeXgetTokenHash(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<void> {
  if (!TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new Error('xget proxy token hash must be empty or 64 lowercase hex characters')
  }
  await db
    .prepare(
      `INSERT INTO development_xget_settings (id, config_json, proxy_token_hash, updated_at)
       VALUES (1, '{}', ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         proxy_token_hash = excluded.proxy_token_hash,
         updated_at = excluded.updated_at`,
    )
    .bind(tokenHash, now)
    .run()
}
