// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { sha256File } from './hash'

describe('CloudDrive file hash', () => {
  it('hashes a Blob incrementally with SHA-256', async () => {
    await expect(sha256File(new Blob(['abc']))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
