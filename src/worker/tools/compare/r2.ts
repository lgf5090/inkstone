/**
 * R2 keys for the compare tool.
 *
 * `tools/compare/{images,txt,bin,dir}/{userId}/{assetId}{ext}` — one folder per kind, so a lifecycle
 * rule or a cleanup script can tell an image from a patch without reading a row. The asset id is the
 * name because it is the only thing the row and the object are guaranteed to share.
 */
import type { CompareKind } from '@shared/tools/compare/types'

const FOLDER: Readonly<Record<CompareKind, string>> = {
  image: 'images',
  text: 'txt',
  binary: 'bin',
  file: 'bin',
  dir: 'dir',
}

/** A short safe suffix; a filename is user text and never becomes part of a key. */
export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim())
  return match ? `.${match[1]!.toLowerCase()}` : ''
}

export function compareR2Key(kind: CompareKind, userId: string, assetId: string, filename: string): string {
  return `tools/compare/${FOLDER[kind]}/${userId}/${assetId}${extensionOf(filename)}`
}
