// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement } from '../src/client/lib/test-render'
import { CollectionManager } from '../src/client/features/development/github/components/CollectionManager'
import type { GithubCollection } from '@shared/development/github/types'

const existing: GithubCollection = {
  id: 'c1',
  name: 'Curated',
  description: 'Picked',
  repoIds: ['1'],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(async () => {
  await initI18n()
})

describe('collection manager', () => {
  it('creates a collection and refuses a duplicate name', () => {
    const onAdd = vi.fn()
    const view = renderElement(
      <CollectionManager open onClose={() => undefined} collections={[]} onAdd={onAdd} onUpdate={() => undefined} onDelete={() => undefined} />,
    )
    const inputs = document.body.querySelectorAll<HTMLInputElement>('[role="dialog"] input')
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(inputs[0], 'Reading')
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(inputs[1], 'For later')
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    })
    const create = Array.from(document.body.querySelectorAll('button'))
      .find((button) => (button.textContent ?? '').trim() === t('development.github.collections.add'))
    act(() => create!.click())
    expect(onAdd).toHaveBeenCalledWith('Reading', 'For later')
    view.unmount()

    const duplicateView = renderElement(
      <CollectionManager open onClose={() => undefined} collections={[existing]} onAdd={() => undefined} onUpdate={() => undefined} onDelete={() => undefined} />,
    )
    const nameInput = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(nameInput, 'curated')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain(t('development.github.collections.duplicate'))
    duplicateView.unmount()
  })

  it('renames a collection in place', () => {
    const onUpdate = vi.fn()
    const view = renderElement(
      <CollectionManager open onClose={() => undefined} collections={[existing]} onAdd={() => undefined} onUpdate={onUpdate} onDelete={() => undefined} />,
    )
    const edit = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === t('common.edit'))
    act(() => edit!.click())
    const inputs = document.body.querySelectorAll<HTMLInputElement>('[role="dialog"] input')
    const nameInput = inputs[2]!
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(nameInput, 'Renamed')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === t('common.save'))
    act(() => save!.click())
    expect(onUpdate).toHaveBeenCalledWith('c1', { name: 'Renamed', description: 'Picked' })
    view.unmount()
  })

  it('refuses a rename onto an existing name instead of silently dropping it', () => {
    const onUpdate = vi.fn()
    const second: GithubCollection = { ...existing, id: 'c2', name: 'Other' }
    const view = renderElement(
      <CollectionManager open onClose={() => undefined} collections={[existing, second]} onAdd={() => undefined} onUpdate={onUpdate} onDelete={() => undefined} />,
    )
    const edits = Array.from(document.body.querySelectorAll('button'))
      .filter((button) => button.getAttribute('aria-label') === t('common.edit'))
    act(() => edits[1]!.click())
    const nameInput = document.body.querySelectorAll<HTMLInputElement>('[role="dialog"] input')[2]!
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(nameInput, 'Curated')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.getAttribute('aria-label') === t('common.save'))
    act(() => save!.click())
    expect(document.body.textContent).toContain(t('development.github.collections.duplicate'))
    expect(onUpdate).not.toHaveBeenCalled()
    view.unmount()
  })
})
