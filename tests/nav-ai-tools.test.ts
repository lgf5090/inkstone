import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { NAV_SCHEMA_STATEMENTS } from '../src/worker/nav/schema'
import { NavStore } from '../src/worker/nav/store'
import { newCategoryPasswordHash, createCategoryUnlock } from '../src/worker/nav/access'
import {
  NavToolError,
  navCreateCategory,
  navCreateLink,
  navDeleteCategory,
  navDeleteLinks,
  navFindDuplicates,
  navListLinks,
  navMoveLinks,
  navOverview,
  navSortLinks,
  navToolScope,
  navUpdateCategory,
  navUpdateLink,
} from '../src/worker/nav/tools'
import { renderNavContext, readNavContext } from '../src/worker/assistant/nav-context'
import { ALL_TOOLS } from '../src/worker/assistant/tools'
import { ASSISTANT_TOOL_SPECS } from '../src/shared/assistant'
import type { ToolContext } from '../src/worker/assistant/tools'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'a'.repeat(26)

let sqlite: DatabaseSync
let env: ReturnType<typeof testBindings>

function context(unlockTokens: string[] = []): ToolContext {
  return {
    env,
    store: { userId: USER },
    navUnlockTokens: unlockTokens,
  } as unknown as ToolContext
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  for (const statement of NAV_SCHEMA_STATEMENTS) sqlite.exec(statement)
  env = testBindings(makeD1(sqlite))
})

afterEach(() => {
  sqlite.close()
})

async function seed() {
  const nav = new NavStore(env.DB, USER)
  const open = await nav.createCategory({ name: 'Open', icon: 'folder', parentId: null, passwordHash: null, useDefaultPassword: false })
  const locked = await nav.createCategory({
    name: 'Locked',
    icon: 'lock',
    parentId: null,
    passwordHash: await newCategoryPasswordHash('correct-horse'),
    useDefaultPassword: false,
  })
  const openLink = await nav.createLink({ title: 'Open Link', url: 'https://open.example.com/', icon: null, description: null, categoryId: open.id, pinned: false })
  const hidden = await nav.createLink({ title: 'Hidden Link', url: 'https://hidden.example.com/', icon: null, description: null, categoryId: locked.id, pinned: false })
  return { nav, open, locked, openLink, hidden }
}

describe('navigation assistant tools', () => {
  it('hides protected categories and their links without an unlock token', async () => {
    const { locked, hidden } = await seed()
    const scope = await navToolScope(context())
    const overview = await navOverview(scope)
    expect(JSON.stringify(overview)).not.toContain(hidden.title)
    const categories = overview.categories as Array<Record<string, unknown>>
    expect(categories.find((category) => category.id === locked.id)).toMatchObject({ locked: true, hidden: true, linkCount: null })
    await expect(navListLinks({ categoryName: 'Locked' }, scope)).rejects.toBeInstanceOf(NavToolError)
    await expect(navListLinks({ query: 'hidden' }, scope)).resolves.toMatchObject({ total: 0 })
  })

  it('reads protected rows once the screen carries their unlock token', async () => {
    const { locked, hidden } = await seed()
    const unlock = await createCategoryUnlock(env.DB, USER, locked.id)
    const scope = await navToolScope(context([unlock.token]))
    const result = await navListLinks({ categoryName: 'Locked' }, scope)
    expect(result.links).toMatchObject([{ id: hidden.id, title: 'Hidden Link' }])
  })

  it('creates, edits, moves, sorts and deletes through the tool helpers', async () => {
    const { nav, open, openLink } = await seed()
    const tools = await navCreateCategory({ name: 'Tools', icon: 'wrench' }, await navToolScope(context()))
    const toolsId = (tools.category as { id: string }).id
    const created = await navCreateLink({
      title: 'New Link',
      url: 'https://new.example.com/',
      categoryName: 'Tools',
      description: 'made by ai',
      pinned: false,
    }, await navToolScope(context()))
    const linkId = (created.link as { id: string }).id
    expect(linkId).toHaveLength(26)

    const updated = await navUpdateLink({ id: openLink.id, title: 'Renamed', categoryName: 'Tools' }, await navToolScope(context()))
    expect(updated.link).toMatchObject({ id: openLink.id, title: 'Renamed', categoryId: toolsId })

    await navMoveLinks({ ids: [linkId], categoryId: open.id }, await navToolScope(context()))
    expect((await nav.links()).find((link) => link.id === linkId)!.categoryId).toBe(open.id)

    const duplicates = await navCreateLink({ title: 'Duplicate', url: 'https://new.example.com/', categoryId: open.id }, await navToolScope(context()))
    expect((duplicates.link as { id: string }).id).toHaveLength(26)
    const found = await navFindDuplicates(await navToolScope(context()))
    expect(found.groupCount).toBe(1)

    const sorted = await navSortLinks({ scope: 'category', categoryId: open.id, by: 'title' }, await navToolScope(context()))
    expect(Number(sorted.ordered)).toBeGreaterThan(1)

    const deleted = await navDeleteLinks({ ids: [linkId] }, await navToolScope(context()))
    expect(deleted.deleted).toBe(1)
    expect((await nav.links()).some((link) => link.id === linkId)).toBe(false)

    const renamed = await navUpdateCategory({ categoryId: toolsId, name: 'Utilities' }, await navToolScope(context()))
    expect(renamed.category).toMatchObject({ id: toolsId, name: 'Utilities' })

    const removed = await navDeleteCategory({ categoryId: toolsId, fallbackId: open.id }, await navToolScope(context()))
    expect(removed.deleted).toBe('Utilities')
    expect((await nav.categories()).some((category) => category.id === toolsId)).toBe(false)
  })

  it('registers every nav tool with a label and runs destructive approval through prepare/commit', async () => {
    const navTools = ALL_TOOLS.filter((tool) => tool.name.startsWith('nav_'))
    expect(navTools).toHaveLength(13)
    for (const tool of navTools) {
      expect(ASSISTANT_TOOL_SPECS.some((spec) => spec.name === tool.name), tool.name).toBe(true)
    }
    const { openLink } = await seed()
    const remove = ALL_TOOLS.find((tool) => tool.name === 'nav_delete_links')
    if (!remove || remove.permission !== 'destructive') throw new Error('nav_delete_links is not destructive')
    const ctx = context()
    const prepared = await remove.prepare({ ids: [openLink.id] }, ctx)
    expect(prepared.targetLabel).toBe('Open Link')
    await remove.commit(prepared.targetId, ctx, { ids: [openLink.id] })
    expect((await new NavStore(env.DB, USER).links()).some((link) => link.id === openLink.id)).toBe(false)
  })

  it('parses and renders screen context without leaking unlock tokens', async () => {
    const token = 't'.repeat(43)
    const contextValue = readNavContext({
      categoryId: 'a'.repeat(26),
      categoryName: 'Open',
      query: ' docs ',
      totalLinks: 10,
      visibleLinks: 4,
      pinnedCount: 2,
      lockedCategories: 1,
      unlockTokens: [token, 'bad'],
    })
    expect(contextValue).toMatchObject({ categoryName: 'Open', query: 'docs', visibleLinks: 4, unlockTokens: [token] })
    const rendered = renderNavContext(contextValue!)
    expect(rendered).toContain('Open category: "Open"')
    expect(rendered).not.toContain(token)
  })
})
