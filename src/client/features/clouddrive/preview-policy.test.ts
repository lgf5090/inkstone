import { describe, expect, it } from 'vitest'
import { DEFAULT_PREVIEW_RULES, parsePreviewRules, type CloudDrivePreviewRule } from '@shared/clouddrive/settings'
import { previewRendererFor } from '../file-preview/registry'
import { cloudDrivePreviewPolicy } from './preview-policy'

function rule(id: string, type: CloudDrivePreviewRule['type'], priority: number, extensions: string[]): CloudDrivePreviewRule {
  return { id, type, priority, extensions }
}

const target = (filename: string, mime = 'application/octet-stream') => ({ url: `/api/clouddrive/files/x/content`, filename, mime })

describe('cloudDrivePreviewPolicy', () => {
  it('names the renderer each rule type stands for', () => {
    const policy = cloudDrivePreviewPolicy(parsePreviewRules([
      rule('v', 'video', 90, ['mp4']),
      rule('a', 'audio', 90, ['mp3']),
      rule('i', 'image', 90, ['png']),
      rule('t', 'text', 10, ['md']),
      rule('o', 'office', 85, ['docx']),
      rule('n', 'none', 95, ['exe']),
    ]))
    expect(policy.byExtension.mp4).toBe('media')
    expect(policy.byExtension.mp3).toBe('media')
    expect(policy.byExtension.png).toBe('image')
    expect(policy.byExtension.md).toBe('text')
    expect(policy.byExtension.exe).toBeNull()
  })

  it('keeps an office extension with the viewer, which knows word from sheet from slide', () => {
    const policy = cloudDrivePreviewPolicy([rule('o', 'office', 85, ['docx', 'xlsx'])])
    expect(policy.byExtension.docx).toBe('native')
    expect(previewRendererFor(target('report.docx'), policy)).toBe('word')
    expect(previewRendererFor(target('grid.xlsx'), policy)).toBe('spreadsheet')
  })

  it('lets the higher priority rule claim an extension both of them name', () => {
    const both = parsePreviewRules([rule('wide', 'image', 90, ['md']), rule('narrow', 'text', 10, ['md'])])
    expect(Object.keys(cloudDrivePreviewPolicy(both).byExtension)).toEqual(['md'])
    expect(cloudDrivePreviewPolicy(both).byExtension.md).toBe('image')
  })

  it('leaves an extension the rules never mention unclaimed', () => {
    expect(cloudDrivePreviewPolicy(DEFAULT_PREVIEW_RULES.filter((one) => one.id === 'pdf')).byExtension.png).toBeUndefined()
  })

  it('refuses a preview the viewer could otherwise render', () => {
    const policy = cloudDrivePreviewPolicy([rule('block', 'none', 95, ['zip'])])
    expect(previewRendererFor(target('backup.zip'), policy)).toBeNull()
    expect(previewRendererFor(target('backup.zip'))).toBe('archive')
  })

  it('re-points an extension at another renderer', () => {
    const policy = cloudDrivePreviewPolicy([rule('plain', 'text', 95, ['pdf'])])
    expect(previewRendererFor(target('a.pdf', 'application/pdf'), policy)).toBe('text')
    expect(previewRendererFor(target('a.pdf', 'application/pdf'))).toBe('pdf')
  })

  it('does not read an inherited member as a policy answer', () => {
    expect(previewRendererFor(target('notes.constructor'), cloudDrivePreviewPolicy([]))).toBeNull()
  })
})
