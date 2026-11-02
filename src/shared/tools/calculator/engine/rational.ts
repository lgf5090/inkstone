import type { RationalValue } from '../types'

const TEN = 10n

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y !== 0n) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 10000) {
    throw new RangeError('Exponent out of range')
  }
  return TEN ** BigInt(Math.abs(exponent))
}

function comparePow(absN: bigint, absD: bigint, exponent: number): number {
  const left = exponent >= 0 ? absN : absN * pow10(-exponent)
  const right = exponent >= 0 ? absD * pow10(exponent) : absD
  return left < right ? -1 : left > right ? 1 : 0
}

export interface DecimalFormatOptions {
  maxSignificant?: number
  forceScientific?: boolean
  group?: boolean
  groupSeparator?: string
  decimalSeparator?: string
}

export interface RoundedDigits {
  digits: string
  exponent: number
}

export class Rational {
  readonly n: bigint
  readonly d: bigint

  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new RangeError('Division by zero')
    let num = n
    let den = d
    if (den < 0n) {
      num = -num
      den = -den
    }
    const divisor = gcd(num, den)
    if (divisor > 1n) {
      num /= divisor
      den /= divisor
    }
    this.n = num
    this.d = den
  }

  static zero(): Rational {
    return new Rational(0n)
  }

  static one(): Rational {
    return new Rational(1n)
  }

  static fromInt(value: bigint | number): Rational {
    return new Rational(typeof value === 'number' ? BigInt(Math.trunc(value)) : value)
  }

  static fromRationalValue(value: RationalValue): Rational {
    return new Rational(BigInt(value.n), BigInt(value.d))
  }

  static fromNumber(value: number): Rational {
    if (!Number.isFinite(value)) throw new RangeError('Non-finite number')
    if (Object.is(value, -0)) return Rational.zero()
    return Rational.fromDecimalString(value.toString())
  }

  static fromDecimalString(input: string): Rational {
    const text = input.trim()
    if (text === '') throw new RangeError('Empty number')
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
    if (!match) throw new RangeError('Invalid number')
    const sign = match[1] === '-' ? -1n : 1n
    const whole = match[2] ?? ''
    const fraction = match[3] ?? ''
    if (!whole && !fraction) throw new RangeError('Invalid number')
    const exponent = Number(match[4] ?? '0')
    if (!Number.isInteger(exponent) || Math.abs(exponent) > 10000) {
      throw new RangeError('Exponent out of range')
    }
    let numerator = BigInt((whole || '0') + fraction) * sign
    let denominator = pow10(fraction.length)
    if (exponent > 0) numerator *= pow10(exponent)
    else if (exponent < 0) denominator *= pow10(-exponent)
    return new Rational(numerator, denominator)
  }

  static fromRadixString(input: string, radix: number): Rational {
    const text = input.trim()
    if (!/^-?[0-9a-zA-Z]+$/.test(text)) throw new RangeError('Invalid number')
    const negative = text.startsWith('-')
    const digits = negative ? text.slice(1) : text
    let value = 0n
    const base = BigInt(radix)
    for (const char of digits) {
      const digit = parseInt(char, radix)
      if (!Number.isInteger(digit) || digit < 0 || digit >= radix) throw new RangeError('Invalid digit')
      value = value * base + BigInt(digit)
    }
    return new Rational(negative ? -value : value)
  }

  add(other: Rational): Rational {
    return new Rational(this.n * other.d + other.n * this.d, this.d * other.d)
  }

  subtract(other: Rational): Rational {
    return new Rational(this.n * other.d - other.n * this.d, this.d * other.d)
  }

  multiply(other: Rational): Rational {
    return new Rational(this.n * other.n, this.d * other.d)
  }

  divide(other: Rational): Rational {
    return new Rational(this.n * other.d, this.d * other.n)
  }

  negate(): Rational {
    return new Rational(-this.n, this.d)
  }

  abs(): Rational {
    return this.n < 0n ? this.negate() : this
  }

  inverse(): Rational {
    return new Rational(this.d, this.n)
  }

  powInt(exponent: number): Rational {
    if (!Number.isInteger(exponent)) throw new RangeError('Integer exponent required')
    if (exponent === 0) return Rational.one()
    if (exponent < 0) return this.inverse().powInt(-exponent)
    let result = Rational.one()
    let base: Rational = this
    let power = exponent
    while (power > 0) {
      if (power & 1) result = result.multiply(base)
      base = base.multiply(base)
      power >>= 1
    }
    return result
  }

  modulo(other: Rational): Rational {
    if (other.isZero()) throw new RangeError('Division by zero')
    const quotient = this.divide(other)
    const truncated = quotient.truncate()
    return this.subtract(truncated.multiply(other))
  }

  truncate(): Rational {
    return new Rational(this.n / this.d)
  }

  floor(): Rational {
    let quotient = this.n / this.d
    if (this.n < 0n && this.n % this.d !== 0n) quotient -= 1n
    return new Rational(quotient)
  }

  ceil(): Rational {
    let quotient = this.n / this.d
    if (this.n > 0n && this.n % this.d !== 0n) quotient += 1n
    return new Rational(quotient)
  }

  compare(other: Rational): number {
    const left = this.n * other.d
    const right = other.n * this.d
    return left < right ? -1 : left > right ? 1 : 0
  }

  equals(other: Rational): boolean {
    return this.n === other.n && this.d === other.d
  }

  isZero(): boolean {
    return this.n === 0n
  }

  isNegative(): boolean {
    return this.n < 0n
  }

  isInteger(): boolean {
    return this.d === 1n
  }

  toNumber(): number {
    if (this.d === 1n) {
      const value = Number(this.n)
      return Number.isFinite(value) ? value : this.n < 0n ? -Infinity : Infinity
    }
    const sign = this.n < 0n ? -1 : 1
    const absN = this.n < 0n ? -this.n : this.n
    if (absN > 9007199254740991n && this.d < 9007199254740991n) {
      const ratio = this.n / this.d
      const value = Number(ratio)
      return Number.isFinite(value) ? value : sign * Infinity
    }
    // Scale to about 17 significant digits before converting so huge denominators do not lose the value.
    const nText = absN.toString()
    const dText = this.d.toString()
    const scale = Math.max(0, 20 - (nText.length - dText.length))
    const scaledN = Number(absN * pow10(scale))
    const scaledD = Number(this.d * pow10(scale))
    return (sign * scaledN) / scaledD
  }

  toBigInt(): bigint {
    return this.n / this.d
  }

  toRationalValue(): RationalValue {
    return { n: this.n.toString(), d: this.d.toString() }
  }

  toDecimalString(options: DecimalFormatOptions = {}): string {
    const maxSignificant = Math.max(1, Math.min(40, options.maxSignificant ?? 16))
    const group = options.group ?? false
    const groupSeparator = options.groupSeparator ?? ','
    const decimalSeparator = options.decimalSeparator ?? '.'
    if (this.n === 0n) return '0'
    const negative = this.n < 0n
    const absN = negative ? -this.n : this.n
    const rounded = roundToSignificant(absN, this.d, maxSignificant)
    const scientific = options.forceScientific === true
      || rounded.exponent > maxSignificant
      || (rounded.exponent < -2 && rounded.digits.length - rounded.exponent > maxSignificant)
    if (scientific) {
      const mantissa = `${rounded.digits[0]}${decimalSeparator}${rounded.digits.slice(1)}`
      const exponent = rounded.exponent - 1
      const sign = exponent >= 0 ? '+' : ''
      return `${negative ? '-' : ''}${mantissa}e${sign}${exponent}`
    }
    let fixed = rounded
    if (rounded.exponent < 0 && rounded.digits.length - rounded.exponent > maxSignificant) {
      fixed = roundToSignificant(absN, this.d, Math.max(1, maxSignificant + rounded.exponent))
    }
    let integerPart: string
    let fractionPart: string
    if (fixed.exponent <= 0) {
      integerPart = '0'
      fractionPart = `${'0'.repeat(-fixed.exponent)}${fixed.digits}`
    } else if (fixed.exponent >= fixed.digits.length) {
      integerPart = `${fixed.digits}${'0'.repeat(fixed.exponent - fixed.digits.length)}`
      fractionPart = ''
    } else {
      integerPart = fixed.digits.slice(0, fixed.exponent)
      fractionPart = fixed.digits.slice(fixed.exponent)
    }
    fractionPart = fractionPart.replace(/0+$/, '')
    if (group) integerPart = groupInteger(integerPart, groupSeparator)
    const body = fractionPart ? `${integerPart}${decimalSeparator}${fractionPart}` : integerPart
    return `${negative ? '-' : ''}${body}`
  }

  toRadixString(radix: number, group = false): string {
    if (radix === 10) return this.toDecimalString({ maxSignificant: 40, group })
    if (!this.isInteger()) throw new RangeError('Radix output requires an integer')
    const negative = this.n < 0n
    let value = negative ? -this.n : this.n
    const base = BigInt(radix)
    const digits: string[] = []
    if (value === 0n) digits.push('0')
    while (value > 0n) {
      const digit = Number(value % base)
      digits.push(digit.toString(radix).toUpperCase())
      value /= base
    }
    digits.reverse()
    let text = digits.join('')
    if (group) text = groupRadix(text, radix)
    return `${negative ? '-' : ''}${text}`
  }
}

export function roundToSignificant(absN: bigint, absD: bigint, significant: number): RoundedDigits {
  if (absN === 0n) return { digits: '0', exponent: 0 }
  let exponent = absN.toString().length - absD.toString().length + 1
  while (comparePow(absN, absD, exponent - 1) < 0) exponent -= 1
  while (comparePow(absN, absD, exponent) >= 0) exponent += 1

  const scale = significant - exponent
  let numerator = absN
  let denominator = absD
  if (scale >= 0) numerator *= pow10(scale)
  else denominator *= pow10(-scale)
  let quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder * 2n >= denominator) quotient += 1n
  let digits = quotient.toString()
  if (digits.length > significant) {
    quotient /= 10n
    digits = quotient.toString()
    exponent += 1
  }
  if (digits.length < significant) digits = digits.padStart(significant, '0')
  digits = digits.replace(/0+$/, '')
  if (!digits) digits = '0'
  return { digits, exponent }
}

function groupInteger(value: string, separator: string): string {
  let output = ''
  for (let index = 0; index < value.length; index++) {
    if (index > 0 && (value.length - index) % 3 === 0) output += separator
    output += value[index]
  }
  return output
}

function groupRadix(value: string, radix: number): string {
  const size = radix === 2 ? 4 : radix === 16 ? 4 : radix === 8 ? 3 : 3
  let output = ''
  for (let index = 0; index < value.length; index++) {
    if (index > 0 && (value.length - index) % size === 0) output += ' '
    output += value[index]
  }
  return output
}
