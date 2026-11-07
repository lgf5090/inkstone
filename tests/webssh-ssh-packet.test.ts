// @vitest-environment node
// W1 protocol framing, identification and KEXINIT coverage.

import { describe, expect, it } from 'vitest'
import { SSH_VERSION, SSHTransport, isSSH2Identification } from '../src/worker/webssh/ssh/transport'
import { SSHPacketBuilder, SSHPacketParser, nextSequenceNumber } from '../src/worker/webssh/ssh/packet'
import {
  KEXInitBuilder,
  filterExtInfo,
  negotiate,
  parseKEXInit,
  parseServerSigAlgs,
} from '../src/worker/webssh/ssh/kex'
import { SUPPORTED_ENCRYPTION_ALGORITHMS, SUPPORTED_MAC_ALGORITHMS } from '../src/worker/webssh/ssh/algorithms'
import { encodeString, readUint32, writeUint32 } from '../src/worker/webssh/ssh/utils'

describe('SSH identification', () => {
  it('advertises SSH 2.0 with a CRLF-terminated line', () => {
    const transport = new SSHTransport()
    const identification = new TextDecoder().decode(transport.getLocalIdentification())
    expect(SSH_VERSION.startsWith('SSH-2.0-')).toBe(true)
    expect(identification).toBe(`${SSH_VERSION}\r\n`)
    expect(isSSH2Identification('SSH-2.0-OpenSSH_10.2')).toBe(true)
    expect(isSSH2Identification('SSH-1.99-OpenSSH')).toBe(true)
    expect(isSSH2Identification('SSH-1.5-legacy')).toBe(false)
  })

  it('stores the remote version verbatim', () => {
    const transport = new SSHTransport()
    transport.setRemoteVersion('SSH-2.0-OpenSSH_9.9')
    expect(transport.getRemoteVersion()).toBe('SSH-2.0-OpenSSH_9.9')
    expect(transport.getLocalVersion()).toBe(SSH_VERSION)
  })
})

describe('SSH packet framing', () => {
  it('round-trips a plaintext packet and advances the sequence number', async () => {
    const parser = new SSHPacketParser()
    const payload = new Uint8Array([20, 1, 2, 3, 4])
    const packet = await SSHPacketBuilder.build(payload, 8, null, 0)
    parser.feed(packet)
    const parsed = await parser.nextPacket(8, (data) => data)
    expect(parsed).not.toBeNull()
    expect(parsed?.payload).toEqual(payload)
    expect(parsed?.length).toBe(packet.length - 4)
    expect(parser.getSeqNum()).toBe(1)
    expect(parser.getBufferLength()).toBe(0)
  })

  it('waits for every byte when the packet arrives in fragments', async () => {
    const parser = new SSHPacketParser()
    const payload = new Uint8Array(64).map((_, index) => index)
    const packet = await SSHPacketBuilder.build(payload, 8, null, 0)
    const split = Math.floor(packet.length / 2)
    parser.feed(packet.subarray(0, split))
    expect(await parser.nextPacket(8, (data) => data)).toBeNull()
    parser.feed(packet.subarray(split))
    const parsed = await parser.nextPacket(8, (data) => data)
    expect(parsed?.payload).toEqual(payload)
  })

  it('wraps the sequence number at 32 bits', () => {
    expect(nextSequenceNumber(0xffffffff)).toBe(0)
    expect(nextSequenceNumber(7)).toBe(8)
  })

  it('rejects a packet length above the 256 KiB ceiling', async () => {
    const parser = new SSHPacketParser()
    const header = new Uint8Array(8)
    writeUint32(header, 0, 0x7fffffff)
    parser.feed(header)
    await expect(parser.nextPacket(8, (data) => data)).rejects.toThrow('exceeds maximum allowed size')
  })

  it('rejects an unaligned packet size in the encrypted framing path', async () => {
    const parser = new SSHPacketParser()
    const header = new Uint8Array(16)
    writeUint32(header, 0, 9)
    parser.feed(header)
    await expect(parser.nextPacket(16, (data) => data)).rejects.toThrow('is not aligned to block size')
  })

  it('rejects an invalid cipher block size', async () => {
    const parser = new SSHPacketParser()
    await expect(parser.nextPacket(2, (data) => data)).rejects.toThrow('Invalid SSH cipher block size')
  })

  it('aligns padding for AEAD and non-AEAD builds', async () => {
    const payload = new Uint8Array([94, 1, 2, 3])
    const plain = await SSHPacketBuilder.build(payload, 8, null, 0)
    expect(plain.length % 8).toBe(0)
    const aead = await SSHPacketBuilder.build(payload, 16, async (data) => data, 0, true)
    expect((aead.length - 4) % 16).toBe(0)
    expect(readUint32(aead, 0)).toBe(aead.length - 4)
  })
})

describe('KEXINIT', () => {
  it('builds a list set the parser can read back', () => {
    const built = KEXInitBuilder.build()
    const parsed = parseKEXInit(built)
    expect(parsed.kexAlgorithms[0]).toBe('ext-info-c')
    expect(filterExtInfo(parsed.kexAlgorithms)).toContain('curve25519-sha256')
    expect(parsed.encryptionC2S).toEqual(SUPPORTED_ENCRYPTION_ALGORITHMS)
    expect(parsed.macC2S).toEqual(SUPPORTED_MAC_ALGORITHMS)
    expect(parsed.compressionC2S).toEqual(['none'])
    expect(parsed.firstKexPacketFollows).toBe(false)
  })

  it('rejects a truncated KEXINIT', () => {
    expect(() => parseKEXInit(new Uint8Array([20]))).toThrow('Malformed KEXINIT header')
  })

  it('rejects a KEXINIT with trailing data', () => {
    const built = KEXInitBuilder.build()
    const trailing = new Uint8Array(built.length + 1)
    trailing.set(built)
    expect(() => parseKEXInit(trailing)).toThrow('Malformed KEXINIT trailing data')
  })

  it('negotiates by client preference order', () => {
    expect(negotiate(['a', 'b'], ['b', 'a'])).toBe('a')
    expect(negotiate(['x', 'y'], ['y'])).toBe('y')
    expect(() => negotiate(['x'], ['y'], 'cipher')).toThrow('No common cipher')
  })

  it('reads server-sig-algs from EXT_INFO and ignores unknown extensions', () => {
    const extensions = [
      { name: 'server-sig-algs', value: 'ssh-ed25519,rsa-sha2-512,rsa-sha2-256' },
      { name: 'unknown@example.com', value: 'anything' },
    ]
    const parts: Uint8Array[] = [new Uint8Array([7])]
    const count = new Uint8Array(4)
    writeUint32(count, 0, extensions.length)
    parts.push(count)
    for (const extension of extensions) {
      parts.push(encodeString(extension.name))
      parts.push(encodeString(extension.value))
    }
    const payload = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) {
      payload.set(part, offset)
      offset += part.length
    }
    expect(parseServerSigAlgs(payload)).toEqual(['ssh-ed25519', 'rsa-sha2-512', 'rsa-sha2-256'])
  })

  it('rejects EXT_INFO without the message type', () => {
    expect(() => parseServerSigAlgs(new Uint8Array([1, 0, 0, 0, 0]))).toThrow('Malformed EXT_INFO message type')
  })
})
