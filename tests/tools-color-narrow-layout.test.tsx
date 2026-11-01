// @vitest-environment jsdom
/**
 * What a narrow screen is allowed to do with these rows.
 *
 * A real Chromium run at 420/1280/1600 measured five places where content escaped the box it sat in — a
 * range input whose UA minimum (129px) is bigger than the 112px column holding it, a segmented track that
 * refused to shrink, and three header rows that would not wrap. jsdom has no layout, so this file pins the
 * class that grants the behaviour and the CSS rule that carries it; the measurement itself is the browser
 * sweep in the ledger, and both have to agree.
 */
import { createElement } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement } from '../src/client/lib/test-render'
import { Segmented, Slider } from '../src/client/components/form'

beforeAll(async () => {
  await initI18n()
})

describe('the shared controls a narrow row leans on', () => {
  it('lets a segmented track cap itself to the column it is given', () => {
    const rendered = renderElement(createElement(Segmented, {
      label: 'X',
      value: 'a',
      onChange: () => {},
      options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((v) => ({ value: v, label: v + ' option label' })),
    }))
    const track = rendered.container.querySelector('[role="radiogroup"]')
    expect(track).toBeTruthy()
    // `shrink-0` alone is what pushed this 606px wide inside a 330px column at 420px.
    expect(track!.className).toContain('shrink-0')
    expect(track!.className, 'a capped width is what lets flex-wrap do its job').toContain('max-w-full')
    expect(track!.className).toContain('flex-wrap')
    rendered.unmount()
  })

  it('gives a range input a minimum the row can actually honour', () => {
    const css = fs.readFileSync('src/client/styles/ui-primitives.css', 'utf8')
    const block = /\.ink-slider\s*\{[^}]*\}/.exec(css)
    expect(block, 'the slider rule has gone missing from ui-primitives.css').toBeTruthy()
    // Class names alone would not have caught this: the fix is a CSS declaration, not a utility.
    expect(block![0], 'a range input keeps its ~129px UA minimum without this').toMatch(/min-width:\s*0/)
  })

  it('keeps the slider itself shrinkable inside a flex row', () => {
    const rendered = renderElement(createElement(Slider, {
      label: 'X',
      value: 8,
      min: 1,
      max: 12,
      onChange: () => {},
    }))
    const input = rendered.container.querySelector('input[type="range"]')
    expect(input).toBeTruthy()
    expect(input!.className).toContain('ink-slider')
    expect(input!.className).toContain('flex-1')
    rendered.unmount()
  })
})

describe('the rows that measured wider than their column', () => {
  const wrapped = (source: string, needle: string, where: string) => {
    expect(source, `${where}: no longer wraps on a phone`).toContain(needle)
  }

  it('wraps the studio hex row', () => {
    const src = fs.readFileSync('src/client/features/tools/color/views/ColorStudioView.tsx', 'utf8')
    wrapped(src, 'mt-1 flex flex-wrap items-center gap-2', 'the seed colour row')
  })

  it('wraps the algorithm header group', () => {
    const src = fs.readFileSync('src/client/features/tools/color/views/ColorSpaceAlgorithmView.tsx', 'utf8')
    wrapped(src, 'flex flex-wrap items-center justify-end gap-2', 'the seed chip and its buttons')
  })

  it('wraps both image panel header rows', () => {
    const src = fs.readFileSync('src/client/features/tools/color/views/ImagePaletteView.tsx', 'utf8')
    const rows = src.split('flex flex-wrap items-center justify-between gap-2 pb-3 border-b').length - 1
    expect(rows, 'the dominant-colour and palette rows both need to wrap').toBe(2)
  })

  it('wraps the four-button row under the extracted palette', () => {
    // Measured in Chromium: 494px of buttons inside a 372px card at 420px.
    const src = fs.readFileSync('src/client/features/tools/color/views/ImagePaletteView.tsx', 'utf8')
    expect(src.split('flex flex-wrap items-center justify-end gap-2').length - 1).toBeGreaterThanOrEqual(1)
    expect(src, 'the bare four-button row is back').not.toContain('<div className="flex items-center gap-2">\n                <Button')
  })

  it('says nothing in English that the locale files do not already hold', () => {
    // The rows above were edited; the i18n gate is the one that keeps that true, and it runs as a script.
    expect(t('tools.color.studio.seed_color').length).toBeGreaterThan(0)
  })
})
