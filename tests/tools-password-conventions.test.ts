/**
 * The password vault's own invariants, written down after an audit found every one of them broken.
 *
 * These are deliberately module-scoped rather than folded into the shared gates: the shared
 * component-level gates only read `src/client/styles`, and widening them in one step would judge
 * every other feature by a rule it has never been held to. Everything below can only regress here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MODULE_DIR = 'src/client/features/tools/password'
const ROUTES_FILE = 'src/worker/routes/tools-password.ts'

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const target = join(directory, entry)
    if (statSync(target).isDirectory()) walk(target, out)
    else out.push(target)
  }
  return out
}

/** Comments describe the old bug; only code counts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const sources = walk(MODULE_DIR)
  .filter((file) => !file.includes('.test.'))
  .map((file) => ({ file, code: stripComments(readFileSync(file, 'utf8')) }))
const routes = readFileSync(ROUTES_FILE, 'utf8')

const PALETTE_COLORS =
  /\b(?:bg|text|border|fill|ring|divide|placeholder|from|to|via)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:[0-9]{2,3})\b|\b(?:bg|text|border|fill|ring)-(?:white|black)\b/

describe('password vault conventions', () => {
  it('wears design tokens, never a raw palette colour', () => {
    // `text-amber-400` and `bg-blue-600 text-white` were the norm here; none of them passed a
    // contrast gate because no gate looked at component files.
    const offenders = sources.filter(({ code }) => PALETTE_COLORS.test(code))
    expect(offenders.map((entry) => entry.file)).toEqual([])
  })

  it('never reaches for !important', () => {
    const offenders = sources.filter(({ code }) => code.includes('!important'))
    expect(offenders.map((entry) => entry.file)).toEqual([])
  })

  it('never opens a native dialog', () => {
    const offenders = sources.filter(({ code }) =>
      /\bwindow\.(?:alert|confirm|prompt)\s*\(/.test(code),
    )
    expect(offenders.map((entry) => entry.file)).toEqual([])
  })

  it('turns the browser password manager and spell-check off on every secret field', () => {
    const offenders: string[] = []
    for (const { file, code } of sources) {
      const pattern = /type=(?:"password"|\{showPassword \? 'text' : 'password'\})/g
      for (const match of code.matchAll(pattern)) {
        // The attribute list of one element is a few hundred characters; `autoComplete` must be in
        // it, or the field silently joins the browser's own password store.
        const element = code.slice(match.index ?? 0, (match.index ?? 0) + 500)
        const end = element.indexOf('/>')
        const attributes = end >= 0 ? element.slice(0, end) : element
        if (!/\bautoComplete=/.test(attributes)) offenders.push(`${file}:${match.index}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('gives every image an accessible name', () => {
    const offenders: string[] = []
    for (const { file, code } of sources) {
      for (const match of code.matchAll(/<img\b/g)) {
        const element = code.slice(match.index ?? 0, (match.index ?? 0) + 400)
        const end = element.indexOf('/>')
        const attributes = end >= 0 ? element.slice(0, end) : element
        if (!/\balt=/.test(attributes)) offenders.push(`${file}:${match.index}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('seals new values with the salted key, never the legacy derivation', () => {
    // `encryptValue(getKeyIv(password), …)` would quietly put the triple-MD5 scheme back in charge.
    const offenders = sources.filter(({ code }) => /encryptValue\(\s*getKeyIv\(/.test(code))
    expect(offenders.map((entry) => entry.file)).toEqual([])

    const store = sources.find((entry) => entry.file.endsWith('/store.ts'))
    expect(store?.code).toContain('deriveVaultKey')
  })

  it('keeps the removed half-password recovery out', () => {
    // The hint held the first three characters under a key that shipped in the bundle.
    const offenders = sources.filter(({ code }) =>
      /getRecoveryPass|getOriginalPasswordPlus|RECOVERY_PASSPHRASE|recoveryHint/.test(code),
    )
    expect(offenders.map((entry) => entry.file)).toEqual([])
  })

  it('locks by dropping the decrypted rows', () => {
    const store = sources.find((entry) => entry.file.endsWith('/store.ts'))!
    // The implementation, not the interface declaration above it.
    const start = store.code.indexOf('lock: () => {')
    expect(start).toBeGreaterThan(-1)
    const lockBody = store.code.slice(start, start + 400)
    expect(lockBody).toContain('decryptedAccounts: {}')
  })

  it('verifies the old master password before the server rewrites every row', () => {
    expect(routes).toContain('/vault/unlock')
    expect(routes).toContain('verifyMasterHash(body.oldPassword')
    // The reset must not be reachable with a session alone.
    expect(routes).toMatch(/oldPassword[\s\S]{0,400}verifyMasterHash|verifyMasterHash\(body\.oldPassword/)
  })

  it('no longer keeps or returns WebDAV credentials now that the fake sync is gone', () => {
    const store = readFileSync('src/worker/tools/password/store.ts', 'utf8')
    expect(store).not.toContain('webdav_password')
    expect(store).not.toContain('webdav_url')
    expect(store).not.toContain('hasPassword')
  })
})
