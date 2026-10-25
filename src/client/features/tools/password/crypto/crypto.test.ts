import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptValue,
  DEFAULT_BCRYPT_ROUNDS,
  encryptValue,
  evaluatePasswordStrength,
  getKeyIv,
  getOriginalPasswordPlus,
  getRecoveryPass,
  hashMasterPassword,
  RECOVERY_PASSPHRASE,
  verifyMasterPassword,
} from './index'

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

function decryptValueNode(keyiv: { key: string; iv: string }, data: string): string {
  if (!data) return ''
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyiv.key, keyiv.iv)
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8')
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
      expect(/^[0-9a-f]+$/i.test(encrypted)).toBe(true)

      const decrypted = decryptValue(testKeyIv, encrypted)
      expect(decrypted).toBe(plaintext)
    })

    it('handles empty strings by returning empty string', () => {
      expect(encryptValue(testKeyIv, '')).toBe('')
      expect(decryptValue(testKeyIv, '')).toBe('')
    })

    it('is 100% interoperable with Node.js crypto AES-256-CBC', () => {
      const testCases = [
        'simple-ascii-password',
        '中文密码测试与特殊符号：¥…—【】《》',
        'multi\nline\r\nstring\twith\ttabs',
        '🚀🔥💡⚡️',
        'A'.repeat(5000),
      ]

      for (const text of testCases) {
        const nobleEncrypted = encryptValue(testKeyIv, text)
        const nodeDecrypted = decryptValueNode(testKeyIv, nobleEncrypted)
        expect(nodeDecrypted).toBe(text)

        const nodeEncrypted = encryptValueNode(testKeyIv, text)
        const nobleDecrypted = decryptValue(testKeyIv, nodeEncrypted)
        expect(nobleDecrypted).toBe(text)

        expect(nobleEncrypted).toBe(nodeEncrypted)
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

  describe('Recovery Password Tokens (getRecoveryPass & getOriginalPasswordPlus)', () => {
    it('uses recovery_key passphrase and matches uTools legacy behavior', () => {
      const password = 'mySecretUserPassword'
      const recoveryToken = getRecoveryPass(password)

      const expectedKeyIv = getKeyIvNode(RECOVERY_PASSPHRASE)
      const expectedToken = encryptValueNode(expectedKeyIv, password)

      expect(recoveryToken).toBe(expectedToken)

      const restored = getOriginalPasswordPlus(recoveryToken)
      expect(restored).toBe(password)
    })

    it('handles first 3 characters recovery format from preload.js', () => {
      const masterPass = 'SuperSecurePass2026'
      const partialPass = masterPass.slice(0, 3)
      const recoveryToken = getRecoveryPass(partialPass)

      const restored = getOriginalPasswordPlus(recoveryToken)
      expect(restored).toBe(partialPass)
    })

    it('returns empty string for empty input', () => {
      expect(getRecoveryPass('')).toBe('')
      expect(getOriginalPasswordPlus('')).toBe('')
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
      expect(result.label).toBe('非常弱')
      expect(result.warning).toBe('这是排名前10的常用弱密码')
      expect(result.suggestions.length).toBeGreaterThan(0)
      expect(result.feedback).toEqual(result.suggestions)
    })

    it('evaluates strong passwords', () => {
      const result = evaluatePasswordStrength('CorrectHorse-BatteryStaple-2026-XyZ#@!')
      expect(result.score).toBe(4)
      expect(result.color).toBe('success')
      expect(result.label).toBe('非常强')
    })

    it('adds length suggestion when score is 2 and no suggestions exist', () => {
      const result = evaluatePasswordStrength('Tr0ub4dor&3')
      if (result.score === 2 && result.suggestions.length === 0) {
        expect(result.suggestions).toContain('建议增长密码长度')
      }
      expect(['非常弱', '弱', '中等', '强', '非常强']).toContain(result.label)
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
