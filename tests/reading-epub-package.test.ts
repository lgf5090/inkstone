import { describe, expect, it } from 'vitest'
import { openZip } from '../src/client/features/reading/engine/zip'
import {
  EpubFormatError,
  parseEpubPackage,
  resolvePackagePath,
  spineIndexFor,
} from '../src/client/features/reading/engine/epub-package'
import { CONTAINER_XML, fixtureEpub, makeZip } from './reading-fixtures'

const text = (value: string) => new TextEncoder().encode(value)

async function packageOf(bytes: Uint8Array) {
  return parseEpubPackage(await openZip(bytes))
}

describe('resolvePackagePath', () => {
  it('joins a reference onto the package document’s own directory', () => {
    expect(resolvePackagePath('OEBPS', 'text/ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml')
  })

  it('collapses dot segments without letting a book escape itself', () => {
    expect(resolvePackagePath('OEBPS/text', '../nav.xhtml')).toBe('OEBPS/nav.xhtml')
    expect(resolvePackagePath('OEBPS/text', '../../../../etc/passwd')).toBe('etc/passwd')
  })

  it('keeps a space where the archiver wrote an escape', () => {
    expect(resolvePackagePath('OEBPS/text', 'chapter%202.xhtml')).toBe('OEBPS/text/chapter 2.xhtml')
  })

  it('drops the fragment it was never meant to carry', () => {
    expect(resolvePackagePath('OEBPS', 'text/ch1.xhtml#scene')).toBe('OEBPS/text/ch1.xhtml')
  })
})

describe('parseEpubPackage', () => {
  it('reads the bibliographic metadata', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(pkg.metadata).toMatchObject({
      title: '测试书 · A Test Book',
      creator: '某作者',
      language: 'zh-CN',
      identifier: 'urn:uuid:1234',
    })
  })

  it('lists the spine in reading order with package-relative paths', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(pkg.spine.map((item) => item.item.href)).toEqual([
      'OEBPS/text/chapter1.xhtml',
      'OEBPS/text/chapter 2.xhtml',
    ])
  })

  it('drops an itemref whose idref the manifest never defined', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(pkg.spine.some((item) => item.idref === 'missing')).toBe(false)
  })

  it('takes the contents from the nav document, with nesting and resolved targets', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(pkg.toc).toEqual([
      { label: '第一章', href: 'OEBPS/text/chapter1.xhtml', level: 0 },
      { label: '第一场', href: 'OEBPS/text/chapter1.xhtml#scene', level: 1 },
      { label: '第二章', href: 'OEBPS/text/chapter 2.xhtml', level: 0 },
    ])
  })

  it('falls back to the NCX when the book has no nav document', async () => {
    const pkg = await packageOf(fixtureEpub({ nav: false }))
    // The two navPoints are written out of order in the fixture: playOrder, not document order, wins.
    expect(pkg.toc).toEqual([
      { label: 'Chapter One', href: 'OEBPS/text/chapter1.xhtml', level: 0 },
      { label: 'Chapter Two', href: 'OEBPS/text/chapter 2.xhtml', level: 0 },
    ])
  })

  it('finds the cover through the metadata reference', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(pkg.coverHref).toBe('OEBPS/images/cover.png')
  })

  it('carries a right-to-left book', async () => {
    expect((await packageOf(fixtureEpub({ direction: 'rtl' }))).direction).toBe('rtl')
    expect((await packageOf(fixtureEpub())).direction).toBe('ltr')
  })

  it('indexes manifest items by path so a contents href can be resolved', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(pkg.byPath.get('OEBPS/style.css')?.mediaType).toBe('text/css')
  })

  it('maps a contents entry back to its spine slot', async () => {
    const pkg = await packageOf(fixtureEpub())
    expect(spineIndexFor(pkg, 'OEBPS/text/chapter 2.xhtml')).toBe(1)
    expect(spineIndexFor(pkg, 'OEBPS/text/chapter1.xhtml#scene')).toBe(0)
    expect(spineIndexFor(pkg, 'OEBPS/nowhere.xhtml')).toBe(-1)
  })

  it('refuses an archive that is not an EPUB', async () => {
    const notABook = makeZip([{ name: 'page-01.png', raw: text('x'), payload: text('x'), method: 0 }])
    await expect(packageOf(notABook.bytes)).rejects.toBeInstanceOf(EpubFormatError)
  })

  it('refuses a package document that is not well-formed XML', async () => {
    const broken = makeZip([
      { name: 'META-INF/container.xml', raw: text(CONTAINER_XML), payload: text(CONTAINER_XML), method: 0 },
      { name: 'OEBPS/content.opf', raw: text('<package><oops>'), payload: text('<package><oops>'), method: 0 },
    ])
    await expect(packageOf(broken.bytes)).rejects.toBeInstanceOf(EpubFormatError)
  })

  it('refuses a container that names no root document', async () => {
    const noRoot = makeZip([
      { name: 'META-INF/container.xml', raw: text('<container/>'), payload: text('<container/>'), method: 0 },
    ])
    await expect(packageOf(noRoot.bytes)).rejects.toThrow(/root document/)
  })
})
