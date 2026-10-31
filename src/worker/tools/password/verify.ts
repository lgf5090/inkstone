import bcrypt from 'bcryptjs'

/**
 * Checks a candidate master password against the stored verifier.
 *
 * The verifier is a bcrypt digest produced by the client when the vault was created (or last
 * reset), so the server can answer "is this the master password" without ever learning the key the
 * vault is encrypted with. A malformed or missing digest answers false instead of throwing, because
 * the only caller turns a negative answer into a 401 either way.
 */
export function verifyMasterHash(password: string, storedHash: string): boolean {
  if (!password || !storedHash) return false
  try {
    return bcrypt.compareSync(password, storedHash)
  } catch {
    return false
  }
}
