// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTable, SchemaModel } from '../src/shared/development/database/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { ErdView } from '../src/client/features/development/database/ErdView'
import { parseCreateTable } from '../src/client/features/development/database/schema-parse'

function table(sql: string): ParsedTable {
  const parsed = parseCreateTable(sql)
  if (!parsed) throw new Error(`could not parse ${sql}`)
  return parsed
}

const USERS = table('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)')
const ORDERS = table('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id))')
const NO_KEY = table('CREATE TABLE logs (message TEXT)')

function schema(tables: ParsedTable[] = [USERS, ORDERS]): SchemaModel {
  return { tables, views: [], triggers: [], indexes: [] }
}

let rendered: RenderedElement | null = null

function mount(tables: ParsedTable[] = [USERS, ORDERS], source = schema(tables)) {
  const onApplyDdl = vi.fn(async (_statements: string[]) => undefined)
  const ensureWritable = vi.fn(async () => true)
  rendered = renderElement(
    <ErdView
      tables={tables}
      schema={source}
      editable
      connectionKey="ui-test"
      ensureWritable={ensureWritable}
      onApplyDdl={onApplyDdl}
    />,
  )
  return { container: rendered.container, onApplyDdl, ensureWritable }
}

function button(label: string, root: HTMLElement | Document = document.body): HTMLButtonElement {
  const found = [...(root as unknown as ParentNode).querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.getAttribute('aria-label') === label || (entry.textContent ?? '').trim() === label,
  )
  if (!found) throw new Error(`missing button ${label}`)
  return found
}

function click(label: string, root: HTMLElement | Document = document.body): void {
  act(() => button(label, root).click())
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')].find(
    (entry) => (entry.textContent ?? '').trim() === label,
  )
  if (!found) {
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')].map((entry) => entry.textContent)
    throw new Error(`missing menu item ${label}; got ${JSON.stringify(labels)}`)
  }
  return found
}

function enterEdit(container: HTMLElement): void {
  click(t('development.database.diagram.edit'), container)
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ErdView edit mode', () => {
  it('enters edit mode with toolbar actions and column handles', () => {
    const { container } = mount()
    expect(container.querySelector(`[aria-label="${t('development.database.diagram.column_handle', { column: 'id' })}"]`)).toBeNull()
    enterEdit(container)

    expect(container.textContent).toContain(t('development.database.diagram.save'))
    expect(container.querySelectorAll('[data-erd-column]').length).toBeGreaterThan(0)
    const handle = [...container.querySelectorAll('button')].find(
      (entry) => entry.getAttribute('aria-label') === t('development.database.diagram.column_handle', { column: 'id' }),
    )
    expect(handle).toBeTruthy()
  })

  it('creates a table and undoes the change', async () => {
    const { container } = mount()
    enterEdit(container)
    expect(container.querySelectorAll('[data-flow-node]')).toHaveLength(2)

    click(t('development.database.diagram.new_table'), container)
    const input = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('development.database.schema.table_name')}"]`)
    expect(input).toBeTruthy()
    typeInto(input!, 'labels')
    click(t('development.database.schema.create'))
    await settle()

    expect(container.querySelectorAll('[data-flow-node]')).toHaveLength(3)
    expect(container.textContent).toContain(t('development.database.diagram.dirty'))

    const undo = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.getAttribute('aria-label') === t('development.database.diagram.undo'),
    )
    act(() => undo!.click())
    expect(container.querySelectorAll('[data-flow-node]')).toHaveLength(2)
  })

  it('previews the generated DDL and applies it', async () => {
    const { container, onApplyDdl, ensureWritable } = mount()
    enterEdit(container)
    click(t('development.database.diagram.new_table'), container)
    const input = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('development.database.schema.table_name')}"]`)!
    typeInto(input, 'labels')
    click(t('development.database.schema.create'))
    await settle()

    click(t('development.database.diagram.save'), container)
    expect(document.body.textContent).toContain('CREATE TABLE "labels"')
    expect(document.body.textContent).toContain(t('development.database.diagram.execute'))

    click(t('development.database.diagram.execute'))
    await settle()
    expect(ensureWritable).toHaveBeenCalledTimes(1)
    expect(onApplyDdl).toHaveBeenCalledTimes(1)
    const statements = onApplyDdl.mock.calls[0]![0]
    expect(statements.join('\n')).toContain('CREATE TABLE "labels"')
  })

  it('validates an empty relationship form', () => {
    const { container } = mount()
    enterEdit(container)
    click(t('development.database.diagram.add_relation'), container)
    click(t('development.database.diagram.save_relation'))
    expect(document.body.textContent).toContain(t('development.database.diagram.relation_invalid'))
  })

  it('creates a relationship through the dialog', () => {
    const { container } = mount()
    enterEdit(container)
    expect(container.querySelectorAll('[data-flow-edge]')).toHaveLength(1)

    click(t('development.database.diagram.add_relation'), container)
    click(t('development.database.diagram.target_table'))
    act(() => menuItem('orders').click())
    click(`${t('development.database.diagram.source_columns')} 1`)
    act(() => menuItem('id').click())
    click(`${t('development.database.diagram.target_columns')} 1`)
    act(() => menuItem('id').click())
    click(t('development.database.diagram.save_relation'))

    expect(container.querySelectorAll('[data-flow-edge]')).toHaveLength(2)
    expect(container.textContent).toContain(t('development.database.diagram.dirty'))
  })

  it('offers the four export formats', () => {
    const { container } = mount()
    enterEdit(container)
    click(t('development.database.doc.export_menu'), container)
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((entry) => entry.textContent)
    expect(labels).toEqual([
      t('development.database.doc.export_png'),
      t('development.database.doc.export_svg'),
      t('development.database.doc.export_mermaid'),
      t('development.database.doc.export_markdown'),
    ])
  })

  it('lists structure issues and selects the affected table', () => {
    const { container } = mount([USERS, NO_KEY])
    enterEdit(container)
    const issuesButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => (entry.textContent ?? '').includes(t('development.database.diagram.issues')),
    )
    expect(issuesButton).toBeTruthy()
    act(() => issuesButton!.click())

    expect(document.body.textContent).toContain(t('development.database.diagram.issue_no_primary_key', { table: 'logs' }))
    const issueRow = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => (entry.textContent ?? '').includes(t('development.database.diagram.issue_no_primary_key', { table: 'logs' })),
    )
    act(() => issueRow!.click())
    const logs = container.querySelector('[data-flow-node="logs"]')
    expect(logs?.getAttribute('aria-current')).toBe('true')
  })
})