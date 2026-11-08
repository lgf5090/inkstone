import { strToU8, zipSync } from 'fflate'

export interface CerthubZipFile {
  path: string
  content: string
}

export function buildCerthubZip(files: CerthubZipFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const file of files) entries[file.path] = strToU8(file.content)
  return zipSync(entries, { level: 6 })
}
