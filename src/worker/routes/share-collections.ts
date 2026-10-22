import { Hono } from 'hono'
import type { Context } from 'hono'
import { LIMITS } from '@shared/constants'
import type { PublicCollection, PublicCollectionNote } from '@shared/share-hub'
import { isShareTargetType } from '@shared/share-selection'
import { sharePasscodeProblem } from '@shared/share-passcode'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { isValidId, isValidSlug } from '../lib/id'
import { JSON_BODY_LIMITS, clampInt, readJson, readOptionalJson, requestClientIp } from '../lib/request'
import { hashPassword, verifyPassword } from '../lib/password'
import { escapeHtml } from '../lib/encoding'
import {
  assertAttemptBudget,
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
} from '../lib/throttle'
import { shareBatchNoteIds } from '../share/organizer'
import { ShareOrganizerStore } from '../share/organizer-store'
import {
  collectionMemberCounts,
  collectionTargetName,
  decodeCollectionCursor,
  findCollectionBySlug,
  isCollectionMemberSort,
  nextCollectionCursor,
  readDirectoryPage,
  toShareCollection,
  type PublicCollectionRow,
  type ShareCollectionCreate,
  type ShareCollectionPolicy,
  ShareCollectionStore,
} from '../share/collections'

/**
 * The published-collection endpoints: the owner's directories, and the public page one of them answers.
 *
 * The two halves are in one file because they are one contract seen from both ends, and the thing that
 * makes them agree is that neither of them owns a member rule: the owner's count, the owner's list and a
 * stranger's page all read `shareSelectionSql({ status: 'active', target })`. That used to be two copies
 * in the reference and they drifted; here there is nothing to drift.
 *
 * The public half answers with `PublicCollection` and nothing beside it — no note bodies, no note ids, no
 * author. A collection that is missing, paused or expired answers identically, because whether a given
 * address exists is not public information, and its passcode gate is the note share's gate: the same
 * `sharePasscodeProblem` ceiling, the same throttle helpers, the same body for "required" and "wrong", so
 * a probe cannot tell a collection from a link by the way it is refused.
 */

/** The longest title a hand-picked collection can be given. A directory label, not a note title. */
const COLLECTION_TITLE_MAX = 200

/** One page of a directory, and the ceiling on how much of an account one request can walk. */
const DIRECTORY_LIMIT_DEFAULT = 50
const DIRECTORY_LIMIT_MAX = 100

/** How far ahead a directory's end date may be set: a decade, and no further. */
const COLLECTION_EXPIRY_MAX_MS = 10 * 365 * 24 * 60 * 60 * 1000

export const shareCollectionRoutes = new Hono<AppBindings>()

export const publicCollectionRoutes = new Hono<AppBindings>()

/** The directory's own document, mounted outside `/api` at `/collections/<slug>`. */
export const publicCollectionPageRoutes = new Hono<AppBindings>()

shareCollectionRoutes.use('*', requireAuth)

function store(c: Context<AppBindings>): ShareCollectionStore {
  return new ShareCollectionStore(c.env.DB, c.get('userId'))
}

function readTitle(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw ApiError.badRequest('title must be a string or null')
  const title = raw.trim()
  if (!title) return null
  if (title.length > COLLECTION_TITLE_MAX) {
    throw ApiError.badRequest(`Collection title cannot exceed ${COLLECTION_TITLE_MAX} characters`)
  }
  return title
}

/** The end date a write names: absolute, in the future, and bounded, or null for a permanent page. */
function readExpiresAt(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw ApiError.badRequest('expiresAt must be a timestamp or null')
  const now = Date.now()
  if (raw <= now) throw ApiError.badRequest('expiresAt must be in the future')
  return Math.min(Math.trunc(raw), now + COLLECTION_EXPIRY_MAX_MS)
}

/** The member order the page lists with; anything outside the four named presets is refused. */
function readMemberSort(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (!isCollectionMemberSort(raw)) throw ApiError.badRequest('memberSort is not a supported order')
  return raw
}

/** The passcode a write names, hashed here so no plain text ever leaves the route. */
async function readPasswordHash(raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw ApiError.badRequest('password must be a string or null')
  if (!raw) return null
  const problem = sharePasscodeProblem(raw)
  if (problem) throw ApiError.badRequest(problem)
  return hashPassword(raw)
}

/**
 * The member ids a hand-picked directory names.
 *
 * The roster's ceiling is the batch's ceiling — `shareBatchNoteIds` — because both are the same question
 * ("how many links may one request name?") and two numbers for it would be two answers. Which links
 * belong to this account is a separate check, and it is the store's `shareHoldingNotes` that answers it.
 */
function readMemberIds(raw: unknown): string[] {
  return shareBatchNoteIds(raw)
}

/**
 * The roster a write may store: the ids the account holds a live link for, in the order it named them.
 *
 * `shareHoldingNotes` answers in whatever order the database walked its `IN` list, so handing its result
 * straight to the roster write would shuffle a hand-picked list on every save. The set keeps the ownership
 * rule — a note the account cannot publish drops out, and a roster left with nothing in it is refused —
 * and the order stays the request's own, which is the only order a hand-picked directory has.
 */
async function heldRoster(db: D1Database, userId: string, noteIds: readonly string[]): Promise<string[]> {
  const held = new Set(await new ShareOrganizerStore(db, userId).shareHoldingNotes(noteIds))
  return noteIds.filter((noteId) => held.has(noteId))
}

shareCollectionRoutes.get('/collections', async (c) => {
  const db = c.env.DB
  const rows = await store(c).listRows()
  const now = Date.now()
  // Every count is read now, beside the list: the number and the page come from the same predicate, so a
  // folder that gained a link a second ago reports the new number.
  const counts = await collectionMemberCounts(db, rows, now)
  const collections = rows.flatMap((row, index) => {
    const collection = toShareCollection(row, counts[index] ?? 0)
    return collection ? [collection] : []
  })
  return c.json({ collections })
})

/**
 * Publishes a directory.
 *
 * Publishing a folder or tag that is already published re-states that collection's policy rather than
 * minting a second page: two live addresses for one folder would be two passwords to remember and two
 * links to revoke.
 */
shareCollectionRoutes.post('/collections', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const kind = body.targetType
  if (kind !== 'manual' && !isShareTargetType(kind)) {
    throw ApiError.badRequest('targetType must be folder, tag or manual')
  }
  const policy: ShareCollectionPolicy = {
    title: readTitle(body.title),
    passwordHash: await readPasswordHash(body.password),
    expiresAt: readExpiresAt(body.expiresAt),
    memberSort: readMemberSort(body.memberSort),
  }

  if (kind === 'manual') {
    const noteIds = readMemberIds(body.noteIds)
    if (!policy.title) throw ApiError.badRequest('A hand-picked collection needs a title')
    const roster = await heldRoster(db, userId, noteIds)
    if (!roster.length) throw ApiError.badRequest('None of those notes has a share link of yours')
    const created = await store(c).create({ ...policy, targetType: kind, targetValue: '' })
    await store(c).replaceMembers(created.id, roster)
    return c.json({ id: created.id, slug: created.slug }, 201)
  }

  const targetValue = typeof body.targetValue === 'string' ? body.targetValue : ''
  if (!isValidId(targetValue)) throw ApiError.badRequest('targetValue must be a folder or tag id')
  const record = { type: kind, value: targetValue }
  // The name is read before the record is written, so a collection can never address a folder or tag the
  // account does not own — and a tag that is gone is answered the same way a missing one is.
  if ((await collectionTargetName(db, userId, record)) === null) {
    throw ApiError.notFound('The folder or tag does not exist')
  }
  const existing = await store(c).liveForTarget(kind, targetValue)
  if (existing) {
    if (!(await store(c).applyPolicy(existing.id, policy))) {
      throw ApiError.conflict('The collection changed elsewhere. Refresh and try again')
    }
    return c.json({ id: existing.id, slug: existing.slug })
  }
  const create: ShareCollectionCreate = { ...policy, targetType: kind, targetValue }
  const created = await store(c).create(create)
  return c.json({ id: created.id, slug: created.slug }, 201)
})

/**
 * Patches a collection: its pause, its label, its order, its passcode and its end date.
 *
 * The policy fields ride this route as well as publish, because a hand-picked collection has no publish
 * step to return to once it exists, and a directory that cannot be given a password afterwards is a
 * directory that gets deleted and re-published under a new address.
 */
shareCollectionRoutes.patch('/collections/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('The collection does not exist')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const s = store(c)
  const row = await s.byId(id)
  if (!row) throw ApiError.notFound('The collection does not exist')

  if (body.isEnabled !== undefined && typeof body.isEnabled !== 'boolean') {
    throw ApiError.badRequest('isEnabled must be a boolean')
  }
  if (body.isEnabled !== undefined && !(await s.setEnabled(row, body.isEnabled))) {
    throw ApiError.conflict('The collection changed elsewhere. Refresh and try again')
  }
  const policyNamed = body.title !== undefined || body.password !== undefined || body.expiresAt !== undefined || body.memberSort !== undefined
  if (!policyNamed) return c.json({ ok: true })
  const policy: ShareCollectionPolicy = {
    title: body.title === undefined ? row.title : readTitle(body.title),
    passwordHash: body.password === undefined ? row.password_hash : await readPasswordHash(body.password),
    expiresAt: body.expiresAt === undefined ? row.expires_at : readExpiresAt(body.expiresAt),
    memberSort: body.memberSort === undefined ? row.member_sort : readMemberSort(body.memberSort),
  }
  if (!(await s.applyPolicy(id, policy))) throw ApiError.conflict('The collection changed elsewhere. Refresh and try again')
  return c.json({ ok: true })
})

/**
 * Replaces a hand-picked collection's roster.
 *
 * Only `manual` has a roster to replace: a folder or tag collection's members are its target, and editing
 * them means filing the links, which is the organizer's endpoint rather than this one.
 */
shareCollectionRoutes.put('/collections/:id/members', async (c) => {
  const db = c.env.DB
  const userId = c.get('userId')
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('The collection does not exist')
  const body = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.small)
  const s = store(c)
  const row = await s.byId(id)
  if (!row) throw ApiError.notFound('The collection does not exist')
  if (row.target_type !== 'manual') throw ApiError.badRequest('Only a hand-picked collection has a member list')
  const noteIds = readMemberIds(body.noteIds)
  const roster = await heldRoster(db, userId, noteIds)
  if (!roster.length) throw ApiError.badRequest('None of those notes has a share link of yours')
  const written = await s.replaceMembers(id, roster)
  return c.json({ ok: true, members: roster.length, written })
})

/** Revoking a collection removes the record and nothing else: its members keep their own links. */
shareCollectionRoutes.delete('/collections/:id', async (c) => {
  const id = c.req.param('id')
  if (!isValidId(id)) throw ApiError.notFound('The collection does not exist')
  if (!(await store(c).delete(id))) throw ApiError.notFound('The collection does not exist')
  return c.json({ ok: true })
})

/**
 * The public directory, answered the same way whether the passcode came in the query or the body.
 *
 * A GET is what a reader and a link preview ask for; a POST is what the passcode dialog sends, because a
 * secret does not belong in a URL that lands in a browser history and a referrer header.
 */
publicCollectionRoutes.get('/c/:slug', (c) => directory(c, c.req.query('password') ?? ''))
publicCollectionRoutes.post('/c/:slug', async (c) => {
  const body = await readOptionalJson<{ password?: unknown }>(c, JSON_BODY_LIMITS.small, {})
  const password = typeof body.password === 'string' ? body.password.slice(0, LIMITS.passwordMaxLength) : ''
  return directory(c, password)
})

/** One identical refusal for a missing, paused and expired directory. */
const DIRECTORY_GONE = 'The collection does not exist or has been revoked'

async function loadDirectory(slug: string, db: D1Database): Promise<PublicCollectionRow> {
  const collection = await findCollectionBySlug(db, slug)
  if (!collection || collection.is_enabled === 0) throw ApiError.notFound(DIRECTORY_GONE)
  if (collection.expires_at && collection.expires_at < Date.now()) throw ApiError.notFound(DIRECTORY_GONE)
  return collection
}

/** The throttle targets for one directory's passcode, shaped as the note share's are. */
function directoryThrottle(slug: string, ip: string): {
  lockTargets: string[]
  workTargets: Array<{ key: string; maxAttempts: number; windowMs: number; lockMs?: number }>
} {
  return {
    lockTargets: [`collection:${slug}:ip:${ip}`],
    workTargets: [
      { key: `collection-work:${slug}:ip:${ip}`, maxAttempts: 8, windowMs: 10 * 60 * 1000 },
      { key: `collection-work:${slug}`, maxAttempts: 60, windowMs: 10 * 60 * 1000, lockMs: 60_000 },
    ],
  }
}

/**
 * The passcode gate, the same one the note share runs.
 *
 * Reused rather than re-derived: two gates that answer slightly differently are a way for a probe to tell
 * a directory from a link, and the throttle ledger is shared by both in the first place.
 */
async function passDirectory(c: Context<AppBindings>, collection: PublicCollectionRow, password: string): Promise<void> {
  if (!collection.password_hash) return
  const slug = c.req.param('slug') ?? ''
  if (!password) throw ApiError.unauthenticated('An access password is required')
  const targets = directoryThrottle(slug, requestClientIp(c))
  await assertAttemptBudget(async () => {
    await assertNotLocked(c.env.DB, targets.lockTargets)
    await consumeAttemptBudget(c.env.DB, targets.workTargets)
  })
  if (!(await verifyPassword(password, collection.password_hash))) {
    await recordLoginFailure(c.env.DB, targets.lockTargets)
    throw new ApiError(401, 'invalid_credentials', 'Incorrect passcode')
  }
  await clearLoginFailures(c.env.DB, [...targets.lockTargets, ...targets.workTargets.map((target) => target.key)])
}

/** The read budget a directory page spends: an address can be walked, and nobody may do it for free. */
async function budgetDirectoryRead(c: Context<AppBindings>, slug: string): Promise<void> {
  const ip = requestClientIp(c)
  await assertAttemptBudget(async () => {
    await consumeAttemptBudget(c.env.DB, [
      { key: `directory:${slug}:ip:${ip}`, maxAttempts: 20, windowMs: 10 * 60 * 1000 },
      { key: `directory:ip:${ip}`, maxAttempts: 60, windowMs: 10 * 60 * 1000 },
    ])
  })
}

/** A cursor this worker did not mint is a client bug, so it is a 400 rather than a silent first page. */
function directoryCursor(raw: string | undefined) {
  try {
    return decodeCollectionCursor(raw)
  } catch {
    throw ApiError.badRequest('The collection cursor is not valid')
  }
}

async function directory(c: Context<AppBindings>, password: string): Promise<Response> {
  const slug = c.req.param('slug') ?? ''
  if (!isValidSlug(slug)) throw ApiError.notFound(DIRECTORY_GONE)
  await budgetDirectoryRead(c, slug)
  const collection = await loadDirectory(slug, c.env.DB)
  await passDirectory(c, collection, password)

  const now = Date.now()
  const limit = clampInt(c.req.query('limit'), 1, DIRECTORY_LIMIT_MAX, DIRECTORY_LIMIT_DEFAULT)
  const cursor = directoryCursor(c.req.query('cursor'))
  const page = await readDirectoryPage(c.env.DB, collection, { now, cursor, limit })
  const response: PublicCollection = {
    title: page.title,
    count: page.count,
    // The marker a visit from this page carries is composed by whoever renders the link, from this
    // collection's own slug: `collectionChannelToken` is the one function both sides call, so the
    // directory and the channel reading cannot end up naming different things. Nothing here stores it,
    // and nothing here hands out a URL — a member is a slug, which is all the reader of it needs.
    notes: page.rows.map(
      (row): PublicCollectionNote => ({
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        hasPassword: Boolean(row.password_hash),
      }),
    ),
    nextCursor: nextCollectionCursor(page.rows, limit, page.cursorSort),
    limit,
  }
  return c.json(response)
}


/**
 * The document a published directory is read from.
 *
 * A separate mount from the JSON it boots with, for the same reason `/s` is separate from
 * `/api/public`: a reader's first request has no passcode in it, and a document that 401ed would
 * never get to show the gate. What it returns is the app shell with a title and a refusal to be
 * indexed — nothing about the directory's contents, because the shell is what a crawler sees before
 * any of the rules below have been answered.
 */
publicCollectionPageRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const url = new URL(c.req.url)
  const title = isValidSlug(slug) ? await loadCollectionPageTitle(c.env.DB, slug) : null
  return renderCollectionShell(c, url, title)
})

/**
 * The heading a directory's document may carry, or null when it may not carry one.
 *
 * A passcode-guarded, paused or expired directory answers with no title at all: the owner named it,
 * and a link preview would hand that name to whoever the passcode was keeping out.
 */
async function loadCollectionPageTitle(db: D1Database, slug: string): Promise<string | null> {
  const collection = await findCollectionBySlug(db, slug)
  if (!collection || collection.is_enabled === 0) return null
  if (collection.expires_at && collection.expires_at < Date.now()) return null
  if (collection.password_hash) return null
  return collection.title
}

async function renderCollectionShell(c: Context<AppBindings>, url: URL, title: string | null) {
  const shell = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)))
  if (!shell.ok) return shell
  let html = await shell.text()
  const siteName = c.env.APP_NAME || 'Inkstone'
  const heading = title?.trim() || 'A shared collection'
  const tags = [
    `<title>${escapeHtml(heading)} · ${escapeHtml(siteName)}</title>`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(heading)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
  ].join('\n    ')
  html = html.replace(/<title>[\s\S]*?<\/title>/i, '').replace('</head>', `    ${tags}\n  </head>`)
  return c.html(html, 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
}
