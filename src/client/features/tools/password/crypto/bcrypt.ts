import bcrypt from 'bcryptjs'

export const DEFAULT_BCRYPT_ROUNDS = 10

export function hashMasterPassword(password: string, rounds = DEFAULT_BCRYPT_ROUNDS): string {
  if (!password) {
    throw new Error('Master password cannot be empty')
  }
  if (rounds < 4 || rounds > 31) {
    throw new RangeError('Bcrypt rounds must be between 4 and 31')
  }
  return bcrypt.hashSync(password, rounds)
}

export function verifyMasterPassword(password: string, hash: string): boolean {
  if (!password || !hash) {
    return false
  }
  try {
    return bcrypt.compareSync(password, hash)
  } catch {
    return false
  }
}
