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

/**
 * Rebuilds the verifier at a different bcrypt cost from the password that just verified.
 *
 * The server does this itself rather than accepting a digest from the browser: a client-computed
 * hash of the wrong password would lock the owner out of a vault that has no recovery path, while a
 * hash made from the password the server has just verified cannot be wrong.
 */
export function hashMasterHashAtCost(password: string, cost: number): string {
  return bcrypt.hashSync(password, cost)
}
