import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants'

const editor = (value: unknown) => mergeSettings({ editor: value }).editor

describe('the dragger settings', () => {
  it('starts on, on hover, with the six-dot grip', () => {
    expect(editor({}).dragger).toBe(true)
    expect(editor({}).draggerHandles).toBe('hover')
    expect(editor({}).draggerHandleIcon).toBe('grip-dots')
    expect(editor({}).draggerMenuOrders.root).toEqual(DEFAULT_SETTINGS.editor.draggerMenuOrders.root)
  })

  it('keeps a number inside the range the slider offers', () => {
    expect(editor({ draggerHandleSize: 999 }).draggerHandleSize).toBe(28)
    expect(editor({ draggerHandleSize: 1 }).draggerHandleSize).toBe(12)
    expect(editor({ draggerHandleOffset: -5000 }).draggerHandleOffset).toBe(-80)
    expect(editor({ draggerMobileArmMs: 'x' }).draggerMobileArmMs).toBe(200)
  })

  it('refuses a colour that is not a colour and a mode that is not a mode', () => {
    expect(editor({ draggerHandleColor: 'red; } body { display:none' }).draggerHandleColor).toBe(DEFAULT_SETTINGS.editor.draggerHandleColor)
    expect(editor({ draggerHandleColor: ' #0A0a0A ' }).draggerHandleColor).toBe('#0a0a0a')
    expect(editor({ draggerHandleSide: 'middle' }).draggerHandleSide).toBe('left')
    expect(editor({ draggerSelectionStyle: 'rainbow' }).draggerSelectionStyle).toBe('subtle')
  })

  it('never lets a grip be drawn with nothing in it', () => {
    expect(editor({ draggerHandleGlyph: '' }).draggerHandleGlyph).toBe(DEFAULT_SETTINGS.editor.draggerHandleGlyph)
    expect(editor({ draggerHandleGlyph: 'a\tb\u0000c' }).draggerHandleGlyph).toBe('abc')
    expect(editor({ draggerHandleGlyph: '123456789' }).draggerHandleGlyph).toHaveLength(4)
  })

  it('keeps only the custom styles that can actually write a block', () => {
    const styles = editor({
      draggerBlockStyles: [
        { id: 'ok-1', label: 'Panel', icon: '🧩', template: ':::panel\n${content}\n:::', linePrefix: '> ', variables: { cite: 'x', content: 'no' } },
        { id: 'ok-1', label: 'dupe', icon: '', template: '${content}' },
        { id: 'no token', label: 'Bad', icon: '', template: '> nothing here' },
        { id: 'ok-2', label: '   ', icon: '', template: '${content}' },
        { id: '<script>', label: 'Xss', icon: '<img src=x>', template: '${content}' },
        { id: 'ok-3', label: 'Quote', icon: '❝❝❞❝❞❝❞❝❞', template: '> ${content}', linePrefix: '\n\n> ', variables: { 'has space': 'v' } },
      ],
    }).draggerBlockStyles
    expect(styles.map((style) => style.id)).toEqual(['ok-1', 'ok-3'])
    expect(styles[0].variables).toEqual({ cite: 'x' })
    expect(styles[0].icon).toBe('🧩')
    const third = editor({ draggerBlockStyles: [{ id: 'ok-3', label: 'Quote', icon: 'x', template: '> ${content}', linePrefix: '\n\n> ' }] }).draggerBlockStyles[0]
    expect(third.linePrefix).toBe('> ')
  })

  it('keeps a line prefix that is only spaces, because that is an indent', () => {
    const style = editor({ draggerBlockStyles: [{ id: 'a', label: 'A', icon: '', template: '${content}', linePrefix: '  ' }] }).draggerBlockStyles[0]
    expect(style.linePrefix).toBe('  ')
  })

  it('repairs a menu order rather than trusting it', () => {
    const orders = editor({
      draggerMenuOrders: {
        root: ['heading', 'heading', 'bogus'],
        heading: ['heading-6'],
        list: ['list-ordered', 'list-unordered', 'list-task'],
        callout: DEFAULT_SETTINGS.editor.draggerMenuOrders.callout,
        custom: ['ghost'],
      },
    }).draggerMenuOrders
    expect(orders.root).toEqual(DEFAULT_SETTINGS.editor.draggerMenuOrders.root)
    expect(orders.heading).toEqual(['heading-6', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5'])
    expect(orders.list).toEqual(['list-ordered', 'list-unordered', 'list-task'])
    expect(orders.custom).toEqual([])
  })

  it('keeps a stored order by reference when nothing about it changed', () => {
    const base = mergeSettings({})
    const patched = mergeSettingsPatch(base, { appearance: { proseSize: 18 } })
    expect(patched.editor).toBe(base.editor)
    expect(patched.editor.draggerMenuOrders).toBe(base.editor.draggerMenuOrders)
    expect(patched.editor.draggerBlockStyles).toBe(base.editor.draggerBlockStyles)
  })

  it('carries a changed order through a patch', () => {
    const base = mergeSettings({})
    const next = mergeSettingsPatch(base, {
      editor: { draggerMenuOrders: { ...base.editor.draggerMenuOrders, root: [...base.editor.draggerMenuOrders.root].reverse() } },
    })
    expect(next.editor.draggerMenuOrders.root[0]).toBe('custom')
    expect(next.editor.draggerMenuOrders.root).not.toBe(base.editor.draggerMenuOrders.root)
  })
})
