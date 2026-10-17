// @vitest-environment node
/**
 * The one predicate every relay asks before it points a request at an address the account configured.
 *
 * What is decided here is the text of an address, so the spellings are the whole test: `2130706433` is
 * `127.0.0.1`, `0x7f000001` is `127.0.0.1`, and an IPv6 literal carries the same address in words that
 * only look unlike it. A public host and a public number have to stay allowed, or the guard is a way of
 * breaking the product rather than a guard.
 */
import { describe, expect, it } from 'vitest'
import { assertRelayableEndpoint, isBlockedTarget, pickRelayHeaders } from '@shared/ai-proxy-guard'

describe('a literal IP, in every spelling that names one', () => {
  it('refuses the loopback address however it is written', () => {
    for (const host of [
      '127.0.0.1', '127.0.0.01', '127.0.1', '127.1', '127.', '0177.0.0.1', '0177.1', '0x7f.0.0.1',
      '2130706433', '0x7f000001', '0X7F000001', '017700000001', '127.0.0.1.', '127.0.0.1!',
      '2130706433!', '0x7f000001!', '[::1]', '::1', '0:0:0:0:0:0:0:1', '[::7f00:1]', '::ffff:7f00:1',
      '::ffff:127.0.0.1', '[0:0:0:0:0:ffff:7f00:1]',
    ]) {
      expect(isBlockedTarget(host), host).toBe(true)
    }
  })

  it('refuses the other reserved ranges in each of their shapes', () => {
    for (const host of [
      '0.0.0.0', '0.1.2.3', '10.1.2.3', '169.254.169.254', '2852039166', '0xa9fea9fe', '169.254.0.1',
      '172.16.0.1', '172.31.255.255', '192.168.1.9', '192.0.0.1', '100.64.0.1', '100.127.255.255',
      '198.18.0.1', '198.19.1.1', '224.0.0.1', '255.255.255.255', '::', '[::]', 'fd00::1', 'fc00::1',
      'fe80::1', 'febf::1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254',
    ]) {
      expect(isBlockedTarget(host), host).toBe(true)
    }
  })

  it('refuses the metadata names and the private zones a host can sit in', () => {
    for (const host of [
      'metadata', 'metadata.google.internal', 'instance-data', 'localhost', 'api.localhost', 'note.local',
      'worker.default.svc.cluster.local', 'box.home.arpa', '',
    ]) {
      expect(isBlockedTarget(host), host).toBe(true)
    }
  })

  it('refuses a number that is not an address rather than guessing which parser meant it', () => {
    for (const host of ['999.999.999.999', '4294967296', '1.1.1.1.1', '018.1.1.1', '127.0.0.256', '127.0.0.1:8080', 'gg::1', 'fe80:::1']) {
      expect(isBlockedTarget(host), host).toBe(true)
    }
  })

  it('still allows the providers an account really configures', () => {
    for (const host of [
      'api.openai.com', 'api.deepseek.com', 'generativelanguage.googleapis.com', 'api.anthropic.com',
      '302.ai', '01ai.com', '1password.com', '8.8.8.8', '1.1.1.1', '169.253.0.1', '169.255.0.1', '172.32.0.1',
      '100.128.0.1', '2001:4860:4860::8888', '2606:4700:4700::1111',
    ]) {
      expect(isBlockedTarget(host), host).toBe(false)
    }
  })
})

describe('the address a relay is actually handed', () => {
  it('refuses an internal target whatever the scheme spelling was', () => {
    for (const endpoint of [
      'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/',
      'http://[::7f00:1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:a9fe:a9fe]/',
      'http://169.254.169.254/latest/meta-data', 'http://metadata.google.internal/',
      'http://127.0.0.1!/', 'http://2130706433!/',
    ]) {
      expect(() => assertRelayableEndpoint(endpoint), endpoint).toThrow(/publicly reachable/)
    }
  })

  it('refuses anything that is not a plain public http(s) endpoint', () => {
    expect(() => assertRelayableEndpoint('file:///etc/passwd')).toThrow(/http or https/)
    expect(() => assertRelayableEndpoint('http://user:pass@127.0.0.1/')).toThrow(/credentials|publicly reachable/)
    expect(() => assertRelayableEndpoint('not a url')).toThrow(/Invalid endpoint/)
    expect(assertRelayableEndpoint('https://api.openai.com/v1').hostname).toBe('api.openai.com')
  })
})

describe('the header a relay may carry', () => {
  it('keeps the Gemini key header and drops everything else', () => {
    expect(pickRelayHeaders({ 'x-goog-api-key': 'g-key', cookie: 'session=1', origin: 'https://app.test' })).toEqual({ 'x-goog-api-key': 'g-key' })
  })
})
