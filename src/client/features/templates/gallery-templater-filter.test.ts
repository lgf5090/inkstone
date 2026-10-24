import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { initI18n, t } from '../../lib/i18n'
import { templateKinds } from './template-risk'
import { filterGalleryTemplates, galleryCounts } from './gallery-derived'
import { GALLERY_PERSIST_KEY, loadGalleryPersist } from './gallery-persist'
import { TemplateCard } from './template-card'
import type { NoteTemplate } from '@shared/types'

/**
 * The gallery's two Templater-facing judgements: which bodies the engine would render, and which of those can
 * run code rather than only print values.
 *
 * The badge and the filter are read from one function on purpose, and the tests below are the proof of that:
 * every body that a filter lets through is a body whose card carries the word. A reader who filters to
 * "runs code" and finds a card without the badge has been told something false about a template they are
 * about to execute.
 */

function template(overrides: Partial<NoteTemplate> = {}): NoteTemplate {
  return {
    id: 'tpl-1',
    name: 'Idea',
    description: '',
    content: '# Idea\n',
    categoryId: null,
    tags: [],
    builtin: false,
    isPinned: false,
    isStarred: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as NoteTemplate
}

describe('what a template body is classified as', () => {
  it('leaves an old `{{}}` body unbadged', () => {
    expect(templateKinds('# {{title}}\n\n{{date:YYYY-MM-DD}}')).toEqual({ templater: false, script: false })
  })

  it('badges a printing Templater body as Templater and nothing more', () => {
    expect(templateKinds('<% tp.date.now("YYYY") %> · <% tp.file.title %>')).toEqual({ templater: true, script: false })
  })

  it('badges the dynamic form too, because the engine reads `<%+` as well', () => {
    expect(templateKinds('今天 <%+ tp.date.now() %>').templater).toBe(true)
  })

  it('calls a body that can run code by name, whichever of the three ways it does it', () => {
    for (const content of [
      '<%* tR += tp.file.title %>',
      '<% tp.user.my_script() %>',
      '<% await tp.web.random_picture("cat", "400x400") %>',
    ]) {
      expect(templateKinds(content), content).toEqual({ templater: true, script: true })
    }
  })

  it('over-flags prose that merely names a script API, because the flag only ever narrows', () => {
    // `detection.ts` is a regex over text, and the one direction it is allowed to be wrong in is the safe
    // one: a body that only *mentions* `tp.user` gets the warning badge it does not need, while a body that
    // really calls it can never slip through unbadged. The badge drives a filter and a community gate, never
    // a permission, so the false positive costs a reader a look at a card and nothing more.
    expect(templateKinds('This template mentions tp.user scripts in its text.')).toEqual({ templater: false, script: true })
    // A body with no command delimiter is still not one the Templater engine would run.
    expect(templateKinds('Just words about tp.web.').templater).toBe(false)
  })
})

describe('the gallery filters by the same judgement the card shows', () => {
  const library = [
    template({ id: 'plain', content: '# Plain\n{{title}}' }),
    template({ id: 'prints', content: '<% tp.date.now() %>' }),
    template({ id: 'runs', content: '<%* tR += 1 %>' }),
  ]

  function derive(filter: Parameters<typeof filterGalleryTemplates>[1]) {
    return filterGalleryTemplates(library, filter, '')
  }

  it('counts each badge once per body that earns it', () => {
    const counts = galleryCounts(library)
    expect(counts.templater).toBe(2)
    expect(counts.script).toBe(1)
  })

  it('lists the Templater bodies, and only those, under the Templater filter', () => {
    expect(derive({ kind: 'templater' }).map((one) => one.id)).toEqual(['prints', 'runs'])
  })

  it('lists the running bodies under the warning filter', () => {
    expect(derive({ kind: 'script' }).map((one) => one.id)).toEqual(['runs'])
  })

  it('keeps the search and the badge filter both in force', () => {
    const both = filterGalleryTemplates(
      [template({ id: 'a', name: 'A', content: '<%* 1 %>' }), template({ id: 'b', name: 'B', content: '<%* 2 %>' })],
      { kind: 'script' },
      'B',
    )
    expect(both.map((one) => one.id)).toEqual(['b'])
  })
})

describe('the remembered filter accepts the two new views', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps a filter the gallery can actually answer, and drops one it cannot', () => {
    for (const kind of ['templater', 'script']) {
      window.localStorage.setItem(GALLERY_PERSIST_KEY, JSON.stringify({ filter: { kind }, selectMode: false }))
      expect(loadGalleryPersist().filter, kind).toEqual({ kind })
    }
    window.localStorage.setItem(GALLERY_PERSIST_KEY, JSON.stringify({ filter: { kind: 'nonsense' }, selectMode: false }))
    expect(loadGalleryPersist().filter).toEqual({ kind: 'all' })
  })
})

describe('the card carries the word the filter filtered on', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await initI18n()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
  })

  async function show(body: string) {
    await act(async () => {
      root.render(createElement(TemplateCard, {
        template: template({ content: body }),
        categoryName: 'Ideas',
        selectMode: false,
        selected: false,
        focused: false,
        dragging: false,
        dropHint: false,
        onToggleSelect: () => {},
        onDragStart: () => {},
        onDragOver: () => {},
        onDrop: () => {},
        onDragEnd: () => {},
        onUse: () => {},
        onEdit: () => {},
        onRename: () => {},
        onDuplicate: () => {},
        onMove: () => {},
        onDelete: () => {},
        onPublish: () => {},
        onTogglePin: () => {},
        onToggleStar: () => {},
        onPreview: () => {},
        onInsert: () => {},
      }))
      await Promise.resolve()
    })
  }

  function badges(): string[] {
    return [...container.querySelectorAll('h3 ~ span, h3 + span')].map((one) => one.textContent?.trim() ?? '')
  }

  it('says Templater, and says it runs code, on a body that does both', async () => {
    await show('<%* tR += tp.file.title %>')
    expect(badges()).toContain(t('templater.group'))
    expect(badges()).toContain(t('templates.runs_code'))
  })

  it('says only Templater on a body that prints values', async () => {
    await show('<% tp.date.now() %>')
    expect(badges()).toContain(t('templater.group'))
    expect(badges()).not.toContain(t('templates.runs_code'))
  })

  it('says neither on an old `{{}}` body, which the engine never renders', async () => {
    await show('# {{title}} on {{date:YYYY-MM-DD}}')
    expect(badges()).toEqual([])
  })
})
