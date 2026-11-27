import { sha256 } from '@noble/hashes/sha2.js'

export async function sha256File(file: Blob): Promise<string> {
  const hash = sha256.create()
  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) hash.update(value)
  }
  return [...hash.digest()].map((value) => value.toString(16).padStart(2, '0')).join('')
}
