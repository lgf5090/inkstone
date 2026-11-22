import { describe, expect, it } from 'vitest'
import { officeFileAddress, officeListAddress, parseOfficeAddress } from './office-address'

describe('parseOfficeAddress', () => {
  it('reads the list with its smart view, folder, tag and query', () => {
    expect(parseOfficeAddress('/office')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: null, query: '' })
    expect(parseOfficeAddress('/office', '?view=trash')).toEqual({ kind: 'list', view: 'trash', folderId: null, tagId: null, query: '' })
    expect(parseOfficeAddress('/office', '?folder=f1')).toEqual({ kind: 'list', view: 'all', folderId: 'f1', tagId: null, query: '' })
    expect(parseOfficeAddress('/office', '?tag=t1')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: 't1', query: '' })
    expect(parseOfficeAddress('/office', '?q=budget')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: null, query: 'budget' })
  })

  it('reads every product as an editor address', () => {
    for (const type of ['sheets', 'docs', 'slides', 'bases', 'boards', 'pdfs'] as const) {
      expect(parseOfficeAddress(`/office/${type}/abc`)).toEqual({ kind: 'editor', fileType: type, fileId: 'abc' })
    }
  })

  it('falls back to the list for an unknown product or a malformed deep link', () => {
    expect(parseOfficeAddress('/office/canvas/abc')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: null, query: '' })
    expect(parseOfficeAddress('/office/sheets')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: null, query: '' })
    expect(parseOfficeAddress('/office/slides/a/b')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: null, query: '' })
  })

  it('keeps a trailing slash working and decodes the id', () => {
    expect(parseOfficeAddress('/office/')).toEqual({ kind: 'list', view: 'all', folderId: null, tagId: null, query: '' })
    expect(parseOfficeAddress('/office/docs/a%20b')).toEqual({ kind: 'editor', fileType: 'docs', fileId: 'a b' })
  })
})

describe('office addresses', () => {
  it('writes only the parameters that carry meaning', () => {
    expect(officeListAddress({ view: 'all', folderId: null, tagId: null, query: '' })).toBe('/office')
    expect(officeListAddress({ view: 'recent', folderId: null, tagId: null, query: '' })).toBe('/office?view=recent')
    expect(officeListAddress({ view: 'all', folderId: 'f1', tagId: null, query: '' })).toBe('/office?folder=f1')
    expect(officeListAddress({ view: 'all', folderId: null, tagId: 't1', query: 'x y' })).toBe('/office?tag=t1&q=x+y')
    expect(officeListAddress({ view: 'trash', folderId: 'ignored', tagId: null, query: '' })).toBe('/office?view=trash')
  })

  it('round-trips an editor address', () => {
    const address = officeFileAddress('pdfs', 'f-1')
    expect(address).toBe('/office/pdfs/f-1')
    expect(parseOfficeAddress(address)).toEqual({ kind: 'editor', fileType: 'pdfs', fileId: 'f-1' })
  })
})