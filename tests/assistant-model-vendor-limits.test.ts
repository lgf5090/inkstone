// @vitest-environment node
/**
 * The two columns that hold what a vendor said about a model.
 *
 * `vendor_context_tokens` and `vendor_max_output_tokens` are the detection's memory: a row written before
 * they existed must read back as "nobody has said", a row created for a model whose limits are published
 * must carry them through a save and a reload, and a row for a model nobody documents must stay empty
 * rather than gain a number. The third case is the one that matters, because a stored guess reaches the
 * editor as a ceiling and silently shortens somebody's answers.
 *
 * The other thing pinned here is the separation from the reader's own two columns: a detected ceiling must
 * not be written into `max_output_tokens`, and an editor save must not wipe what was detected.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { AssistantStore } from '../src/worker/assistant/store'
import { initializeDatabase, SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

let sqlite: DatabaseSync
let store: AssistantStore

/** The versions this change owns, derived so a renumbered file says so instead of passing quietly. */
const VENDOR_VERSIONS = SCHEMA_MIGRATIONS
  .filter((migration) => migration.statements.some((statement) => /chat_models ADD COLUMN vendor_/.test(statement)))
  .map((migration) => migration.version)

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  // The shape a database built before these columns has: the rest of the table is current, the two columns
  // are not, and one model row was written while they did not exist.
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  sqlite.exec('ALTER TABLE chat_models DROP COLUMN vendor_context_tokens')
  sqlite.exec('ALTER TABLE chat_models DROP COLUMN vendor_max_output_tokens')
  sqlite.exec(`INSERT INTO chat_models (user_id, id, provider_id, model, label, position)
    VALUES ('${USER}', 'legacy-row', 'any-provider', 'gpt-4o', 'Written before the columns', 1)`)

  const db = makeD1(sqlite)
  await initializeDatabase({ DB: db } as never)
  const env = testBindings(db, { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

function columnList(table: string): string[] {
  return sqlite.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => (row as { name: string }).name)
}

describe('the columns a boot has to add', () => {
  it('numbers each one on its own version, past every number already spent', () => {
    expect(VENDOR_VERSIONS).toEqual([92, 93])
    // One column per version, and no other entry in the ledger claiming either number.
    expect(SCHEMA_MIGRATIONS.filter((migration) => migration.version >= 92).map((migration) => migration.version))
      .toEqual([92, 93])
  })

  it('adds both to the table the boot already had', () => {
    const columns = columnList('chat_models')
    expect(columns).toContain('vendor_context_tokens')
    expect(columns).toContain('vendor_max_output_tokens')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version IN (92, 93)').get())
      .toEqual({ n: 2 })
  })
})

describe('a model row read through the two columns', () => {
  it('comes back with nothing known when it was written before them', async () => {
    const legacy = await store.getModel('legacy-row')
    expect(legacy?.model).toBe('gpt-4o')
    // Null, and not the 128K/16K the published numbers would give that id today: the row predates the
    // detection, and inventing its vendor's answer on a read would restamp history as an observation.
    expect(legacy?.vendorContextTokens).toBeNull()
    expect(legacy?.vendorMaxOutputTokens).toBeNull()
  })

  it('keeps the numbers a known model was created with, across the list and a reload', async () => {
    const provider = await store.createProvider({ label: 'Google', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: '' })
    const created = await store.createModel({ providerId: provider.id, model: 'gemini-2.5-flash' })
    expect(created.vendorContextTokens).toBe(1_048_576)
    expect(created.vendorMaxOutputTokens).toBe(65_536)
    // The same values off the row: what `createModel` answers has to be what the table holds, or the
    // reader's screen and the request path would be reading two different facts.
    expect(await store.getModel(created.id)).toMatchObject({ vendorContextTokens: 1_048_576, vendorMaxOutputTokens: 65_536 })
    const listed = await store.listModels()
    expect(listed.find((entry) => entry.id === created.id)).toMatchObject({ vendorContextTokens: 1_048_576, vendorMaxOutputTokens: 65_536 })
  })

  it('stores nothing for a model no published page names', async () => {
    const provider = await store.createProvider({ label: 'Notebook', protocol: 'openai', baseUrl: 'https://ollama.example.test/v1', apiKey: '' })
    const created = await store.createModel({ providerId: provider.id, model: 'my-quantized-thing' })
    expect(created.vendorContextTokens).toBeNull()
    expect(created.vendorMaxOutputTokens).toBeNull()
    expect((await store.getModel(created.id))?.vendorContextTokens).toBeNull()
  })

  it('leaves the reader’s own numbers alone, and keeps the detected ones through a save', async () => {
    const provider = await store.createProvider({ label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' })
    const created = await store.createModel({ providerId: provider.id, model: 'gpt-4o' })
    // The detection does not configure the reader: their own ceiling stays the unset "inherit" it was.
    expect(created.maxOutputTokens).toBeNull()
    expect(created.vendorMaxOutputTokens).toBe(16_384)
    const saved = (await store.updateModel(created.id, { maxOutputTokens: 1_048_576, label: 'Renamed' }))!
    expect(saved.maxOutputTokens).toBe(1_048_576)
    // And a save cannot overwrite what the vendor said, which is what keeps the two nulls meaning
    // different things: an editor write has no column to say it in.
    expect(saved.vendorContextTokens).toBe(128_000)
    expect(saved.vendorMaxOutputTokens).toBe(16_384)
  })
})
