import { describe, expect, it } from 'vitest'
import { createFolderTree, planFolderUpload, type FolderUploadApi, type FolderFile } from './folder-upload'

function file(path: string): FolderFile {
  const segments = path.split('/')
  return { name: segments[segments.length - 1]!, webkitRelativePath: path }
}

describe('planFolderUpload', () => {
  it('lists every ancestor once, parents before children', () => {
    const plan = planFolderUpload([file('shots/2020/jan/a.jpg'), file('shots/2020/feb/b.jpg'), file('shots/cover.png')])
    expect(plan.directories).toEqual(['shots', 'shots/2020', 'shots/2020/feb', 'shots/2020/jan'])
    expect(plan.files.map((one) => [one.directory, one.name])).toEqual([
      ['shots/2020/jan', 'a.jpg'],
      ['shots/2020/feb', 'b.jpg'],
      ['shots', 'cover.png'],
    ])
  })

  it('keeps a plain multi-select where it always went: the open folder', () => {
    const plan = planFolderUpload([{ name: 'loose.txt' }])
    expect(plan.directories).toEqual([])
    expect(plan.files).toEqual([{ file: { name: 'loose.txt' }, directory: '', name: 'loose.txt' }])
  })

  it('normalises windows separators and a leading slash', () => {
    const plan = planFolderUpload([{ name: 'x.txt', webkitRelativePath: '\\a\\b\\x.txt' }])
    expect(plan.directories).toEqual(['a', 'a/b'])
    expect(plan.files[0]!.directory).toBe('a/b')
  })
})

describe('createFolderTree', () => {
  it('creates each segment under the folder its parent resolved to, and reuses existing ones', async () => {
    const calls: { parent: string; name: string; conflict?: string }[] = []
    const api: FolderUploadApi = {
      mkdir: async (body) => {
        calls.push({ parent: body.parentPath, name: body.name, conflict: body.conflict })
        return {}
      },
    }
    const plan = planFolderUpload([file('shots/2020/jan/a.jpg')])
    const resolved = await createFolderTree(api, 'primary', '/docs', plan)
    expect(calls).toEqual([
      { parent: '/docs', name: 'shots', conflict: 'reuse' },
      { parent: '/docs/shots', name: '2020', conflict: 'reuse' },
      { parent: '/docs/shots/2020', name: 'jan', conflict: 'reuse' },
    ])
    expect(resolved.get('shots/2020/jan')).toBe('/docs/shots/2020/jan')
    expect(resolved.get('')).toBe('/docs')
  })

  it('drops the files of a folder it could not make and reports which one failed', async () => {
    const failed: string[] = []
    const api: FolderUploadApi = {
      mkdir: async (body) => {
        if (body.name === 'bad') throw new Error('nope')
        return {}
      },
    }
    const plan = planFolderUpload([file('bad/a.jpg'), file('good/b.jpg')])
    const resolved = await createFolderTree(api, 'primary', '/', plan, (path) => failed.push(path))
    expect(failed).toEqual(['bad'])
    expect(resolved.has('bad')).toBe(false)
    expect(resolved.get('good')).toBe('/good')
  })

  it('maps a top-level file to the open folder itself', async () => {
    const api: FolderUploadApi = { mkdir: async () => ({}) }
    const plan = planFolderUpload([{ name: 'loose.txt' }])
    const resolved = await createFolderTree(api, 'primary', '/x', plan)
    expect(resolved.get('')).toBe('/x')
  })
})
