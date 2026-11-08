import { sha256Hex, utf8 } from '../../../lib/encoding'
import { ApiError } from '../../../lib/errors'
import type { Env } from '../../../env'
import { cloudflareConfig, createTxtRecord, deleteDnsRecord } from './cloudflare'
import { normalizeDomain } from '@shared/development/certhub/validation'

export function dcvAvailable(env: Env): boolean {
  const config = cloudflareConfig(env)
  return Boolean(config.zone && config.token)
}

export function dcvZone(env: Env): string {
  const zone = cloudflareConfig(env).zone
  if (!zone) throw new ApiError(503, 'config_unavailable', 'The deployment has no DCV delegation zone')
  return normalizeDomain(zone).name
}

export async function createDelegatedTxt(
  env: Env,
  fqdn: string,
  keyAuthorization: string,
): Promise<{ recordName: string; recordId: string; cnameTarget: string }> {
  const config = cloudflareConfig(env)
  if (!config.zone || !config.token) {
    throw new ApiError(503, 'config_unavailable', 'The deployment has no DCV delegation credentials')
  }
  const zone = normalizeDomain(config.zone).name
  const hash = (await sha256Hex(utf8(`${fqdn}:${keyAuthorization}`))).slice(0, 16)
  const recordName = `${hash}.${zone}`
  const recordId = await createTxtRecord(
    config.token,
    env.CERTHUB_DCV_ZONE_ID ?? '',
    recordName,
    keyAuthorization,
    `certhub:${fqdn}`,
  )
  return { recordName, recordId, cnameTarget: recordName }
}

export async function deleteDelegatedTxt(env: Env, recordId: string): Promise<void> {
  const config = cloudflareConfig(env)
  if (!config.token || !config.zone || !recordId) return
  await deleteDnsRecord(config.token, env.CERTHUB_DCV_ZONE_ID ?? '', recordId)
}
