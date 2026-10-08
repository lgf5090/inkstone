import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { EditorSettings } from '@shared/types'
import { applyDraggerPresentation, clearDraggerPresentation, draggerPresentation, quoteForCss } from './presentation'

const settings = (patch: Partial<EditorSettings> = {}): EditorSettings => ({ ...DEFAULT_SETTINGS.editor, ...patch })

describe('the dragger presentation', () => {
  it('follows the accent until the reader picks a colour', () => {
    expect(draggerPresentation(settings(), { dragModeEnabled: false }).cssProps['--ink-dragger-handle-color'])
      .toBe('var(--accent)')
    const custom = draggerPresentation(settings({ draggerHandleColorMode: 'custom', draggerHandleColor: '#123456' }),
      { dragModeEnabled: false })
    expect(custom.cssProps['--ink-dragger-handle-color']).toBe('#123456')
  })

  it('leaves the seam unset in theme mode so the stylesheet’s own fallback wins', () => {
    expect(draggerPresentation(settings(), { dragModeEnabled: false }).cssProps['--ink-dragger-seam-color']).toBe('')
    expect(draggerPresentation(settings({ draggerIndicatorColorMode: 'custom', draggerIndicatorColor: '#abcdef' }),
      { dragModeEnabled: false }).cssProps['--ink-dragger-seam-color']).toBe('#abcdef')
  })

  it('says which grip to draw, where it sits, and how the carried block is painted', () => {
    const presentation = draggerPresentation(settings({ draggerHandleIcon: 'square', draggerHandleSide: 'right', draggerSelectionStyle: 'filled' }),
      { dragModeEnabled: true })
    expect(presentation.attributes['data-ink-dragger-icon']).toBe('square')
    expect(presentation.attributes['data-ink-dragger-side']).toBe('right')
    expect(presentation.attributes['data-ink-dragger-style']).toBe('filled')
    expect(presentation.classes['ink-dragger-drag-mode']).toBe(true)
  })

  it('turns the visibility choice into a class, and only that class', () => {
    expect(draggerPresentation(settings({ draggerHandles: 'always' }), { dragModeEnabled: false }).classes)
      .toMatchObject({ 'ink-dragger-handles-always': true, 'ink-dragger-handles-hidden': false })
    expect(draggerPresentation(settings({ draggerHandles: 'hidden' }), { dragModeEnabled: false }).classes)
      .toMatchObject({ 'ink-dragger-handles-always': false, 'ink-dragger-handles-hidden': true })
  })

  it('sizes the grip and its marks from one number', () => {
    const cssProps = draggerPresentation(settings({ draggerHandleSize: 28 }), { dragModeEnabled: false }).cssProps
    expect(cssProps['--ink-dragger-handle-size']).toBe('28px')
    expect(cssProps['--ink-dragger-handle-core-size']).toBe('15px')
    expect(parseFloat(cssProps['--ink-dragger-grip-dots-size'])).toBeGreaterThan(1)
  })

  it('quotes a custom glyph so a quote in it cannot end the content value', () => {
    expect(quoteForCss('a"b')).toBe('"a\\"b"')
    expect(draggerPresentation(settings({ draggerHandleGlyph: '★' }), { dragModeEnabled: false })
      .cssProps['--ink-dragger-handle-glyph']).toBe('"★"')
  })

  it('writes the presentation onto an element and takes exactly that away again', () => {
    const root = document.createElement('html')
    const presentation = draggerPresentation(settings({ draggerHandles: 'always', draggerHandleColorMode: 'custom' }),
      { dragModeEnabled: true })
    applyDraggerPresentation(root, presentation)
    expect(root.className).toContain('ink-dragger-handles-always')
    expect(root.getAttribute('data-ink-dragger-icon')).toBe('grip-dots')
    expect(root.style.getPropertyValue('--ink-dragger-handle-color')).toBe(DEFAULT_SETTINGS.editor.draggerHandleColor)
    clearDraggerPresentation(root, presentation)
    expect(root.className).not.toContain('ink-dragger-handles-always')
    expect(root.hasAttribute('data-ink-dragger-icon')).toBe(false)
    expect(root.style.getPropertyValue('--ink-dragger-handle-color')).toBe('')
  })
})
