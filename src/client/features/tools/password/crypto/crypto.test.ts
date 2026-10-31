import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createVaultSalt,
  decryptValue,
  DEFAULT_BCRYPT_ROUNDS,
  deriveVaultKey,
  encryptValue,
  evaluatePasswordStrength,
  getKeyIv,
  hashMasterPassword,
  SEALED_PREFIX,
  STRENGTH_I18N_KEYS,
  verifyMasterPassword,
} from './index'
import { getLocale, t } from '../../../../lib/i18n'
import { ZH_CN_PASSWORD_LENGTH_SUGGESTION } from '@shared/locales/zh-CN-tools'

function getKeyIvNode(passphrase: string): { key: string; iv: string } {
  const hash1 = crypto.createHash('md5').update(passphrase).digest('hex')
  const hash2 = crypto.createHash('md5').update(hash1 + passphrase).digest('hex')
  const hash3 = crypto.createHash('md5').update(hash2 + passphrase).digest('hex')
  return { key: hash2, iv: hash3.slice(16) }
}

function encryptValueNode(keyiv: { key: string; iv: string }, data: string): string {
  if (!data) return ''
  const cipher = crypto.createCipheriv('aes-256-cbc', keyiv.key, keyiv.iv)
  return cipher.update(data, 'utf8', 'hex') + cipher.final('hex')
}

describe('WS-2: Client Zero-Knowledge Crypto Engine', () => {
  describe('getKeyIv (Triple MD5 derivation)', () => {
    it('matches Node crypto digest exactly for standard passphrase', () => {
      const pass = 'MasterSecret#2026!'
      const result = getKeyIv(pass)
      const expected = getKeyIvNode(pass)

      expect(result.key).toBe(expected.key)
      expect(result.iv).toBe(expected.iv)
      expect(result.key).toHaveLength(32)
      expect(result.iv).toHaveLength(16)
    })

    it('matches Node crypto for Chinese and special characters', () => {
      const pass = '密码管家🔑@云原生2026·inkstone'
      const result = getKeyIv(pass)
      const expected = getKeyIvNode(pass)

      expect(result.key).toBe(expected.key)
      expect(result.iv).toBe(expected.iv)
    })

    it('matches Node crypto for empty passphrase', () => {
      const result = getKeyIv('')
      const expected = getKeyIvNode('')

      expect(result.key).toBe(expected.key)
      expect(result.iv).toBe(expected.iv)
    })

    it('throws TypeError if passphrase is not a string', () => {
      expect(() => getKeyIv(null as unknown as string)).toThrow(TypeError)
      expect(() => getKeyIv(undefined as unknown as string)).toThrow(TypeError)
      expect(() => getKeyIv(12345 as unknown as string)).toThrow(TypeError)
    })
  })

  describe('AES-256-CBC Encryption & Decryption', () => {
    const testKeyIv = getKeyIv('vault-master-password')

    it('encrypts and decrypts round-trip correctly', () => {
      const plaintext = 'Inkstone 密码管家 - 零知识端到端加密测试！!@#$%^&*()'
      const encrypted = encryptValue(testKeyIv, plaintext)

      expect(encrypted).not.toBe(plaintext)
      expect(encrypted.startsWith(SEALED_PREFIX)).toBe(true)

      const decrypted = decryptValue(testKeyIv, encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('never produces the same ciphertext twice for the same input', () => {
      // The old format derived its IV from the passphrase, so identical values in different rows
      // were byte-identical and revealed each other. A fresh nonce per value breaks that, and this
      // assertion is what keeps a future "optimisation" from folding it back.
      const first = encryptValue(testKeyIv, 'same-plaintext')
      const second = encryptValue(testKeyIv, 'same-plaintext')

      expect(first).not.toBe(second)
      expect(decryptValue(testKeyIv, first)).toBe('same-plaintext')
      expect(decryptValue(testKeyIv, second)).toBe('same-plaintext')
    })

    it('handles empty strings by returning empty string', () => {
      expect(encryptValue(testKeyIv, '')).toBe('')
      expect(decryptValue(testKeyIv, '')).toBe('')
    })

    it('still reads rows written by the legacy deterministic AES-256-CBC format', () => {
      const testCases = [
        'simple-ascii-password',
        '中文密码测试与特殊符号：¥…—【】《》',
        'multi\nline\r\nstring\twith\ttabs',
        '🚀🔥💡⚡️',
        'A'.repeat(5000),
      ]

      for (const text of testCases) {
        // Node's crypto stands in for the rows the old client wrote.
        const legacyCiphertext = encryptValueNode(testKeyIv, text)
        expect(legacyCiphertext.startsWith(SEALED_PREFIX)).toBe(false)
        expect(decryptValue(testKeyIv, legacyCiphertext)).toBe(text)
      }
    })

    it('throws an error when decrypting invalid or corrupted ciphertext', () => {
      expect(() => decryptValue(testKeyIv, 'not-a-valid-hex-string')).toThrow()

      const validEnc = encryptValue(testKeyIv, 'test data')
      const corruptedEnc = validEnc.slice(0, -4) + '0000'
      expect(() => decryptValue(testKeyIv, corruptedEnc)).toThrow()

      const wrongKeyIv = getKeyIv('wrong-passphrase')
      expect(() => decryptValue(wrongKeyIv, validEnc)).toThrow()
    })
  })

  describe('Salted key derivation', () => {
    it('is stable for one salt and independent across salts', () => {
      const salt = createVaultSalt()
      const first = deriveVaultKey('abcdef', salt)
      const second = deriveVaultKey('abcdef', salt)
      const other = deriveVaultKey('abcdef', createVaultSalt())

      expect(first.key).toBe(second.key)
      expect(first.key).toHaveLength(64)
      expect(other.key).not.toBe(first.key)
    })

    it('refuses a missing salt instead of falling back to the unsalted derivation', () => {
      expect(() => deriveVaultKey('abcdef', '')).toThrow()
    })

    it('seals and opens with a derived key, and a legacy key cannot open that row', () => {
      const key = deriveVaultKey('abcdef', createVaultSalt())
      const sealed = encryptValue(key, 'secret')

      expect(decryptValue(key, sealed)).toBe('secret')
      expect(() => decryptValue(getKeyIv('abcdef'), sealed)).toThrow()
    })
  })

  describe('BCrypt Master Password Hashing', () => {
    it('hashes master password and verifies successfully', () => {
      const password = 'CorrectMasterPassword#999'
      const hash = hashMasterPassword(password)

      expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/)
      expect(verifyMasterPassword(password, hash)).toBe(true)
      expect(verifyMasterPassword('WrongMasterPassword#999', hash)).toBe(false)
    })

    it('supports custom cost rounds', () => {
      const password = 'FastHashPassword'
      const hash = hashMasterPassword(password, 6)

      expect(hash.startsWith('$2a$06$') || hash.startsWith('$2b$06$')).toBe(true)
      expect(verifyMasterPassword(password, hash)).toBe(true)
    })

    it('uses DEFAULT_BCRYPT_ROUNDS = 10 by default', () => {
      expect(DEFAULT_BCRYPT_ROUNDS).toBe(10)
      const hash = hashMasterPassword('TestRounds')
      expect(hash.startsWith('$2a$10$') || hash.startsWith('$2b$10$')).toBe(true)
    })

    it('throws error when password is empty', () => {
      expect(() => hashMasterPassword('')).toThrow('Master password cannot be empty')
    })

    it('throws RangeError when rounds are out of bounds', () => {
      expect(() => hashMasterPassword('pass', 3)).toThrow(RangeError)
      expect(() => hashMasterPassword('pass', 32)).toThrow(RangeError)
    })

    it('returns false for empty password or empty hash in verify', () => {
      expect(verifyMasterPassword('', '$2a$10$fakehash')).toBe(false)
      expect(verifyMasterPassword('password', '')).toBe(false)
    })

    it('returns false for malformed hash strings without throwing', () => {
      expect(verifyMasterPassword('password', 'malformed-hash-string')).toBe(false)
    })
  })

  describe('zxcvbn Password Strength Evaluation', () => {
    it('returns default empty result for empty password', () => {
      const result = evaluatePasswordStrength('')
      expect(result.score).toBe(0)
      expect(result.color).toBe('error')
      expect(result.label).toBe('')
      expect(result.suggestions).toEqual([])
      expect(result.warning).toBe('')
      expect(result.feedback).toEqual([])
    })

    it('evaluates weak passwords (e.g. 123456)', () => {
      const result = evaluatePasswordStrength('123456')
      expect(result.score).toBe(0)
      expect(result.color).toBe('error')
      expect(result.label).toBe(t('tools.password.strength.very_weak'))
      expect(result.warning.length).toBeGreaterThan(0)
      expect(result.suggestions.length).toBeGreaterThan(0)
      expect(result.feedback).toEqual(result.suggestions)
    })

    it('evaluates strong passwords', () => {
      const result = evaluatePasswordStrength('CorrectHorse-BatteryStaple-2026-XyZ#@!')
      expect(result.score).toBe(4)
      expect(result.color).toBe('success')
      expect(result.label).toBe(t('tools.password.strength.very_strong'))
    })

    it('adds length suggestion when score is 2 and no suggestions exist', () => {
      const result = evaluatePasswordStrength('Tr0ub4dor&3')
      if (result.score === 2 && result.suggestions.length === 0) {
        expect(result.suggestions).toContain(
          getLocale() === 'zh-CN'
            ? ZH_CN_PASSWORD_LENGTH_SUGGESTION
            : 'Use a longer password — length matters more than symbols',
        )
      }
      expect(result.label).toBe(t(STRENGTH_I18N_KEYS[result.score]))
      expect(['error', 'warning', 'info', 'success']).toContain(result.color)
    })

    it('translates common zxcvbn suggestions into Chinese', () => {
      const result = evaluatePasswordStrength('admin')
      for (const suggestion of result.suggestions) {
        expect(typeof suggestion).toBe('string')
        expect(suggestion.length).toBeGreaterThan(0)
      }
    })
  })
})
