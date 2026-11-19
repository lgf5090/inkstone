// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTable, SchemaModel } from '../src/shared/development/database/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { SchemaEditor } from '../src/client/features/development/database/SchemaEditor'
import { parseCreateTable } from '../src/client/features/development/database/schema-parse'
import type { StudioDriver } from '../src/client/features/development/database/drivers'

function table(sql: string): ParsedTable {
  const parsed = parseCreateTable(sql)
  if (!parsed) throw new Error(`could not parse ${sql}`)
  return parsed
}

const USERS = table('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)')
const ORDERS = table('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id))')

function schema(): SchemaModel {
  return {
    tables: [USERS, ORDERS],
    views: [],
    triggers: [],
    indexes: [
      { name: 'idx_orders_user', unique: false, columns: ['user_id'], origin: 'c', sql: 'CREATE INDEX idx_orders_user ON orders (user_id)', table: 'orders' },
    ],
  }
}

let rendered: RenderedElement | null = null

function mount() {
  const transaction = vi.fn(async () => undefined)
  const driver = {
    type: 'sqlite',
    label: 'test',
    query: vi.fn(async () => ({ columns: [], rows: [], durationMs: 0 })),
    transaction,
    isDirty: () => false,
    markSaved: () => undefined,
    close: () => undefined,
  } as unknown as StudioDriver
  const onSchemaChanged = vi.fn()
  rendered = renderElement(
    <SchemaEditor
      driver={driver}
      table={USERS}
      schemaModel={schema()}
      ensureWritable={async () => true}
      onSchemaChanged={onSchemaChanged}
      onError={() => undefined}
    />,
  )
  return { container: rendered.container, transaction, onSchemaChanged }
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
  if (!found) throw new Error(`missing menu item ${label}`)
  return found
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

describe('SchemaEditor tabs', () => {
  it('renders the field editor with the existing columns', () => {
    const { container } = mount()
    expect(container.textContent).toContain('users')
    const values = [...container.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value)
    expect(values).toContain('id')
    expect(values).toContain('email')
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      t('development.database.editor.tab_fields'),
      t('development.database.editor.tab_indexes'),
      t('development.database.editor.tab_foreign_keys'),
      t('development.database.editor.tab_constraints'),
    ])
  })

  it('adds an index and previews the DDL', async () => {
    const { container, transaction } = mount()
    click(t('development.database.editor.tab_indexes'), container)
    click(t('development.database.editor.add_index'), container)
    const nameInput = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('development.database.index.name')}"]`)
    expect(nameInput).toBeTruthy()
    typeInto(nameInput!, 'idx_users_email')
    click(`${t('development.database.index.column')} 1`)
    act(() => menuItem('email').click())
    click(t('development.database.index.save'))
    await settle()

    click(t('development.database.schema.save_changes'), container)
    expect(document.body.textContent).toContain('CREATE INDEX "idx_users_email" ON "users" ("email")')
    click(t('development.database.diagram.execute'))
    await settle()
    expect(transaction).toHaveBeenCalledTimes(1)
  })

  it('adds a unique constraint and rebuilds the table', async () => {
    const { container } = mount()
    click(t('development.database.editor.tab_constraints'), container)
    click(t('development.database.editor.add_unique'), container)
    click(`${t('development.database.constraint.column')} 1`)
    act(() => menuItem('email').click())
    click(t('development.database.constraint.save'))
    await settle()

    click(t('development.database.schema.save_changes'), container)
    expect(document.body.textContent).toContain('UNIQUE ("email")')
    expect(document.body.textContent).toContain('users__rebuild')
  })

  it('renames the table without rebuilding it', async () => {
    const { container } = mount()
    click(t('development.database.editor.rename_table'), container)
    const input = document.body.querySelector<HTMLInputElement>(`[role="dialog"] input[aria-label="${t('development.database.schema.table_name')}"]`)!
    typeInto(input, 'accounts')
    click(t('development.database.diagram.rename'), document.body.querySelector<HTMLElement>('[role="dialog"]')!)
    await settle()

    click(t('development.database.schema.save_changes'), container)
    expect(document.body.textContent).toContain('ALTER TABLE "users" RENAME TO "accounts"')
  })

  it('adds a foreign key through the table designer', async () => {
    const { container } = mount()
    click(t('development.database.editor.tab_foreign_keys'), container)
    expect(container.textContent).toContain(t('development.database.editor.no_foreign_keys'))
    click(t('development.database.editor.add_foreign_key'), container)
    click(t('development.database.diagram.target_table'))
    act(() => menuItem('orders').click())
    click(`${t('development.database.diagram.source_columns')} 1`)
    act(() => menuItem('id').click())
    click(`${t('development.database.diagram.target_columns')} 1`)
    act(() => menuItem('id').click())
    click(t('development.database.diagram.save_relation'))
    await settle()

    click(t('development.database.schema.save_changes'), container)
    expect(document.body.textContent).toContain('FOREIGN KEY ("id") REFERENCES "orders" ("id")')
  })
})