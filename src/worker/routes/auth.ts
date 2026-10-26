import { Hono, type Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { DEFAULT_SETTINGS } from '@shared/constants'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/assistant'
import { isValidTimeZone } from '@shared/assistant-schedule'
import { isBitmapAvatarDataUrl, PROFILE_NAME_MAX_LENGTH } from '@shared/avatar'
import type { AppLocale, SessionInfo, UserSettings } from '@shared/types'
import type { AppBindings, Env } from '../env'
import { AssistantStore } from '../assistant/store'
import { drainAttachmentCleanup } from '../attachments/cleanup'
import { attachmentCleanupTarget } from '../attachments/keys'
import {
  discardStoredAvatar,
  normalizeAvatarPreference,
  persistUploadedAvatar,
  storedAvatarCleanup,
  type StoredAvatarObject,
} from '../avatars/storage'
import { seedWorkspace } from '../db/seed'
import { ApiError } from '../lib/errors'
import { timingSafeEqual } from '../lib/encoding'
import { newId } from '../lib/id'
import { getAllowRegistration } from '../lib/instance-settings'
import { buildSiteInfo, loadUser, publicUser, sessionInfo } from '../lib/session-info'
import {
  dummyVerify,
  hashPassword,
  isPasswordHash,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  USERNAME_PATTERN,
  validateNewPassword,
  verifyPassword,
} from '../lib/password'
import { requireCurrentPassword } from '../lib/reauth'
import { JSON_BODY_LIMITS, readJson, requestClientIp } from '../lib/request'
import { commitChange } from '../lib/notify'
import { createSession, destroyOtherSessions, destroySession } from '../lib/session-store'
import { createTotpLoginChallenge, hasEnabledTotp } from '../lib/totp-service'
import { revokeLongLivedCredentials } from '../mcp/credentials'
import {
  assertAttemptBudget,
  assertNotLocked,
  clearLoginFailures,
  consumeAttemptBudget,
  recordLoginFailure,
  type ThrottleTarget,
} from '../lib/throttle'
import {
  clearSessionCookie,
  requireAuth,
  rowToUser,
  sessionCookieNames,
  writeSessionCookie,
} from '../middleware/auth'
import {
  accountByLoginName,
  hasAnyAccount,
  insertAccount,
  replacePasswordHash,
  updateProfile,
  usernameTaken,
} from '../auth/store'

export const authRoutes = new Hono<AppBindings>()

export { normalizeAvatarPreference } from '../avatars/storage'

export function loginThrottleTargets(username: string, ip: string): ThrottleTarget[] {
  const identity = throttleIdentity(username)
  const targets: ThrottleTarget[] = [
    { key: `login:${ip}:${identity}`, freeFails: 5 },
    { key: `login-ip:${ip}`, freeFails: 25 },
  ]
  // Account-wide cap so a distributed botnet cannot retry one account
  // from many IPs forever; cleared on every successful sign-in, so a
  // normal user only ever notices it after 30 failed attempts per hour.
  // Malformed names collapse to one shared identity, so they keep only the
  // per-IP buckets: otherwise strangers could lock out a user who mistypes.
  if (identity !== '_invalid') {
    targets.push({ key: `login-account:${identity}`, freeFails: 30 })
  }
  return targets
}

export function loginWorkTargets(username: string, ip: string) {
  const identity = throttleIdentity(username)
  const windowMs = 10 * 60 * 1000
  return [
    { key: `login-work:${ip}:${identity}`, maxAttempts: 8, windowMs },
    { key: `login-work-ip:${ip}`, maxAttempts: 30, windowMs },
  ]
}

export function loginSuccessClearTargets(username: string, ip: string): string[] {
  const identity = throttleIdentity(username)
  return [
    `login:${ip}:${identity}`,
    `login-account:${identity}`,
    `login-work:${ip}:${identity}`,
  ]
}

function throttleIdentity(username: string): string {
  return USERNAME_PATTERN.test(username) ? username : '_invalid'
}

async function rotateSession(c: Context<AppBindings>, userId: string): Promise<string> {
  await destroyPresentedSessions(c)
  return createSession(c.env.DB, userId)
}

async function destroyPresentedSessions(c: Context<AppBindings>): Promise<void> {
  const tokens = new Set(
    sessionCookieNames(c.req.url)
      .map((name) => getCookie(c, name))
      .filter((token): token is string => Boolean(token)),
  )
  await Promise.all([...tokens].map((token) => destroySession(c.env.DB, token)))
}

authRoutes.get('/session', async (c) => {
  const user = c.get('user')
  if (user) return c.json(await sessionInfo(c.env, user))
  const body: SessionInfo = { user: null, site: await buildSiteInfo(c.env, false), settings: null }
  return c.json(body)
})


type RegistrationDecision =
  | { ok: true; role: 'owner' | 'member' }
  | { ok: false; reason: 'registration_closed' }

export function decideRegistration(input: {
  userCount: number
  registrationOpen: boolean
}): RegistrationDecision {
  if (input.userCount === 0) return { ok: true, role: 'owner' }
  if (input.registrationOpen) return { ok: true, role: 'member' }
  return { ok: false, reason: 'registration_closed' }
}

interface RegistrationGate {
  decision: RegistrationDecision
  hasAnyUser: boolean
}

async function gate(env: Env): Promise<RegistrationGate> {
  // The probe answers "is the instance empty", which is all `decideRegistration` looks at, so the
  // count it is handed is 1 or 0 rather than a tally of every account.
  const hasAnyUser = await hasAnyAccount(env.DB)
  return {
    decision: decideRegistration({
      userCount: hasAnyUser ? 1 : 0,
      registrationOpen: await getAllowRegistration(env.DB),
    }),
    hasAnyUser,
  }
}

function setupTokenRequired(env: Env, hasAnyUser: boolean): boolean {
  return Boolean(env.SETUP_TOKEN) && !hasAnyUser
}


authRoutes.post('/register', async (c) => {
  const body = await readJson<{ username?: string; password?: string; locale?: string; setupToken?: string; timezone?: string }>(c, 4096)
  const locale = normalizeLocale(body.locale ?? c.req.header('Accept-Language'))
  const timezone = registrationTimeZone(body.timezone)
  const rawUsername = typeof body.username === 'string' ? body.username.slice(0, 128) : ''
  const username = normalizeUsername(rawUsername)
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, 'invalid_username', 'Username must contain 3-32 lowercase letters, numbers, underscores, or hyphens')
  }
  const weak = validateNewPassword(body.password)
  if (weak) throw new ApiError(400, 'weak_password', weak)

  const { decision, hasAnyUser } = await gate(c.env)
  if (!decision.ok) {
    throw new ApiError(403, 'registration_closed', 'Registration is closed on this instance')
  }

  await assertAttemptBudget(() => consumeAttemptBudget(c.env.DB, [
    {
      key: `register-work:${requestClientIp(c)}`,
      maxAttempts: 12,
      windowMs: 10 * 60 * 1000,
    },
  ]))

  if (setupTokenRequired(c.env, hasAnyUser)) {
    const expected = c.env.SETUP_TOKEN ?? ''
    if (expected.length < 16) {
      throw new ApiError(500, 'server_misconfigured', 'SETUP_TOKEN must be at least 16 characters')
    }
    const provided = typeof body.setupToken === 'string' ? body.setupToken : ''
    if (!provided || !timingSafeEqual(provided, expected)) {
      await dummyVerify()
      throw new ApiError(403, 'setup_token_required', 'A valid setup token is required to create the first account')
    }
  }

  const db = c.env.DB
  const id = newId()
  const now = Date.now()
  const created = await insertAccount(db, {
    id,
    username,
    passwordHash: await hashPassword(body.password!),
    settings: JSON.stringify(settingsFor(locale)),
    now,
  })

  if (!created) {
    if (await usernameTaken(db, username)) throw new ApiError(409, 'username_taken', "That username is already in use")
    throw new ApiError(403, 'registration_closed', 'Registration is closed on this instance')
  }

  if (timezone) {
    // The day boundary every to-do surface reads is the account's scheduling zone, held in the
    // assistant's settings row; a fresh account has no row and so answers UTC. A zone that fails to
    // land leaves the account usable at UTC — the same state an older client registers into — and the
    // to-do app's own Settings row shows the zone, so a reader can still correct it.
    await new AssistantStore(db, id, c.env)
      .saveSettings({ ...DEFAULT_ASSISTANT_SETTINGS, timezone })
      .catch((err) => {
        console.warn('[inkstone] Failed to seed the account timezone; the account stays on UTC until Settings → To-do:', err)
      })
  }

  await seedWorkspace(c.env, id, locale).catch((err) => {
    console.warn('[inkstone] Failed to initialize sample content; the account remains usable:', err)
  })
  const token = await rotateSession(c, id)
  writeSessionCookie(c, token)
  const user = await loadUser(c.env, id)
  if (!user) throw new Error('created_user_missing')
  return c.json(await sessionInfo(c.env, user), 201)
})

authRoutes.post('/login', async (c) => {
  const body = await readJson<{ username?: string; password?: string }>(c, 4096)
  const rawUsername = typeof body.username === 'string' ? body.username.slice(0, 128) : ''
  const username = normalizeUsername(rawUsername)
  const password = typeof body.password === 'string' ? body.password : ''
  const db = c.env.DB
  const throttleTargets = loginThrottleTargets(username, requestClientIp(c))
  const workTargets = loginWorkTargets(username, requestClientIp(c))

  await assertAttemptBudget(async () => {
    await assertNotLocked(db, throttleTargets)
    await consumeAttemptBudget(db, workTargets)
  })

  const row = USERNAME_PATTERN.test(username)
    ? await accountByLoginName(db, username)
    : null

  let valid = false
  if (
    row?.password_hash &&
    password.length <= PASSWORD_MAX_LENGTH &&
    isPasswordHash(row.password_hash)
  ) {
    valid = await verifyPassword(password, row.password_hash)
  } else {
    await dummyVerify()
  }

  if (!valid || !row) {
    await recordLoginFailure(db, throttleTargets)
    throw new ApiError(401, 'invalid_credentials', "Incorrect username or password")
  }

  // A successful sign-in proves this identity is legitimate: clear only the
  // identity-scoped throttling keys, never the shared per-IP buckets, or an
  // attacker with any low-value account could reset the per-IP failure
  // ceiling between bursts of password guessing.
  const [, totpEnabled] = await Promise.all([
    clearLoginFailures(db, loginSuccessClearTargets(username, requestClientIp(c))),
    hasEnabledTotp(db, row.id),
  ])
  if (totpEnabled) {
    return c.json(await createTotpLoginChallenge(db, row.id, row.password_hash))
  }

  const token = await rotateSession(c, row.id)
  writeSessionCookie(c, token)
  return c.json(await sessionInfo(c.env, rowToUser(row)))
})


authRoutes.put('/profile', requireAuth, async (c) => {
  const current = c.get('user')
  const body = await readJson<{ name?: unknown; avatarUrl?: unknown }>(
    c,
    JSON_BODY_LIMITS.profile,
  )
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name')
  const hasAvatar = Object.prototype.hasOwnProperty.call(body, 'avatarUrl')
  if (!hasName && !hasAvatar) {
    throw ApiError.badRequest('Provide a display name or avatar')
  }

  const name = hasName ? normalizeDisplayName(body.name) : current.name
  if (name === null) {
    throw new ApiError(
      400,
      'invalid_profile_name',
      `Display name must contain 1-${PROFILE_NAME_MAX_LENGTH} characters`,
    )
  }
  let avatarUrl = hasAvatar ? normalizeAvatarPreference(body.avatarUrl) : current.avatarUrl
  if (avatarUrl === null) {
    throw new ApiError(400, 'invalid_avatar', 'Choose a generated avatar or upload a supported image')
  }

  if (name === current.name && avatarUrl === current.avatarUrl) {
    return c.json(publicUser(current))
  }

  let storedAvatar: StoredAvatarObject | null = null
  if (hasAvatar && isBitmapAvatarDataUrl(avatarUrl)) {
    storedAvatar = await persistUploadedAvatar(c.env, current.id, avatarUrl)
    avatarUrl = storedAvatar.preference
  }

  const previousAvatar = hasAvatar ? storedAvatarCleanup(current.avatarUrl) : null
  let changed: boolean
  try {
    changed = await updateProfile(c.env.DB, current.id, {
      name,
      replaceName: hasName,
      avatarUrl,
      replaceAvatar: hasAvatar,
      currentAvatarUrl: current.avatarUrl,
      cleanupObjectKey: previousAvatar
        ? attachmentCleanupTarget(previousAvatar.storage, previousAvatar.key)
        : null,
      now: Date.now(),
    })
  } catch (error) {
    if (storedAvatar) await discardStoredAvatar(c.env, storedAvatar)
    throw error
  }
  if (!changed) {
    if (storedAvatar) await discardStoredAvatar(c.env, storedAvatar)
    throw ApiError.conflict('The profile changed elsewhere. Refresh and try again')
  }

  if (previousAvatar) {
    const cleanup = drainAttachmentCleanup(c.env, current.id).catch((error) => {
      console.warn('[inkstone] Replaced avatar cleanup will retry later:', error)
    })
    if (c.executionCtx) c.executionCtx.waitUntil(cleanup)
    else await cleanup
  }

  await commitChange(c, 'profile', current.id, 'upsert')
  const user = await loadUser(c.env, current.id)
  if (!user) throw ApiError.unauthenticated()
  return c.json(publicUser(user))
})


authRoutes.post('/password', async (c) => {
  const user = c.get('user')
  if (!user) throw ApiError.unauthenticated()
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(c, 4096)
  const weak = validateNewPassword(body.newPassword)
  if (weak) throw new ApiError(400, 'weak_password', weak)

  const db = c.env.DB
  const expectedHash = await requireCurrentPassword(db, user.id, body.currentPassword)
  const newHash = await hashPassword(body.newPassword!)
  const changed = await replacePasswordHash(db, user.id, newHash, expectedHash)

  if (!changed) {
    throw new ApiError(409, 'conflict', 'Account credentials changed elsewhere. Refresh and try again')
  }

  await destroyOtherSessions(db, user.id, c.get('sessionId'))
  await revokeLongLivedCredentials(db, c.env.OAUTH_PROVIDER, user.id)
  const token = await rotateSession(c, user.id)
  writeSessionCookie(c, token)
  return c.json({ ok: true })
})

authRoutes.post('/logout', async (c) => {
  await destroyPresentedSessions(c)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

function normalizeLocale(value: unknown): AppLocale {
  return typeof value === 'string' && value.toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
}

/** The longest IANA name worth reading: the shipped zone set tops out well under this. */
const TIMEZONE_MAX_LENGTH = 64

/**
 * The zone a new account starts its day in, or null when the client named none.
 *
 * Without it every fresh account falls back to UTC, and a reader east of Greenwich spends eight hours
 * of each day being told yesterday — on the due labels, the plan groups and the close-out page alike.
 * The value comes from a browser, so it is checked against the runtime's own zone table before it is
 * stored and refused outright if it is not one: a zone nothing can resolve would make every date the
 * app reasons about uncomputable, which is worse than the UTC it replaces.
 */
function registrationTimeZone(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const zone = typeof value === 'string' ? value.trim() : ''
  if (!zone || zone.length > TIMEZONE_MAX_LENGTH || !isValidTimeZone(zone)) {
    throw new ApiError(400, 'invalid_timezone', 'The timezone must be an IANA zone the server recognises')
  }
  return zone
}

export function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (
    !normalized ||
    [...normalized].length > PROFILE_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    return null
  }
  return normalized
}

function settingsFor(locale: AppLocale): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    appearance: { ...DEFAULT_SETTINGS.appearance, language: locale },
    editor: { ...DEFAULT_SETTINGS.editor },
    preview: { ...DEFAULT_SETTINGS.preview },
    backup: { ...DEFAULT_SETTINGS.backup },
    sync: { ...DEFAULT_SETTINGS.sync },
  }
}
