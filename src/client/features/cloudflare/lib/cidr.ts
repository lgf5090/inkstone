/**
 * CIDR arithmetic for the toolbox.
 *
 * IPv4 and IPv6 share one BigInt path; the IPv4 result additionally reports the broadcast address and
 * excludes it from the usable-host count, which is the number a reader expects from a subnet card.
 */
export interface CidrResult {
  version: 4 | 6
  network: string
  first: string
  last: string
  broadcast: string | null
  prefix: number
  addressCount: string
  usableHosts: string
}

function parseIpv4(value: string): bigint[] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const octets: bigint[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const number = Number(part)
    if (number > 255) return null
    octets.push(BigInt(number))
  }
  return octets
}

function formatIpv4(value: bigint): string {
  return [24, 16, 8, 0].map((shift) => String((value >> BigInt(shift)) & 255n)).join('.')
}

function parseIpv6(value: string): bigint[] | null {
  const halves = value.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const out: bigint[] = []
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    out.push(BigInt(`0x${group}`))
  }
  return out
}

function formatIpv6(value: bigint): string {
  const groups: string[] = []
  for (let index = 7; index >= 0; index -= 1) {
    groups.push(((value >> BigInt(index * 16)) & 0xffffn).toString(16))
  }
  return groups.join(':')
}

export function parseCidr(input: string): CidrResult {
  const text = input.trim()
  const match = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(text)
  if (!match) throw new Error('invalid_cidr')
  const address = match[1]
  const prefix = Number(match[2])
  const ipv4 = parseIpv4(address)
  const bits = ipv4 ? 32 : 128
  if (prefix < 0 || prefix > bits) throw new Error('invalid_cidr')
  const groups = ipv4 ?? parseIpv6(address)
  if (!groups) throw new Error('invalid_cidr')
  let value = 0n
  for (const group of groups) value = (value << (ipv4 ? 8n : 16n)) | group
  const hostBits = BigInt(bits - prefix)
  const mask = hostBits === 0n ? (1n << BigInt(bits)) - 1n : ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n)
  const network = value & mask
  const last = network | ((1n << hostBits) - 1n)
  const format = ipv4 ? formatIpv4 : formatIpv6
  const count = 1n << hostBits
  const usable = ipv4
    ? (prefix >= 31 ? count : count - 2n)
    : count
  return {
    version: ipv4 ? 4 : 6,
    network: `${format(network)}/${prefix}`,
    first: format(network),
    last: format(last),
    broadcast: ipv4 ? formatIpv4(last) : null,
    prefix,
    addressCount: count.toString(),
    usableHosts: usable.toString(),
  }
}
