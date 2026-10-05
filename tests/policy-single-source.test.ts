// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { normalizeOrganizerIcon } from '../src/shared/organizer-colors'
import { assertOrganizerQuota, assertNoteQuota } from '../src/worker/db/quota'
import { grantedMcpScopes, MCP_SCOPES, MCP_SUPPORTED_SCOPES } from '../src/worker/mcp/settings'
import { sharePasscodeProblem } from '../src/shared/share-passcode'
import { makeD1 } from './doubles/d1-sqlite'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('one policy per rule, reached from every entry', () => {
  it('keeps a single share-passcode floor for the console and the MCP tool', () => {
    expect(sharePasscodeProblem('1234567')).toMatch(/at least 8/)
    expect(sharePasscodeProblem('12345678')).toBeNull()
    expect(sharePasscodeProblem(null)).toBeNull()

    const rest = read('../src/worker/routes/share.ts')
    const mcp = read('../src/worker/mcp/library.ts')
    expect(rest).toContain("from '@shared/share-passcode'")
    expect(mcp).toContain("from '@shared/share-passcode'")
    // A re-forked floor would reintroduce a hard-coded length comparison.
    expect(rest).not.toMatch(/password\.length\s*[<>]\s*\d/)
    expect(mcp).not.toMatch(/password\.length\s*[<>]\s*\d/)
  })

  it('truncates organizer icons the same way in both entries', () => {
    expect(normalizeOrganizerIcon('x'.repeat(30))).toHaveLength(LIMITS.organizerIconMaxLength)
    expect(normalizeOrganizerIcon('')).toBeNull()
    expect(normalizeOrganizerIcon(undefined)).toBeNull()

    const rest = read('../src/worker/routes/folders.ts')
    const mcp = read('../src/worker/mcp/library.ts')
    expect(rest).toMatch(/normalizeOrganizerIcon\(body\.icon\)/)
    expect(mcp).toMatch(/normalizeOrganizerIcon\(input\.icon\)/)
    expect(mcp).toContain('organizerColorOrNull(input.color)')
  })

  it('checks the note quota when a trashed note comes back, not only when it is made', () => {
    expect(read('../src/worker/routes/notes.ts')).toMatch(
      /restore'[\s\S]{0,400}await assertNoteQuota\(/,
    )
    expect(read('../src/worker/mcp/writes.ts')).toMatch(
      /restore_note'[\s\S]{0,700}await assertNoteQuota\(/,
    )
  })
})

describe('grantedMcpScopes', () => {
  it('does not hand out write to an account that never enabled it', () => {
    const scopes = grantedMcpScopes(MCP_SUPPORTED_SCOPES, {
      writeEnabled: false,
      trashEnabled: false,
      updatedAt: 0,
    })
    expect(scopes).toEqual([MCP_SCOPES.read])
  })

  it('keeps honouring an account that did enable write', () => {
    expect(grantedMcpScopes(MCP_SUPPORTED_SCOPES, {
      writeEnabled: true,
      trashEnabled: false,
      updatedAt: 0,
    })).toEqual([MCP_SCOPES.read, MCP_SCOPES.write])
  })
})

describe('organizer quotas', () => {
  function seeded(entity: 'folder' | 'tag', count: number, trashed = 0) {
    const sqlite = new DatabaseSync(':memory:')
    if (entity === 'folder') {
      sqlite.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER)')
      const live = sqlite.prepare('INSERT INTO folders VALUES (?, ?, NULL)')
      const gone = sqlite.prepare('INSERT INTO folders VALUES (?, ?, 1)')
      for (let index = 0; index < count; index++) live.run(`l${index}`, 'user')
      for (let index = 0; index < trashed; index++) gone.run(`d${index}`, 'user')
    } else {
      sqlite.exec('CREATE TABLE tags (id TEXT PRIMARY KEY, user_id TEXT)')
      const live = sqlite.prepare('INSERT INTO tags VALUES (?, ?)')
      for (let index = 0; index < count; index++) live.run(`l${index}`, 'user')
    }
    return makeD1(sqlite)
  }

  it('bounds folders, ignoring trashed ones', async () => {
    await expect(assertOrganizerQuota(seeded('folder', LIMITS.foldersMaxPerUser - 1, 50), 'user', 'folder'))
      .resolves.toBeUndefined()
    await expect(assertOrganizerQuota(seeded('folder', LIMITS.foldersMaxPerUser), 'user', 'folder'))
      .rejects.toThrow(/quota is exhausted/)
  })

  it('bounds tags, a table without deleted_at', async () => {
    await expect(assertOrganizerQuota(seeded('tag', LIMITS.tagsMaxPerUser - 1), 'user', 'tag'))
      .resolves.toBeUndefined()
    await expect(assertOrganizerQuota(seeded('tag', LIMITS.tagsMaxPerUser), 'user', 'tag'))
      .rejects.toThrow(/quota is exhausted/)
  })

  it('still counts a restored note against the note quota', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER)')
    const live = sqlite.prepare('INSERT INTO notes VALUES (?, ?, NULL)')
    const trashed = sqlite.prepare('INSERT INTO notes VALUES (?, ?, 1)')
    for (let index = 0; index < LIMITS.notesMaxPerUser; index++) live.run(`n${index}`, 'user')
    trashed.run('gone', 'user')
    await expect(assertNoteQuota(makeD1(sqlite), 'user')).rejects.toThrow(/quota is exhausted/)
  })
})
