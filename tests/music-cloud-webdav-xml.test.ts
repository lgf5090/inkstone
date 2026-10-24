import { describe, expect, it } from 'vitest'
import { decodeHrefPath, isMediaEntry, parseMultistatus } from '../src/worker/music/cloud/webdav-xml'

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/music/</D:href>
    <D:propstat><D:prop>
      <D:resourcetype><D:collection/></D:resourcetype>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/music/Album/</D:href>
    <D:propstat><D:prop>
      <D:resourcetype><D:collection/></D:resourcetype>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/music/%E6%9C%88%E5%85%89.mp3</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/>
      <D:getcontentlength>4382</D:getcontentlength>
      <D:getcontenttype>audio/mpeg</D:getcontenttype>
      <D:getlastmodified>Wed, 10 Sep 2026 12:00:00 GMT</D:getlastmodified>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/music/notes.txt</D:href>
    <D:propstat><D:prop>
      <D:resourcetype/>
      <D:getcontentlength>10</D:getcontentlength>
      <D:getcontenttype>text/plain</D:getcontenttype>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`

describe('webdav multistatus parsing', () => {
  it('extracts hrefs, collections, sizes and timestamps', () => {
    const { entries, truncated } = parseMultistatus(MULTISTATUS)
    expect(truncated).toBe(false)
    expect(entries).toHaveLength(4)
    expect(entries[0]).toMatchObject({ href: '/dav/music/', isCollection: true })
    expect(entries[2]).toMatchObject({ href: '/dav/music/%E6%9C%88%E5%85%89.mp3', isCollection: false, sizeBytes: 4382, mime: 'audio/mpeg' })
    expect(entries[2]!.modifiedAt).toBe(Date.parse('Wed, 10 Sep 2026 12:00:00 GMT'))
  })

  it('tolerates namespace-free and lowercase tags', () => {
    const plain = '<multistatus><response><href>/a/b.mp3</href><propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop></propstat></response></multistatus>'
    const { entries } = parseMultistatus(plain)
    expect(entries).toEqual([{ href: '/a/b.mp3', isCollection: false, sizeBytes: 7, mime: null, modifiedAt: null }])
  })

  it('returns nothing for an empty or unrelated body', () => {
    expect(parseMultistatus('')).toEqual({ entries: [], truncated: false })
    expect(parseMultistatus('<html><body>nope</body></html>')).toEqual({ entries: [], truncated: false })
  })

  it('decodes percent-encoded paths and falls back on malformed escapes', () => {
    expect(decodeHrefPath('/dav/music/%E6%9C%88%E5%85%89.mp3')).toBe('/dav/music/\u6708\u5149.mp3')
    expect(decodeHrefPath('/dav/music/%E0%A4%A.mp3')).toBe('/dav/music/%E0%A4%A.mp3')
    expect(decodeHrefPath('https://cloud.example.com/dav/a%20b.mp3')).toBe('/dav/a b.mp3')
  })

  it('keeps out-of-range numeric entities as literal text instead of throwing', () => {
    const xml = '<D:multistatus><D:response><D:href>/dav/music/song&#99999999999;.mp3</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontenttype>audio/mpeg</D:getcontenttype></D:prop></D:propstat></D:response>'
      + '<D:response><D:href>/dav/music/night&#77;song.mp3</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response></D:multistatus>'
    const entries = parseMultistatus(xml).entries
    expect(entries).toHaveLength(2)
    expect(entries[0]!.href).toBe('/dav/music/song&#99999999999;.mp3')
    expect(entries[1]!.href).toBe('/dav/music/nightMsong.mp3')
  })
})

describe('webdav listing filter', () => {
  it('keeps collections and audio files, dropping other files', () => {
    const [root, , song, notes] = parseMultistatus(MULTISTATUS).entries
    expect(isMediaEntry(root!)).toBe(true)
    expect(isMediaEntry(song!)).toBe(true)
    expect(isMediaEntry(notes!)).toBe(false)
  })

  it('treats an audio mime without a known extension as audio', () => {
    expect(isMediaEntry({ href: 'track.bin', isCollection: false, sizeBytes: 1, mime: 'audio/flac', modifiedAt: null })).toBe(true)
    expect(isMediaEntry({ href: 'track.opus', isCollection: false, sizeBytes: 1, mime: null, modifiedAt: null })).toBe(true)
  })

  it('lists video files so a remote clip can be imported', () => {
    expect(isMediaEntry({ href: 'concert.mov', isCollection: false, sizeBytes: 1, mime: null, modifiedAt: null })).toBe(true)
    expect(isMediaEntry({ href: 'clip.bin', isCollection: false, sizeBytes: 1, mime: 'video/mp4', modifiedAt: null })).toBe(true)
    expect(isMediaEntry({ href: 'readme.md', isCollection: false, sizeBytes: 1, mime: 'text/markdown', modifiedAt: null })).toBe(false)
  })
})

describe('webdav listing caps', () => {
  it('marks listings beyond the entry cap as truncated', () => {
    const blocks = Array.from({ length: 2001 }, (_unused, index) => `<response><href>/d/t${index}.mp3</href></response>`).join('')
    const result = parseMultistatus(`<multistatus>${blocks}</multistatus>`)
    expect(result.entries).toHaveLength(2000)
    expect(result.truncated).toBe(true)
  })
})
