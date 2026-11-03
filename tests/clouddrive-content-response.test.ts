// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { entityTagOf, planContentResponse } from '../src/worker/clouddrive/content-response'

const FILE = { id: 'file-1', size: 10, mime: 'text/plain', name: 'notes.txt', etag: null, lastModified: 1_700_000_000_000 }

function plan(overrides: Record<string, unknown> = {}) {
  return planContentResponse({
    method: 'GET',
    rangeHeader: null,
    ifNoneMatch: null,
    download: false,
    file: FILE,
    ...overrides,
  })
}

describe('cloud drive content response plan', () => {
  it('answers a matching entity tag without touching storage', () => {
    const planned = plan({ ifNoneMatch: entityTagOf(FILE) })
    expect(planned.kind).toBe('respond')
    if (planned.kind !== 'respond') return
    expect(planned.response.status).toBe(304)
    expect(planned.response.headers.get('etag')).toBe('"file-1-10"')
  })

  it('refuses an unsatisfiable range and keeps no disposition on the reply', () => {
    const planned = plan({ rangeHeader: 'bytes=99-120' })
    expect(planned.kind).toBe('respond')
    if (planned.kind !== 'respond') return
    expect(planned.response.status).toBe(416)
    expect(planned.response.headers.get('content-range')).toBe('bytes */10')
    expect(planned.response.headers.get('content-disposition')).toBeNull()
  })

  it('plans a suffix range into the same shape as a prefix one', () => {
    const planned = plan({ rangeHeader: 'bytes=-4' })
    expect(planned.kind).toBe('serve')
    if (planned.kind !== 'serve') return
    expect(planned).toMatchObject({ status: 206, offset: 6, length: 4 })
    expect(planned.headers.get('content-range')).toBe('bytes 6-9/10')
    expect(planned.headers.get('content-length')).toBe('4')
  })

  it('advertises the same capability set on every reply', () => {
    const planned = plan({ file: { ...FILE, mime: 'image/png', name: 'shot.png' } })
    if (planned.kind !== 'serve') throw new Error('expected a serve plan')
    expect(planned.status).toBe(200)
    expect(planned.headers.get('accept-ranges')).toBe('bytes')
    expect(planned.headers.get('content-disposition')).toContain('inline')
    expect(planned.headers.get('x-content-type-options')).toBe('nosniff')
    expect(planned.headers.get('last-modified')).toContain('GMT')
  })

  it('keeps a type the browser would run as a download', () => {
    const planned = plan()
    if (planned.kind !== 'serve') throw new Error('expected a serve plan')
    expect(planned.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('turns a download into an attachment without losing the name', () => {
    const planned = plan({ file: { ...FILE, mime: 'image/png', name: 'shot.png' }, download: true })
    if (planned.kind !== 'serve') throw new Error('expected a serve plan')
    expect(planned.headers.get('content-disposition')).toMatch(/^attachment; filename\*=UTF-8''shot\.png/)
  })

  it('hands a HEAD to the caller with the length already decided', () => {
    const planned = plan({ method: 'HEAD', rangeHeader: 'bytes=0-3' })
    expect(planned.kind).toBe('head')
    if (planned.kind !== 'head') return
    expect(planned.status).toBe(206)
    expect(planned.headers.get('content-length')).toBe('4')
  })

  it('keeps a stored entity tag rather than recomputing one', () => {
    expect(entityTagOf({ id: 'x', size: 1, etag: 'W/"abc"' })).toBe('"abc"')
    expect(entityTagOf({ id: 'x', size: 1, etag: null })).toBe('"x-1"')
  })
})
