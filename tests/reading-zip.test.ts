import { describe, expect, it } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { openZip, ZipFormatError } from '../src/client/features/reading/engine/zip'
import { makeZip } from './reading-fixtures'

const bytes = (value: string) => new TextEncoder().encode(value)
const compress = (value: Uint8Array) => new Uint8Array(deflateRawSync(value))
const read = async (archive: Awaited<ReturnType<typeof openZip>>, name: string) =>
  new TextDecoder().decode(await archive.read(name))

describe('openZip', () => {
  it('reads a deflated member back', async () => {
    const data = bytes('hello reader '.repeat(40))
    const archive = await openZip(makeZip([{ name: 'a.txt', raw: data, payload: compress(data) }]).bytes)
    expect(await read(archive, 'a.txt')).toBe('hello reader '.repeat(40))
  })

  it('reads a stored member back', async () => {
    const data = bytes('application/epub+zip')
    const archive = await openZip(makeZip([{ name: 'mimetype', raw: data, payload: data, method: 0 }]).bytes)
    expect(await read(archive, 'mimetype')).toBe('application/epub+zip')
  })

  it('keeps every member addressable without decompressing the rest', async () => {
    const archive = await openZip(makeZip([
      { name: 'one.txt', raw: bytes('1'), payload: bytes('1'), method: 0 },
      { name: 'two.txt', raw: bytes('2'), payload: bytes('2'), method: 0 },
      { name: 'three.txt', raw: bytes('3'), payload: bytes('3'), method: 0 },
    ]).bytes)
    expect(archive.entries.map((entry) => entry.name)).toEqual(['one.txt', 'two.txt', 'three.txt'])
    expect(await read(archive, 'three.txt')).toBe('3')
  })

  it('answers a percent-encoded reference for a decoded member name', async () => {
    const data = bytes('ok')
    const archive = await openZip(makeZip([{ name: 'OEBPS/第 1 章.xhtml', raw: data, payload: data, method: 0 }]).bytes)
    expect(archive.has('OEBPS/%E7%AC%AC%201%20%E7%AB%A0.xhtml')).toBe(true)
    expect(await read(archive, 'OEBPS/%E7%AC%AC 1 %E7%AB%A0.xhtml')).toBe('ok')
  })

  it('looks a path up regardless of how the archiver folded its case', async () => {
    const data = bytes('body{}')
    const archive = await openZip(makeZip([{ name: 'OEBPS/Style/main.css', raw: data, payload: data, method: 0 }]).bytes)
    expect(archive.has('oebps/style/MAIN.CSS')).toBe(true)
  })

  it('tolerates a leading slash and an archive comment', async () => {
    const data = bytes('a')
    const archive = await openZip(makeZip([{ name: 'a.txt', raw: data, payload: data, method: 0 }], 'tailer').bytes)
    expect(await read(archive, '/a.txt')).toBe('a')
  })

  it('refuses something that is not a ZIP at all', async () => {
    await expect(openZip(bytes('%PDF-1.7 and then nothing a directory would explain')))
      .rejects.toBeInstanceOf(ZipFormatError)
  })

  it('names the DRM case instead of failing on a header', async () => {
    const archive = makeZip([{ name: 'secret.txt', raw: bytes('x'), payload: bytes('x'), method: 0 }])
    new DataView(archive.bytes.buffer).setUint16(archive.directoryAt + 8, 1, true)
    await expect(openZip(archive.bytes).then((zip) => zip.read('secret.txt'))).rejects.toThrow(/DRM/)
  })

  it('catches an archive whose directory points past the end of the file', async () => {
    const data = bytes('hello')
    const archive = makeZip([{ name: 'a.txt', raw: data, payload: data }])
    new DataView(archive.bytes.buffer).setUint32(archive.eocdAt + 16, archive.bytes.byteLength + 100, true)
    await expect(openZip(archive.bytes)).rejects.toThrow(/out of range/)
  })

  it('refuses a member that decompresses to less than its directory claims', async () => {
    const data = bytes('hello hello hello')
    const archive = makeZip([{ name: 'a.txt', raw: data, payload: compress(data) }])
    new DataView(archive.bytes.buffer).setUint32(archive.directoryAt + 24, 10_000, true)
    await expect(openZip(archive.bytes).then((zip) => zip.read('a.txt'))).rejects.toThrow(/smaller than/)
  })

  it('refuses a compression method nobody supports any more', async () => {
    const data = bytes('hello')
    const archive = makeZip([{ name: 'a.txt', raw: data, payload: data, method: 12 }])
    await expect(openZip(archive.bytes).then((zip) => zip.read('a.txt'))).rejects.toThrow(/compression/)
  })
})
