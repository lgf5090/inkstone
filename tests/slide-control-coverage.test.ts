import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/client/lib/markdown/renderer'
import { SLIDE_CONTROL_SELECTORS, dropSlideControls } from '../src/client/features/presentation/slide-html'

// The projector turns a page by a click anywhere on it and leaves a click on an interactive element
// alone, so a control that survives into slide markup is a dead button that also eats a page turn.
// The reference project ships a fixed list of those controls, written against *its* block families;
// this fork has families it never heard of (the tab strip's buttons, six block toolbars whose triggers
// are `[data-*-action]`, a mermaid failure retry, a code-block expander), so the list cannot be
// trusted to be complete just because it arrived with the port. This file re-derives it from the
// surfaces that actually build the controls.
const PREVIEW_DIR = path.join('src', 'client', 'features', 'preview')
const MARKDOWN_DIR = path.join('src', 'client', 'lib', 'markdown')

function sourcesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.includes('.test.') && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
}

function attributesIn(source: string, pattern: RegExp): Set<string> {
  const found = new Set<string>()
  for (const match of source.matchAll(pattern)) {
    for (const attribute of match[1]!.matchAll(/\[(data-[a-z0-9-]+)/g)) found.add(attribute[1]!)
  }
  return found
}

// A press target is whatever the live preview reaches for with `closest<HTMLButtonElement>`, plus
// every button the markdown layer builds. Those must be off a slide.
function buttonRoutes(files: string[]): Set<string> {
  const found = new Set<string>()
  for (const file of files) for (const attribute of buttonAttributes(readFileSync(file, 'utf8'))) found.add(attribute)
  return found
}

function buttonAttributes(source: string): Set<string> {
  const routed = attributesIn(source, /closest<HTMLButtonElement>\(\s*['"`]([^'"`]+)['"`]/g)
  const emitted = new Set<string>()
  // A button built in code names itself on the next few lines (`retry.dataset.mermaidRetry = '1'`),
  // so the scan reads forward from the construction rather than assuming a statement order.
  for (const match of source.matchAll(/createElement\(['"]button['"]\)([\s\S]{0,400}?)\.textContent|createElement\(['"]button['"]\)([\s\S]{0,400}?)\.className/g)) {
    const body = match[1] ?? match[2] ?? ''
    for (const dataset of body.matchAll(/\.dataset\.([a-zA-Z0-9]+)\s*=/g)) {
      emitted.add(`data-${dataset[1]!.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
    }
  }
  return new Set([...routed, ...emitted])
}

// The rest of what a click route reaches for with a bare `closest<HTMLElement>` is a container or a
// piece of content, not a control: the block a retry button sits in, the tab strip a tab button
// belongs to, the tag chip and the block reference that are the slide's own text. Each is named here
// with what it is, so a new `closest()` target that is neither a control nor a known piece of content
// turns this red rather than passing unnoticed.
const CONTENT_OR_CONTAINER = new Set([
  'data-block-ref',
  'data-example-family',
  'data-mermaid',
  'data-tabs',
  'data-tag',
  'data-wikilink',
])

function anyRoutes(files: string[]): Set<string> {
  const found = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/closest<[^>]*>\(\s*['"`]([^'"`]+)['"`]/g)) {
      for (const attribute of match[1]!.matchAll(/\[(data-[a-z0-9-]+)/g)) found.add(attribute[1]!)
    }
  }
  return found
}

// The same list read from the other end: the attributes a block head is *emitted* with, before any
// enhancer runs, because the plain render is a surface the projector can be stuck on.
function emittedButtons(files: string[]): Set<string> {
  const found = new Set<string>()
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/<button[^>]*?\s(data-[a-z0-9-]+)/g)) found.add(match[1]!)
    for (const attribute of buttonAttributes(source)) found.add(attribute)
  }
  return found
}

const covered = new Set(SLIDE_CONTROL_SELECTORS.map((selector) => /\[?(data-[a-z0-9-]+)/.exec(selector)?.[1]).filter((name): name is string => Boolean(name)))

describe('a slide carries no dead control (N-37)', () => {
  it('strips every button the preview routes from or the markdown layer builds', () => {
    const targets = new Set([...buttonRoutes(sourcesIn(PREVIEW_DIR)), ...emittedButtons(sourcesIn(MARKDOWN_DIR))])
    expect(targets.size).toBeGreaterThan(8)
    expect([...targets].filter((name) => !covered.has(name))).toEqual([])
  })

  it('classifies every other element a click route reaches for', () => {
    const routed = anyRoutes(sourcesIn(PREVIEW_DIR))
    const unclassified = [...routed].filter((name) => !covered.has(name) && !CONTENT_OR_CONTAINER.has(name))
    expect(unclassified).toEqual([])
    // The two sets have to stay apart, or "it is content" becomes a way to excuse a button.
    expect([...routed].filter((name) => covered.has(name) && CONTENT_OR_CONTAINER.has(name))).toEqual([])
  })

  it('names every button the markdown renderer emits into the markup', () => {
    const buttons = new Set<string>()
    for (const file of sourcesIn(MARKDOWN_DIR)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<button[^>]*?\s(data-[a-z0-9-]+)/g)) buttons.add(match[1]!)
    }
    expect(buttons.size).toBeGreaterThan(1)
    expect([...buttons].filter((name) => !covered.has(name))).toEqual([])
  })

  it('drops each listed control out of markup that holds one', () => {
    for (const selector of SLIDE_CONTROL_SELECTORS) {
      const attribute = /\[(data-[a-z0-9-]+)/.exec(selector)?.[1]
      const markup = attribute
        ? `<p>keep</p><button ${attribute}="x">press</button>`
        : '<p>keep</p><h2 id="a">Title<a class="heading-anchor" href="#a">#</a></h2>'
      const stripped = dropSlideControls(markup)
      expect(stripped, selector).not.toContain(attribute ?? 'heading-anchor')
      expect(stripped, selector).toContain('keep')
    }
  })

  // Both of these are this fork's own, and neither is a `<button>`, so the list above cannot see them:
  // a checkbox the stage bails on, and a truncation switch that would hide half a code block behind a
  // dead expander. They are asserted against the real renderer rather than hand-written markup, so a
  // change to how either block is emitted turns this red instead of quietly turning the slide wrong.
  it('leaves a task checkbox unable to be operated but still showing its state', () => {
    const slide = dropSlideControls(renderMarkdown('- [x] shipped\n- [ ] next', { hideFrontMatter: true }).html)
    const boxes = [...new DOMParser().parseFromString(slide, 'text/html').querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.getAttribute('data-task-line')).toBeNull()
      expect(box.tabIndex).toBe(-1)
      expect(box.style.pointerEvents).toBe('none')
    }
    expect(boxes[0]!.hasAttribute('checked')).toBe(true)
    expect(boxes[1]!.hasAttribute('checked')).toBe(false)
  })

  it('takes a block-owned collapse threshold off the markup before the enhancement can honour it', () => {
    const slide = dropSlideControls('<pre data-code-collapse-at="3"><code>one\ntwo\nthree\nfour\nfive</code></pre>')
    expect(slide).not.toContain('data-code-collapse-at')
    expect(slide).toContain('five')
  })
})
