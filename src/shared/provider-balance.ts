/**
 * Which providers will say what they are owed, and how to read it out of their own answer.
 *
 * The reader asked for a balance per API key, because a ring of three keys is three wallets and the settings
 * screen showed none of them. What this file holds is the whole of the knowledge about each vendor's billing
 * endpoint: an address, the header the credential goes into, and the field names to read. It is data on
 * purpose — a working implementation of this feature elsewhere in the world runs a user-supplied script per
 * provider, which means the account's own key is handed into code the reader pasted in. That is not being
 * ported here. An adapter is a row, so the only thing a new vendor needs is somebody who has read its answer.
 *
 * Two rules hold this together:
 *  - a balance is only ever asked of the host the provider already sends its keys to. The table is keyed by
 *    host, so a relay at an address of the reader's own never receives a billing request aimed at a vendor,
 *    and a vendor's key never travels somewhere the reader did not already point it;
 *  - nothing here is a secret and nothing here is stored. A reading is fetched, shown, and forgotten: it is
 *    not written into settings, not part of a backup, and not logged.
 *
 * The shapes below were read off a working client of each of these endpoints (cc-switch's Rust balance
 * service, `src-tauri/src/services/balance.rs`), not off the vendors' own references, which were not
 * reachable from the machine this was written on. Where a vendor's documentation disagrees, the vendor wins
 * and the row here is the thing to correct. `amountPaths` is a candidate list for that reason: a field that
 * has moved is worth one line rather than a broken screen.
 */

/** How the credential is handed over. Two shapes cover every provider listed here. */
export type BalanceKeyCarrier = 'bearer' | 'raw'

export interface BalanceSpec {
  /**
   * The provider's own host, compared case-insensitively and exactly.
   *
   * `api.deepseek.com` matches a provider based there; `deepseek.com.example.test` does not, which is the
   * difference between asking a vendor for a balance and asking whatever the reader's address really is.
   */
  host: string
  /** Appended to that origin. Never built from reader input. */
  path: string
  keyCarrier: BalanceKeyCarrier
  /** The number, dotted, first hit wins — `balance_infos.0.total_balance` reaches into a list. */
  amountPaths: readonly string[]
  /** A second number to take the amount down by: a vendor that reports credits spent rather than credits left. */
  minusPath?: string
  /** Where the three-letter unit sits, when the answer carries one at all. */
  currencyPath?: string
  /** What to call the money when the answer does not say, and the vendor is only read in one currency. */
  defaultCurrency: string
  /** What one unit of the reported number is worth, when it is not already money (Novita counts 0.0001 USD). */
  divisor?: number
}

/**
 * The providers with a billing endpoint that a plain API key can ask.
 *
 * Absence here is an answer, not a gap: Anthropic, OpenAI and Gemini report what is left only to an OAuth
 * session held by a desktop login, and Volcengine wants a separate signed access/secret pair. Those say
 * "this provider does not offer a balance" on screen rather than being guessed at.
 */
export const BALANCE_SPECS: readonly BalanceSpec[] = [
  {
    host: 'api.deepseek.com',
    path: '/user/balance',
    keyCarrier: 'bearer',
    amountPaths: ['balance_infos.0.total_balance', 'total_balance'],
    currencyPath: 'balance_infos.0.currency',
    defaultCurrency: 'CNY',
  },
  {
    // `limit_remaining` on this vendor's `/key` is a cap the reader set, not what is left of a wallet, so the
    // credits endpoint is the one that answers the question that was asked — and it reports spend, not rest.
    host: 'openrouter.ai',
    path: '/api/v1/credits',
    keyCarrier: 'bearer',
    amountPaths: ['data.total_credits', 'total_credits'],
    minusPath: 'data.total_usage',
    defaultCurrency: 'USD',
  },
  {
    host: 'api.siliconflow.cn',
    path: '/v1/user/info',
    keyCarrier: 'bearer',
    amountPaths: ['data.totalBalance', 'totalBalance'],
    defaultCurrency: 'CNY',
  },
  {
    // The same product on the international host, priced in another currency, so the unit is part of the row.
    host: 'api.siliconflow.com',
    path: '/v1/user/info',
    keyCarrier: 'bearer',
    amountPaths: ['data.totalBalance', 'totalBalance'],
    defaultCurrency: 'USD',
  },
  {
    host: 'api.stepfun.com',
    path: '/v1/accounts',
    keyCarrier: 'bearer',
    amountPaths: ['data.balance', 'balance'],
    defaultCurrency: 'CNY',
  },
  {
    host: 'api.novita.ai',
    path: '/v3/user/balance',
    keyCarrier: 'bearer',
    amountPaths: ['data.availableBalance', 'availableBalance'],
    divisor: 10_000,
    defaultCurrency: 'USD',
  },
]

/** What is left in one wallet, in the vendor's own currency. */
export interface BalanceAmount {
  amount: number
  currency: string
}

/**
 * Why a balance could not be had, in four kinds the screen can name.
 *
 * `unreachable` is a transport fact and says nothing about the reader's account; the other three are answers
 * about the request itself, and `unauthorized` is the one a reader with a stale key needs to see named.
 */
export type BalanceFailureReason = 'unauthorized' | 'unreachable' | 'unsupported' | 'unreadable'

export type BalanceReading =
  | ({ ok: true } & BalanceAmount)
  | ({ ok: false } & { reason: BalanceFailureReason })

/** One key's reading, as the settings screen is allowed to see it: the row's own words, never its secret. */
interface KeyIdentity {
  /** Empty for the provider's own key, which is one of the ring rather than a row apart. */
  keyId: string
  /** The name the reader gave the row, or empty when they gave it none. */
  label: string
  /** Last four characters, for the tooltip that has to say which key a number belongs to. */
  keyHint: string
}

export type KeyBalance = BalanceReading & KeyIdentity

/** What the balance route answers: whether this provider tells at all, and then one reading per key. */
export interface ProviderBalanceAnswer {
  supported: boolean
  readings: KeyBalance[]
}

/** The provider's own address, told as the one thing the table is keyed by. */
export function balanceSpecFor(baseUrl: string): BalanceSpec | null {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  return BALANCE_SPECS.find((spec) => spec.host.toLowerCase() === host) ?? null
}

/**
 * One dotted path out of a payload, or null.
 *
 * Numeric segments index into a list, and every step checks the shape it is in rather than assuming it: a
 * vendor that moved a field, renamed it, or answered with a string where a number belongs is told apart from
 * a vendor that answered at all, and the caller reports the first as unreadable rather than as zero.
 */
export function pickPath(payload: unknown, path: string): unknown {
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null
      current = current[index]
      continue
    }
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment]
  }
  return current ?? null
}

function moneyOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // Several of these endpoints answer a number as a JSON string, and one answers "0.00". A value that is not
  // a plain decimal is not money, and is not rounded into being money either.
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null
    return Number(text)
  }
  return null
}

/**
 * The balance inside a vendor's answer, in the currency it is denominated in.
 *
 * Null means the answer arrived and did not say: no listed field held a number, or the credits subtraction
 * found only one of its two terms. That is reported as `unreadable`, which is the honest sentence — the key
 * was accepted, and this endpoint is not the one that answers the question.
 */
export function balanceFromPayload(spec: BalanceSpec, payload: unknown): BalanceAmount | null {
  let amount: number | null = null
  for (const path of spec.amountPaths) {
    const found = moneyOf(pickPath(payload, path))
    if (found !== null) {
      amount = found
      break
    }
  }
  if (amount === null) return null
  if (spec.minusPath) {
    const spent = moneyOf(pickPath(payload, spec.minusPath))
    if (spent === null) return null
    amount -= spent
  }
  if (spec.divisor) amount /= spec.divisor
  if (!Number.isFinite(amount)) return null
  const named = spec.currencyPath ? pickPath(payload, spec.currencyPath) : null
  const currency = typeof named === 'string' && /^[A-Z]{3}$/i.test(named.trim()) ? named.trim().toUpperCase() : spec.defaultCurrency
  return { amount: Math.round(amount * 1_000) / 1_000, currency }
}
