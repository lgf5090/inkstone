import { Rational } from './rational'

/**
 * Fixed-point arithmetic at 40 decimal places. The calculator displays at most 32 significant digits,
 * so carrying 40 keeps the last displayed digit stable through a chain of transcendental operations.
 */
const SCALE_DIGITS = 40
const SCALE = 10n ** BigInt(SCALE_DIGITS)
const HALF_SCALE = SCALE / 2n
const TWO_SCALE = SCALE * 2n

function scaled(decimal: string): bigint {
  const negative = decimal.startsWith('-')
  const text = negative ? decimal.slice(1) : decimal
  const [whole, fraction = ''] = text.split('.')
  const digits = `${whole}${fraction.padEnd(SCALE_DIGITS, '0').slice(0, SCALE_DIGITS)}`
  const value = BigInt(digits || '0')
  return negative ? -value : value
}

export const FIXED_PI = scaled('3.1415926535897932384626433832795028841971')
export const FIXED_TWO_PI = FIXED_PI * 2n
export const FIXED_HALF_PI = FIXED_PI / 2n
export const FIXED_E = scaled('2.7182818284590452353602874713526624977572')
export const FIXED_LN2 = scaled('0.6931471805599453094172321214581765680755')
export const FIXED_LN10 = scaled('2.3025850929940456840179914546843642076011')

function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero')
  const negative = (numerator < 0n) !== (denominator < 0n)
  const absN = numerator < 0n ? -numerator : numerator
  const absD = denominator < 0n ? -denominator : denominator
  let quotient = absN / absD
  const remainder = absN % absD
  if (remainder * 2n >= absD) quotient += 1n
  return negative ? -quotient : quotient
}

function mulFixed(a: bigint, b: bigint): bigint {
  return divRound(a * b, SCALE)
}

function divFixed(a: bigint, b: bigint): bigint {
  return divRound(a * SCALE, b)
}

export function rationalToFixed(value: Rational): bigint {
  return divRound(value.n * SCALE, value.d)
}

export function fixedToRational(value: bigint): Rational {
  return new Rational(value, SCALE)
}

export function expValue(value: Rational): Rational {
  const x = rationalToFixed(value)
  if (x > 10000n * SCALE) throw new RangeError('Overflow')
  if (x < -10000n * SCALE) return Rational.zero()
  return fixedToRational(expFixed(x))
}

export function lnValue(value: Rational): Rational {
  if (value.n <= 0n) throw new RangeError('Domain error')
  return fixedToRational(lnFixed(rationalToFixed(value)))
}

export function log10Value(value: Rational): Rational {
  if (value.n <= 0n) throw new RangeError('Domain error')
  return fixedToRational(divFixed(lnFixed(rationalToFixed(value)), FIXED_LN10))
}

export function logBaseValue(value: Rational, base: Rational): Rational {
  if (value.n <= 0n || base.n <= 0n || base.n === base.d) throw new RangeError('Domain error')
  return fixedToRational(divFixed(lnFixed(rationalToFixed(value)), lnFixed(rationalToFixed(base))))
}

export function sqrtValue(value: Rational): Rational {
  if (value.n < 0n) throw new RangeError('Domain error')
  if (value.isZero()) return Rational.zero()
  return fixedToRational(sqrtFixed(rationalToFixed(value)))
}

export function cbrtValue(value: Rational): Rational {
  if (value.isZero()) return Rational.zero()
  const negative = value.isNegative()
  const abs = negative ? value.negate() : value
  const result = fixedToRational(expFixed(divFixed(lnFixed(rationalToFixed(abs)), scaled('3'))))
  return negative ? result.negate() : result
}

export function powerValue(base: Rational, exponent: Rational): Rational {
  if (exponent.isInteger()) {
    const power = Number(exponent.n)
    if (!Number.isSafeInteger(power) || Math.abs(power) > 100000) throw new RangeError('Exponent out of range')
    return base.powInt(power)
  }
  if (base.n <= 0n) throw new RangeError('Domain error')
  const exponentFixed = rationalToFixed(exponent)
  const logBase = lnFixed(rationalToFixed(base))
  return fixedToRational(expFixed(mulFixed(exponentFixed, logBase)))
}

export function rootValue(value: Rational, degree: Rational): Rational {
  if (degree.isZero()) throw new RangeError('Domain error')
  if (degree.isInteger()) {
    const n = Number(degree.n)
    if (!Number.isSafeInteger(n) || n === 0 || Math.abs(n) > 1000) throw new RangeError('Exponent out of range')
    if (value.n < 0n && n % 2 === 0) throw new RangeError('Domain error')
    if (value.n < 0n) {
      const result = rootValue(value.negate(), new Rational(BigInt(Math.abs(n))))
      return n < 0 ? result.inverse().negate() : result.negate()
    }
    const inv = new Rational(1n, BigInt(Math.abs(n)))
    const result = powerValue(value, inv)
    return n < 0 ? result.inverse() : result
  }
  return powerValue(value, degree.inverse())
}

export function sinValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  return fixedToRational(sinFixed(toRadiansFixed(rationalToFixed(value), angle)))
}

export function cosValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  return fixedToRational(cosFixed(toRadiansFixed(rationalToFixed(value), angle)))
}

export function tanValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  const x = toRadiansFixed(rationalToFixed(value), angle)
  const cosine = cosFixed(x)
  if (cosine === 0n) throw new RangeError('Undefined')
  return fixedToRational(divFixed(sinFixed(x), cosine))
}

export function secValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  const cosine = cosFixed(toRadiansFixed(rationalToFixed(value), angle))
  if (cosine === 0n) throw new RangeError('Undefined')
  return fixedToRational(divFixed(SCALE, cosine))
}

export function cscValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  const sine = sinFixed(toRadiansFixed(rationalToFixed(value), angle))
  if (sine === 0n) throw new RangeError('Undefined')
  return fixedToRational(divFixed(SCALE, sine))
}

export function cotValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  const x = toRadiansFixed(rationalToFixed(value), angle)
  const sine = sinFixed(x)
  if (sine === 0n) throw new RangeError('Undefined')
  return fixedToRational(divFixed(cosFixed(x), sine))
}

export function asinValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  const x = rationalToFixed(value)
  if (x < -SCALE || x > SCALE) throw new RangeError('Domain error')
  let result: bigint
  if (x === SCALE) result = FIXED_HALF_PI
  else if (x === -SCALE) result = -FIXED_HALF_PI
  else {
    const denom = sqrtFixed(SCALE - mulFixed(x, x))
    result = atanFixed(divFixed(x, denom))
  }
  return fixedToRational(fromRadiansFixed(result, angle))
}

export function acosValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  const asin = asinValue(value, 'rad')
  const result = fixedToRational(fromRadiansFixed(FIXED_HALF_PI - rationalToFixed(asin), angle))
  return result
}

export function atanValue(value: Rational, angle: 'rad' | 'deg' | 'grad'): Rational {
  return fixedToRational(fromRadiansFixed(atanFixed(rationalToFixed(value)), angle))
}

export function sinhValue(value: Rational): Rational {
  const x = rationalToFixed(value)
  if (x > 10000n * SCALE) throw new RangeError('Overflow')
  const positive = expFixed(x)
  const negative = expFixed(-x)
  return fixedToRational(divRound(positive - negative, 2n))
}

export function coshValue(value: Rational): Rational {
  const x = rationalToFixed(value)
  if (x > 10000n * SCALE) throw new RangeError('Overflow')
  const positive = expFixed(x)
  const negative = expFixed(-x)
  return fixedToRational(divRound(positive + negative, 2n))
}

export function tanhValue(value: Rational): Rational {
  const x = rationalToFixed(value)
  if (x > 100n * SCALE) return Rational.one()
  if (x < -100n * SCALE) return Rational.one().negate()
  const positive = expFixed(x)
  const negative = expFixed(-x)
  return fixedToRational(divRound(positive - negative, positive + negative))
}

export function asinhValue(value: Rational): Rational {
  const x = rationalToFixed(value)
  const inside = sqrtFixed(mulFixed(x, x) + SCALE)
  return fixedToRational(lnFixed(x + inside))
}

export function acoshValue(value: Rational): Rational {
  if (value.compare(Rational.one()) < 0) throw new RangeError('Domain error')
  const x = rationalToFixed(value)
  const inside = sqrtFixed(mulFixed(x, x) - SCALE)
  return fixedToRational(lnFixed(x + inside))
}

export function atanhValue(value: Rational): Rational {
  const x = rationalToFixed(value)
  if (x <= -SCALE || x >= SCALE) throw new RangeError('Domain error')
  const ratio = divFixed(SCALE + x, SCALE - x)
  return fixedToRational(divRound(lnFixed(ratio), 2n))
}

export function expFixed(x: bigint): bigint {
  if (x === 0n) return SCALE
  if (x < 0n) return divFixed(SCALE, expFixed(-x))
  if (x > 10000n * SCALE) throw new RangeError('Overflow')
  let reduced = x
  let squarings = 0
  const threshold = SCALE / 10n
  while (reduced > threshold) {
    reduced = divRound(reduced, 2n)
    squarings += 1
  }
  let term = SCALE
  let sum = SCALE
  for (let n = 1; n < 400; n++) {
    term = divRound(term * reduced, SCALE * BigInt(n))
    if (term === 0n) break
    sum += term
  }
  for (let index = 0; index < squarings; index++) sum = mulFixed(sum, sum)
  return sum
}

export function lnFixed(x: bigint): bigint {
  if (x <= 0n) throw new RangeError('Domain error')
  let value = x
  let exponent = 0
  while (value >= TWO_SCALE) {
    value = divRound(value, 2n)
    exponent += 1
  }
  while (value < SCALE) {
    value *= 2n
    exponent -= 1
  }
  const z = divFixed(value - SCALE, value + SCALE)
  const zSquared = mulFixed(z, z)
  let term = z
  let sum = z
  for (let n = 3; n < 400; n += 2) {
    term = mulFixed(term, zSquared)
    if (term === 0n) break
    sum += divRound(term, BigInt(n))
  }
  return 2n * sum + BigInt(exponent) * FIXED_LN2
}

export function sqrtFixed(x: bigint): bigint {
  if (x < 0n) throw new RangeError('Domain error')
  if (x === 0n) return 0n
  let guess = BigInt(Math.floor(Math.sqrt(Number(x) / Number(SCALE)) * 1e20)) * 10n ** 20n
  if (guess <= 0n) guess = SCALE
  for (let index = 0; index < 100; index++) {
    const next = divRound(guess + divFixed(x, guess), 2n)
    if (next === guess) break
    guess = next
  }
  return guess
}

export function sinFixed(x: bigint): bigint {
  const reduced = reduceAngle(x)
  let term = reduced
  let sum = reduced
  const squared = mulFixed(reduced, reduced)
  for (let n = 1; n < 200; n++) {
    term = -divRound(mulFixed(term, squared), BigInt((2 * n) * (2 * n + 1)))
    if (term === 0n) break
    sum += term
  }
  return sum
}

export function cosFixed(x: bigint): bigint {
  const reduced = reduceAngle(x)
  const squared = mulFixed(reduced, reduced)
  let term = SCALE
  let sum = SCALE
  for (let n = 1; n < 200; n++) {
    term = -divRound(mulFixed(term, squared), BigInt((2 * n - 1) * (2 * n)))
    if (term === 0n) break
    sum += term
  }
  return sum
}

export function atanFixed(x: bigint): bigint {
  if (x === 0n) return 0n
  if (x < 0n) return -atanFixed(-x)
  if (x > SCALE) return FIXED_HALF_PI - atanFixed(divFixed(SCALE, x))
  if (x > HALF_SCALE) {
    const transformed = divFixed(x - SCALE, x + SCALE)
    return FIXED_HALF_PI / 2n + atanFixed(transformed)
  }
  const squared = mulFixed(x, x)
  let term = x
  let sum = x
  for (let n = 3; n < 400; n += 2) {
    term = -mulFixed(term, squared)
    if (term === 0n) break
    sum += divRound(term, BigInt(n))
  }
  return sum
}

function reduceAngle(x: bigint): bigint {
  let reduced = x % FIXED_TWO_PI
  if (reduced > FIXED_PI) reduced -= FIXED_TWO_PI
  else if (reduced < -FIXED_PI) reduced += FIXED_TWO_PI
  return reduced
}

function toRadiansFixed(x: bigint, angle: 'rad' | 'deg' | 'grad'): bigint {
  if (angle === 'rad') return x
  if (angle === 'deg') return divFixed(mulFixed(x, FIXED_PI), scaled('180'))
  return divFixed(mulFixed(x, FIXED_PI), scaled('200'))
}

function fromRadiansFixed(x: bigint, angle: 'rad' | 'deg' | 'grad'): bigint {
  if (angle === 'rad') return x
  if (angle === 'deg') return divFixed(mulFixed(x, scaled('180')), FIXED_PI)
  return divFixed(mulFixed(x, scaled('200')), FIXED_PI)
}

export function factorialValue(value: Rational): Rational {
  if (!value.isInteger() || value.isNegative()) throw new RangeError('Domain error')
  const n = Number(value.n)
  if (!Number.isSafeInteger(n) || n > 100000) throw new RangeError('Overflow')
  let result = 1n
  for (let index = 2n; index <= BigInt(n); index++) result *= index
  return new Rational(result)
}

export function dmsValue(value: Rational): Rational {
  const negative = value.isNegative()
  const absolute = negative ? value.negate() : value
  const degrees = absolute.truncate()
  const minutesTotal = absolute.subtract(degrees).multiply(Rational.fromInt(60))
  const minutes = minutesTotal.truncate()
  const seconds = minutesTotal.subtract(minutes).multiply(Rational.fromInt(60))
  const result = degrees.add(minutes.divide(Rational.fromInt(100))).add(seconds.divide(Rational.fromInt(10000)))
  return negative ? result.negate() : result
}
