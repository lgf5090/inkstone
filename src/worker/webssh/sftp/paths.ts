// Remote path rules for W5. SFTP paths are absolute from the account root and may never contain a
// `..` segment, control characters or a runaway length; the normalized form is what gets stored.

import { WEBSSH_SFTP_MAX_NAME_LENGTH, WEBSSH_SFTP_MAX_PATH_LENGTH } from './limits'

export class SftpPathError extends Error {
  readonly code = 'invalid_path'

  constructor(message: string) {
    super(message)
    this.name = 'SftpPathError'
  }
}

/** Rejects traversal and control characters, then collapses `.` and duplicate separators. */
export function normalizeSftpPath(input: unknown): string {
  if (typeof input !== 'string') throw new SftpPathError('The path must be a string')
  if (input.length === 0 || input.length > WEBSSH_SFTP_MAX_PATH_LENGTH) {
    throw new SftpPathError('The path is empty or too long')
  }
  if (!input.startsWith('/')) throw new SftpPathError('The path must be absolute')
  if (/[\0-\x1f\x7f]/.test(input)) throw new SftpPathError('The path contains control characters')

  const segments: string[] = []
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new SftpPathError('Path traversal is not allowed')
    if (segment.length > WEBSSH_SFTP_MAX_NAME_LENGTH) throw new SftpPathError('A path segment is too long')
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export function joinRemotePath(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`
}

/** Directory names returned by a server must not smuggle separators back into the client path. */
export function isSafeRemoteName(name: string): boolean {
  return name.length > 0
    && name.length <= WEBSSH_SFTP_MAX_NAME_LENGTH
    && name !== '.'
    && name !== '..'
    && !/[/\0-\x1f\x7f]/.test(name)
}
