// @vitest-environment jsdom
/**
 * The shared button, as the one line of text it has to render.
 *
 * Tailwind's preflight makes every `svg` a block box. A call site that passes its icon as a child
 * (`<Button><Upload/> Import</Button>`) used to put that block inside a plain span, so the glyph took
 * a line of its own and the words dropped under it — exactly what the data page's import button showed.
 * Both ways of passing an icon now land in the button's own inline row.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Upload } from 'lucide-react'
import { initI18n } from '../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../lib/test-render'
import { Button } from './primitives'

let rendered: RenderedElement | null = null

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
})

/** The span that holds the words, whichever slot the icon arrived in. */
const labelSpan = (label: string) => [...(rendered!.container.querySelectorAll<HTMLElement>('button span') ?? [])]
  .find((node) => node.textContent?.trim() === label)

describe('a button with an icon', () => {
  it('keeps an icon passed as a child in the same inline row as the words', () => {
    rendered = renderElement(createElement(Button, { size: 'sm' }, createElement(Upload, { size: 14 }), 'Import'))
    const label = labelSpan('Import')
    expect(label, 'the label span is not rendered').toBeTruthy()
    // A row, not a plain inline span: a block-level svg inside the latter breaks the line after it.
    expect(label!.className).toContain('inline-flex')
    expect(label!.className).toContain('truncate')
    expect(label!.querySelector('svg'), 'the icon does not travel with its label').toBeTruthy()
  })

  it('keeps an icon passed through the icon slot out of the label span', () => {
    rendered = renderElement(createElement(Button, { size: 'sm', icon: createElement(Upload, { size: 14 }) }, 'Export'))
    const button = rendered.container.querySelector('button')!
    // The icon slot stays the button's own direct flex child: a wrapper would change the DOM every
    // existing call-site test (and assistive technology's reading of the row) for no rendering gain.
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe('svg')
    expect(labelSpan('Export')?.querySelector('svg')).toBeFalsy()
  })
})
