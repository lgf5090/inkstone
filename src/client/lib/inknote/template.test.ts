import { describe, expect, it } from 'vitest'
import type { InknoteTemplate } from '@shared/inknote/types'
import { BUILTIN_TEMPLATES } from '@shared/inknote/constants'
import { templateContent, templateName, templateTitle } from './template'

const translate = (key: string) => (key.endsWith('_sub') ? 'sub line' : 'Lecture notes')

describe('templateContent', () => {
  it('writes the built-in title and subtitle as text boxes', () => {
    const template = BUILTIN_TEMPLATES[0]!
    const content = templateContent(template, translate, { width: 816, height: 1056 })
    expect(content.texts).toHaveLength(2)
    expect(content.texts[0]).toMatchObject({ text: 'Lecture notes', fontSize: template.titleSize, bold: true })
    expect(content.texts[1]!.text).toBe('sub line')
    expect(content.texts[0]!.id).not.toBe(content.texts[1]!.id)
    expect(content.bg).toBeNull()
  })

  it('gives a saved template fresh ids and its background', () => {
    const saved: InknoteTemplate = {
      id: 'tpl-1', name: 'My page', paper: { style: 'line', color: 'white', spacing: 'normal' },
      bgAssetId: 'asset-1', bgUrl: '/api/inknote/assets/asset-1',
      texts: [{ id: 'old', x: 0.1, y: 0.1, w: 0.5, h: 0.1, text: 'mine', fontSize: 26, color: '#111111', align: 'left', bold: false, italic: false, underline: false, hl: null, lh: 1.3, list: null }],
      title: '', sub: '', titleSize: 30, subSize: 15, builtIn: false, createdAt: 1,
    }
    const content = templateContent(saved, translate, { width: 900, height: 1200 })
    expect(content.texts).toHaveLength(1)
    expect(content.texts[0]!.id).not.toBe('old')
    expect(content.texts[0]!.text).toBe('mine')
    expect(content.bg).toMatchObject({ assetId: 'asset-1', width: 900, height: 1200, alpha: 1 })
  })

  it('names built-ins through i18n and saved templates literally', () => {
    const builtIn = BUILTIN_TEMPLATES[0]!
    expect(templateName(builtIn, translate)).toBe('Lecture notes')
    expect(templateTitle(builtIn, translate)).toBe('Lecture notes')
    expect(templateName({ ...builtIn, builtIn: false, name: 'Mine', title: '' }, (key) => key)).toBe('Mine')
  })
})
