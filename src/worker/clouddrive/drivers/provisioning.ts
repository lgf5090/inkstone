/**
 * Provisioning actions a driver performs before it has usable credentials. Today only the phone
 * verification handshake needs one; the route reads this table by storage type so it never names a
 * driver itself.
 */
import type { Env } from '../../env'
import { createDriverContext } from './factory'
import type { StorageDriverRow } from './factory'
import { DriverError } from './contract'
import { completeGuangYaPanLogin, requestGuangYaPanVerification } from './guangyapan'

export type DriverActionResult = Record<string, string>

export async function runDriverAction(
  env: Env,
  row: StorageDriverRow,
  action: string,
  payload: Record<string, unknown>,
): Promise<DriverActionResult> {
  if (row.type !== 'guangyapan') {
    throw DriverError.unsupported(`The ${row.type} driver has no provisioning action`)
  }
  const ctx = await createDriverContext(env, row)
  if (action === 'send-code') {
    return { verificationId: await requestGuangYaPanVerification(ctx) }
  }
  if (action === 'verify-code') {
    const code = typeof payload.code === 'string' ? payload.code.trim() : ''
    const tokens = await completeGuangYaPanLogin(ctx, code)
    return { accessToken: tokens.accessToken, hasRefreshToken: tokens.refreshToken ? '1' : '0' }
  }
  throw DriverError.unsupported(`The ${row.type} driver has no action named ${action}`)
}
