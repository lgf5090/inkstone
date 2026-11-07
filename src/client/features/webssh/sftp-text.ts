/**
 * One bounded read of a remote text file over SFTP.
 *
 * The editor and the AI file dialog both need exactly this: a UTF-8 file within a size ceiling,
 * fetched in the same block sizes the download route serves, and refused as binary when it decodes
 * as anything else. Keeping one implementation means the two surfaces cannot disagree about what
 * "readable" means.
 */

import type { WebsshSftpEntry } from '@shared/webssh/types'
import { t } from '../../lib/i18n'
import { websshApi } from './api'

/** The most a browser-side text surface will hold; larger files stay a download. */
export const SFTP_TEXT_READ_LIMIT = 2 * 1024 * 1024

const MAX_BLOCKS = 64

export async function readSftpText(
  sessionId: string,
  entry: WebsshSftpEntry,
  limit = SFTP_TEXT_READ_LIMIT,
): Promise<string> {
  if (entry.size > limit) throw new Error(t('webssh.editor.too_large', { name: entry.name }))
  const chunks: Blob[] = []
  let offset = 0
  let total = entry.size
  for (let index = 0; index < MAX_BLOCKS; index += 1) {
    const response = await websshApi.download(sessionId, entry.path, offset)
    const headerSize = Number(response.headers.get('x-webssh-file-size') ?? '0')
    if (Number.isSafeInteger(headerSize) && headerSize > 0) total = headerSize
    const blob = await response.blob()
    chunks.push(blob)
    offset += blob.size
    if (blob.size === 0 || offset >= total) break
  }
  if (total > limit) throw new Error(t('webssh.editor.too_large', { name: entry.name }))
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
  if (bytes.includes(0)) throw new Error(t('webssh.editor.binary', { name: entry.name }))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(t('webssh.editor.binary', { name: entry.name }))
  }
}
