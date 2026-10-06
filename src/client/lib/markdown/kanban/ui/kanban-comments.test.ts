import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fullTime, shortTime } from '../../../time'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals } from '../../../test-render'
import { KANBAN_COMMENT_MAX_CHARS } from '../comments'
import { DetailComments } from './kanban-comments'
import type { KanbanItem } from '../types'

beforeAll(async () => {
  await initI18n()
})

const NOON_ISO = '2026-09-20T12:00:00.000Z'
const EVENING_ISO = '2026-09-20T19:30:00.000Z'

const read: KanbanItem = {
  id: 'i1',
  title: 'Card',
  properties: {},
  comments: [
    { id: 'c1', text: 'First', at: NOON_ISO },
    { id: 'c2', text: 'Second', author: 'Ada', at: EVENING_ISO },
  ],
}

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-kanban-comments]')
  if (!el) throw new Error('comments section not found')
  return el
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-kanban-comment]')]
}

function rowTexts(): string[] {
  return rows().map((row) => row.textContent ?? '')
}

function pick<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (!el) throw new Error(`${selector} not found`)
  return el
}

function draftBox(): HTMLTextAreaElement {
  return pick('[data-kanban-comment-draft]')
}

function authorBox(): HTMLInputElement {
  return pick('[data-kanban-comment-author]')
}

function sendButton(): HTMLButtonElement {
  return pick('[data-kanban-comment-send]')
}

function editControl(index: number): HTMLButtonElement {
  const el = rows()[index]!.querySelector<HTMLButtonElement>('[data-kanban-comment-edit]')
  if (!el) throw new Error('no edit control on that comment')
  return el
}

function editBox(): HTMLTextAreaElement {
  return pick('[data-kanban-comment-edit-box]')
}

function typeText(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressKey(el: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
}

function written(comments: KanbanItem['comments']): string[] {
  return (comments ?? []).map((comment) => comment!.text)
}

let view: { dispose(): void } | null = null

function renderComments(item: KanbanItem, extra: { people?: Record<string, string[]> } = {}) {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onUpdate = vi.fn<(updated: KanbanItem) => void>()
  act(() => root.render(createElement(DetailComments, { item, onUpdate, ...extra })))
  view = {
    dispose() {
      act(() => root.unmount())
      container.remove()
    },
  }
  return { onUpdate }
}

afterEach(() => {
  view?.dispose()
  view = null
})

describe('reading the comments a card holds', () => {
  it('shows what was said, by whom, at the moment it was written', () => {
    renderComments(read)
    expect(rows()).toHaveLength(2)
    expect(rowTexts()[0]).toContain('First')
    expect(rowTexts()[1]).toContain('Second')
    expect(rowTexts()[1]).toContain('Ada')
    const stamps = [...section().querySelectorAll('time')].map((el) => el.getAttribute('datetime'))
    expect(stamps).toEqual([NOON_ISO, EVENING_ISO])
    expect(rowTexts()[1]).toContain(shortTime(Date.parse(EVENING_ISO)))
    expect(pick('time').getAttribute('title')).toBe(fullTime(Date.parse(NOON_ISO)))
  })

  it('names a comment by what it says when there is no author to name it by', () => {
    renderComments(read)
    expect(rowTexts()[0]).toContain(t('preview.kanban_comment_anonymous'))
    expect(rows()[0]!.querySelector('[role="img"]')).toBeNull()
    expect(rows()[1]!.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ada')
  })

  it('shows no moment for a stamp that no clock can read', () => {
    const stamped: KanbanItem = {
      ...read,
      comments: [{ id: 'c9', text: 'Someday', at: 'yesterday, I think' }],
    }
    renderComments(stamped)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.querySelector('time')).toBeNull()
  })

  it('says nobody has written yet instead of leaving a blank stretch', () => {
    renderComments({ id: 'i2', title: 'Fresh', properties: {} })
    expect(rows()).toHaveLength(0)
    expect(section().textContent).toContain(t('preview.kanban_comments_empty'))
    expect(draftBox()).toBeTruthy()
  })

  it('gives the list its name from the heading above it', () => {
    renderComments(read)
    const heading = section().querySelector('h4')!
    const list = section().querySelector('ol')!
    expect(heading.id).toBeTruthy()
    expect(list.getAttribute('aria-labelledby')).toBe(heading.id)
  })
})

describe('writing a comment', () => {
  it('appends what the box holds under the name the box holds', () => {
    const { onUpdate } = renderComments(read)
    act(() => {
      typeText(authorBox(), 'Ada')
      typeText(draftBox(), '  Ship it  ')
      sendButton().click()
    })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    const comments = onUpdate.mock.calls[0]![0].comments ?? []
    expect(written(comments)).toEqual(['First', 'Second', 'Ship it'])
    expect(comments[2]).toMatchObject({ author: 'Ada' })
    expect(String(comments[2]?.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(draftBox().value).toBe('')
  })

  it('offers nothing to send while the box is empty, and the name last used to start with', () => {
    renderComments(read)
    expect(sendButton().disabled).toBe(true)
    act(() => { typeText(draftBox(), 'x') })
    expect(sendButton().disabled).toBe(false)
    expect(authorBox().value).toBe('Ada')
  })

  it('offers the people the board knows next to the names already used here', () => {
    renderComments(read, { people: { reviewer: ['Nora', 'Ada', '  '] } })
    const offered = [...section().querySelectorAll<HTMLOptionElement>('datalist option')].map((el) => el.value)
    expect(offered).toEqual(expect.arrayContaining(['Nora', 'Ada']))
    expect(offered.filter((name) => name === 'Ada')).toHaveLength(1)
    expect(offered.every((name) => name.trim() !== '')).toBe(true)
  })

})

describe('the keys that move a draft out of the box', () => {
  it('keeps Enter a line break and sends on the chord that means send', () => {
    const { onUpdate } = renderComments(read)
    act(() => {
      typeText(draftBox(), 'Two\nlines')
      pressKey(draftBox(), 'Enter')
    })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(draftBox().value).toBe('Two\nlines')
    act(() => { pressKey(draftBox(), 'Enter', { metaKey: true }) })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(written(onUpdate.mock.calls[0]![0].comments)).toEqual(['First', 'Second', 'Two\nlines'])
  })

  it('sends nothing on the chord while the box holds nothing to send', () => {
    const { onUpdate } = renderComments(read)
    act(() => {
      typeText(draftBox(), '   ')
      pressKey(draftBox(), 'Enter', { ctrlKey: true })
    })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(draftBox().value).toBe('   ')
  })

  it('throws the draft away on Escape without touching the card', () => {
    const { onUpdate } = renderComments(read)
    act(() => { typeText(draftBox(), 'Abandoned') })
    expect(draftBox().getAttribute('data-owns-escape')).toBe('true')
    act(() => { pressKey(draftBox(), 'Escape') })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(draftBox().value).toBe('')
  })

  it('bounds what one comment may hold and says so', () => {
    renderComments(read)
    act(() => { typeText(draftBox(), 'short note') })
    expect(section().querySelector('[data-kanban-comment-count]')).toBeNull()
    const near = 'a'.repeat(KANBAN_COMMENT_MAX_CHARS - 50)
    act(() => { typeText(draftBox(), near) })
    expect(pick('[data-kanban-comment-count]').textContent).toContain(String(near.length))
    act(() => { typeText(draftBox(), 'z'.repeat(KANBAN_COMMENT_MAX_CHARS + 40)) })
    expect(draftBox().value).toHaveLength(KANBAN_COMMENT_MAX_CHARS)
    expect(pick('[role="status"]').textContent).toContain(String(KANBAN_COMMENT_MAX_CHARS))
  })
})

describe('editing what was already said', () => {
  it('rewrites one comment in place and keeps the rest as they were', () => {
    const { onUpdate } = renderComments(read)
    act(() => { editControl(0).click() })
    expect(editBox().value).toBe('First')
    act(() => {
      typeText(editBox(), 'First, edited')
      pick('[data-kanban-comment-save]').click()
    })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(written(onUpdate.mock.calls[0]![0].comments)).toEqual(['First, edited', 'Second'])
    expect(document.querySelector('[data-kanban-comment-edit-box]')).toBeNull()
  })

  it('leaves the card alone when the edit is given up', () => {
    const { onUpdate } = renderComments(read)
    act(() => { editControl(1).click() })
    act(() => {
      typeText(editBox(), 'Never sent')
      pick('[data-kanban-comment-cancel]').click()
    })
    expect(onUpdate).not.toHaveBeenCalled()
    expect(rowTexts()[1]).toContain('Second')
  })

  it('refuses to save an edit that says nothing', () => {
    const { onUpdate } = renderComments(read)
    act(() => { editControl(0).click() })
    act(() => {
      typeText(editBox(), '   ')
      pick('[data-kanban-comment-save]').click()
    })
    expect(onUpdate).not.toHaveBeenCalled()
  })
})

describe('removing what was already said', () => {
  it('names the comment a delete button is about to remove', () => {
    const { onUpdate } = renderComments(read)
    const remove = rows()[0]!.querySelector<HTMLButtonElement>('[data-kanban-comment-delete]')
    if (!remove) throw new Error('no delete control on that comment')
    expect(remove.getAttribute('aria-label')).toBe(t('preview.kanban_comment_delete', { text: 'First' }))
    act(() => { remove.click() })
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(written(onUpdate.mock.calls[0]![0].comments)).toEqual(['Second'])
  })
})
