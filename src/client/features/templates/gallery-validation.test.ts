import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteTemplate, NoteTemplateCategory } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { CategoryDialog, ImportTemplatesModal, TemplateEditorModal, TemplateRenameDialog } from './gallery-modals'

vi.mock('../../lib/api', () => ({
  CLIENT_ID: 'this-tab',
  api: {
    templateLibrary: {
      load: async () => ({ savedAt: 0, library: null }),
      save: async () => ({ savedAt: 1 }),
    },
  },
}))

vi.mock('../../lib/db', () => ({
  localDb: { saveTemplateLibrary: async () => {} },
  publishBroadcast: () => {},
  createBroadcast: () => ({ post: () => {}, close: () => {} }),
}))

const TEMPLATE: NoteTemplate = {
  id: 'tpl-1', categoryId: null, name: 'Weekly', description: '', content: '# Body',
  tags: [], builtin: false, isPinned: false, isStarred: false, createdAt: 1, updatedAt: 1,
}
const CATEGORY: NoteTemplateCategory = { id: 'cat-1', name: 'Work', builtin: false, position: 0, createdAt: 1 }

let root: Root
let container: HTMLDivElement

function saveButton(label: string = t('common.save')): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === label)
  expect(found, `the dialog footer should hold a ${label} button`).toBeDefined()
  return found as HTMLButtonElement
}

function messages(): string[] {
  return [...document.querySelectorAll('p')].map((node) => node.textContent?.trim() ?? '')
}

function nameInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[maxlength]')
  expect(input, 'the dialog should hold the name input').toBeDefined()
  return input as HTMLInputElement
}

function errorText(): string {
  return [...document.querySelectorAll('p')]
    .map((node) => node.textContent?.trim() ?? '')
    .filter((text) => text === t('templates.name_required'))
    .join('|')
}

async function renderRename() {
  await act(async () => {
    root.render(createElement(TemplateRenameDialog, { template: TEMPLATE, onClose: () => {} }))
    await Promise.resolve()
  })
}

async function renderCategory() {
  await act(async () => {
    root.render(createElement(CategoryDialog, { dialog: { mode: 'rename', category: CATEGORY }, onClose: () => {} }))
    await Promise.resolve()
  })
}

async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  await act(async () => {
    setter?.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function press(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}

beforeEach(async () => {
  localStorage.clear()
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
})

describe('the gallery dialogs name what they reject', () => {
  it('says what is wrong when the template name is empty', async () => {
    await renderRename()
    await type(nameInput(), '   ')
    await press(saveButton())
    expect(errorText(), 'an invalid red border with no message is not feedback').toBe(t('templates.name_required'))
    const describedBy = nameInput().getAttribute('aria-describedby')
    expect(describedBy, 'the message has to reach assistive tech through the input').toBeTruthy()
    expect(document.getElementById(describedBy!.trim())?.textContent).toContain(t('templates.name_required'))
  })

  it('says what is wrong when the category name is empty', async () => {
    await renderCategory()
    await type(nameInput(), '')
    await press(saveButton())
    expect(errorText()).toBe(t('templates.name_required'))
  })

  it('stays quiet while the name is filled in', async () => {
    await renderRename()
    await press(saveButton())
    expect(errorText()).toBe('')
  })

  it('says the pasted text was not a template library, not just a red border', async () => {
    await act(async () => {
      root.render(createElement(ImportTemplatesModal, { onClose: () => {} }))
      await Promise.resolve()
    })
    const box = document.querySelector('textarea')
    expect(box, 'the import dialog should hold a paste box').toBeDefined()
    await type(box as HTMLTextAreaElement, 'not json at all')
    const importButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === t('templates.import_templates'))
    expect(importButton, 'the import button should be enabled once text is pasted').toBeDefined()
    expect((importButton as HTMLButtonElement).disabled).toBe(false)
    await press(importButton as HTMLButtonElement)
    const message = [...document.querySelectorAll('p')].map((node) => node.textContent?.trim()).find((text) => text === t('templates.import_invalid'))
    expect(message, 'an invalid red border with no message is not feedback').toBe(t('templates.import_invalid'))
    expect(box!.getAttribute('aria-describedby'), 'the message has to reach assistive tech').toBeTruthy()
  })

  it('blames the body, not the name, when only the body is missing', async () => {
    let closed = 0
    await act(async () => {
      root.render(createElement(TemplateEditorModal, {
        template: null,
        initial: { name: 'Weekly review', description: '', content: '', categoryId: null, tags: [] },
        categories: [],
        onClose: () => { closed += 1 },
      }))
      await Promise.resolve()
    })
    await press(saveButton(t('templates.create_template')))
    expect(errorText(), 'the name is filled in, so it must not be blamed').toBe('')
    expect(messages().filter((text) => text === t('templates.content_required')).length).toBe(1)
    const box = document.querySelector('textarea')
    expect(box?.getAttribute('aria-invalid'), 'the body field carries the error').toBe('true')
    expect(closed, 'a rejected draft must not be saved').toBe(0)
  })

  it('blames both halves when neither is filled in', async () => {
    await act(async () => {
      root.render(createElement(TemplateEditorModal, { template: null, categories: [], onClose: () => {} }))
      await Promise.resolve()
    })
    await press(saveButton(t('templates.create_template')))
    expect(errorText()).toBe(t('templates.name_required'))
    expect(messages().filter((text) => text === t('templates.content_required')).length).toBe(1)
  })

  it('rejects a body that is only whitespace', async () => {
    let closed = 0
    await act(async () => {
      root.render(createElement(TemplateEditorModal, {
        template: null,
        initial: { name: 'Weekly review', description: '', content: '  \n\t ', categoryId: null, tags: [] },
        categories: [],
        onClose: () => { closed += 1 },
      }))
      await Promise.resolve()
    })
    await press(saveButton(t('templates.create_template')))
    expect(messages().filter((text) => text === t('templates.content_required')).length).toBe(1)
    expect(closed, 'a blank template must not reach the library').toBe(0)
  })

  it('saves a draft that has both a name and a body', async () => {
    let closed = 0
    await act(async () => {
      root.render(createElement(TemplateEditorModal, {
        template: null,
        initial: { name: 'Weekly review', description: '', content: '# Week', categoryId: null, tags: [] },
        categories: [],
        onClose: () => { closed += 1 },
      }))
      await Promise.resolve()
    })
    await press(saveButton(t('templates.create_template')))
    expect(errorText(), 'a valid name must not be blamed').toBe('')
    expect(messages().filter((text) => text === t('templates.content_required')).join(''), 'a valid body must not be blamed').toBe('')
    expect(closed).toBe(1)
  })
})
