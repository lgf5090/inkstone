import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { DraggerBlockStyle, EditorSettings } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { draggerBlockMenuEntries, isDraggerMenuGroup, styleToTemplate } from './menu-entries'

beforeAll(async () => {
  await initI18n()
})

const settings = (patch: Partial<EditorSettings> = {}): EditorSettings => ({ ...DEFAULT_SETTINGS.editor, ...patch })

describe('the handle menu', () => {
  it('offers every kind of block the note can become', () => {
    const entries = draggerBlockMenuEntries(settings())
    expect(entries.map((entry) => entry.id)).toEqual([
      'paragraph', 'heading', 'list', 'quote', 'callout', 'code-block', 'math-block',
    ])
    expect(entries.find((entry) => entry.id === 'custom')).toBeUndefined()
  })

  it('labels the rows in the language the reader is reading in', () => {
    const entries = draggerBlockMenuEntries(settings())
    const heading = entries.find((entry) => isDraggerMenuGroup(entry) && entry.id === 'heading')
    expect(heading && isDraggerMenuGroup(heading) && heading.options.map((option) => option.label))
      .toEqual([1, 2, 3, 4, 5, 6].map((level) => t('dragger.heading_level', { level })))
  })

  it('follows the reader’s own order, and the order of a group’s rows', () => {
    const reordered = draggerBlockMenuEntries(settings({
      draggerMenuOrders: {
        ...DEFAULT_SETTINGS.editor.draggerMenuOrders,
        root: ['list', 'paragraph', 'heading', 'quote', 'callout', 'code-block', 'math-block', 'custom'],
        list: ['list-task', 'list-unordered', 'list-ordered'],
      },
    }))
    expect(reordered[0].id).toBe('list')
    expect(reordered[1].id).toBe('paragraph')
    const list = reordered.find((entry) => entry.id === 'list')
    expect(list && isDraggerMenuGroup(list) && list.options.map((option) => option.id))
      .toEqual(['list-task', 'list-unordered', 'list-ordered'])
  })

  it('adds the custom group only once a style exists, and carries its glyph', () => {
    const style: DraggerBlockStyle = { id: 'style-1', label: 'Panel', icon: '🧩', template: ':::panel\n${content}\n:::' }
    const entries = draggerBlockMenuEntries(settings({
      draggerBlockStyles: [style],
      draggerMenuOrders: { ...DEFAULT_SETTINGS.editor.draggerMenuOrders, custom: ['style-1'] },
    }))
    const custom = entries.find((entry) => entry.id === 'custom')
    expect(custom && isDraggerMenuGroup(custom) && custom.options).toEqual([
      { id: 'style-1', label: 'Panel', icon: 'sparkles', glyph: '🧩', target: { template: style.template } },
    ])
  })

  it('drops a row whose style was deleted rather than offering nothing', () => {
    const entries = draggerBlockMenuEntries(settings({
      draggerBlockStyles: [],
      draggerMenuOrders: { ...DEFAULT_SETTINGS.editor.draggerMenuOrders, custom: ['gone'] },
    }))
    expect(entries.find((entry) => entry.id === 'custom')).toBeUndefined()
  })

  it('keeps the tokens a stored style declared', () => {
    const template = styleToTemplate({
      id: 'style-2', label: 'Quote', icon: '', template: '> ${content}', linePrefix: '> ', variables: { cite: 'me' },
    })
    expect(template).toEqual({ template: '> ${content}', linePrefix: '> ', variables: { cite: 'me' } })
  })
})
