import { getMeta, setMeta } from '../db/metadata'


export const KEY_REGISTRATION_OPEN = 'setting:allow_registration'

export async function getAllowRegistration(db: D1Database): Promise<boolean> {
  return (await getMeta(db, KEY_REGISTRATION_OPEN)) === '1'
}

export async function setAllowRegistration(db: D1Database, enabled: boolean): Promise<void> {
  await setMeta(db, KEY_REGISTRATION_OPEN, enabled ? '1' : '0')
}
