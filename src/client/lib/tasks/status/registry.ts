import { Status, type StatusConfiguration, type StatusType } from './status'

/**
 * The statuses a vault recognises, and how one leads to the next.
 *
 * A checkbox character has no meaning on its own: `[-]` is "cancelled" only because something says
 * so. This registry is that something, and it is built from the reader's settings on every read so
 * no two callers can disagree about what a note says.
 */
export class StatusRegistry {
  private readonly statuses = new Map<string, Status>()

  constructor(configurations: StatusConfiguration[] = DEFAULT_STATUS_CONFIGURATIONS) {
    for (const configuration of configurations) {
      this.register(configuration)
    }
  }

  get registeredStatuses(): Status[] {
    return [...this.statuses.values()]
  }

  register(configuration: StatusConfiguration): Status {
    const status = new Status(configuration)
    this.statuses.set(configuration.symbol, status)
    return status
  }

  clear(): void {
    this.statuses.clear()
  }

  bySymbol(symbol: string): Status | null {
    return this.statuses.get(symbol) ?? null
  }

  /** Never fails: an unregistered character still gets a type, so old notes keep reading. */
  bySymbolOrCreate(symbol: string): Status {
    return this.statuses.get(symbol) ?? Status.createUnknown(symbol)
  }

  byName(name: string): Status | null {
    return this.registeredStatuses.find((status) => status.name === name) ?? null
  }

  getNextStatus(status: Status): Status | null {
    if (status.nextStatusSymbol === '') return null
    return this.bySymbol(status.nextStatusSymbol)
  }

  getNextStatusOrCreate(status: Status): Status {
    const next = this.getNextStatus(status)
    return next ?? this.bySymbolOrCreate(status.nextStatusSymbol)
  }

  /**
   * The status a recurring task should be born with once its current instance is finished.
   *
   * Following `nextStatusSymbol` blindly can land the new copy on another done-like character, and
   * the task would then vanish from every `not done` search the moment it was completed. Walking the
   * chain to the first open status is what keeps a recurring task visible; the bounded walk is what
   * keeps a mis-linked chain from looping forever, and the space is what keeps a vault with no open
   * status at all from losing its tasks entirely.
   */
  getNextRecurrenceStatusOrCreate(status: Status): Status {
    const next = this.getNextStatusOrCreate(status)
    return this.walkChainToType(next, 'TODO')
      ?? this.walkChainToType(next, 'IN_PROGRESS')
      ?? this.bySymbolOrCreate(' ')
  }

  private walkChainToType(start: Status, wanted: StatusType): Status | null {
    if (start.type === wanted) return start
    let current = start
    for (let step = 0; step < this.statuses.size - 1; step++) {
      current = this.getNextStatusOrCreate(current)
      if (current.type === wanted) return current
    }
    return null
  }

  /** Characters a note uses that the reader never defined, so the settings screen can offer them. */
  findUnknownStatuses(symbols: string[]): Status[] {
    const missing = new Set<string>()
    for (const symbol of symbols) {
      if (!this.statuses.has(symbol)) missing.add(symbol)
    }
    return [...missing].map((symbol) => Status.createUnknown(symbol))
  }
}

/**
 * The four statuses a fresh install answers with.
 *
 * `On Hold` and `Non-Task` exist as types but are deliberately not registered: a reader who never
 * asked for `[h]` should not have it change how their vault groups tasks.
 */
export const DEFAULT_STATUS_CONFIGURATIONS: StatusConfiguration[] = [
  Status.TODO.configuration,
  Status.IN_PROGRESS.configuration,
  Status.DONE.configuration,
  Status.CANCELLED.configuration,
]

export interface StatusValidationFailure {
  symbol: string
  reason: 'duplicate-symbol' | 'missing-next' | 'bad-symbol' | 'empty-name'
}

/**
 * Reject a status table that would make toggling unsafe before it is ever saved.
 *
 * A dangling `nextStatusSymbol` is the damaging one: the reader would click a checkbox and watch the
 * character change to something no longer in the list, with no way back except editing the note.
 */
export function validateStatusConfigurations(
  configurations: StatusConfiguration[],
): StatusValidationFailure[] {
  const failures: StatusValidationFailure[] = []
  const seen = new Set<string>()
  const symbols = new Set(configurations.map((configuration) => configuration.symbol))
  for (const configuration of configurations) {
    if (seen.has(configuration.symbol)) {
      failures.push({ symbol: configuration.symbol, reason: 'duplicate-symbol' })
      continue
    }
    seen.add(configuration.symbol)
    if (configuration.symbol.length > 1 || configuration.symbol === '') {
      failures.push({ symbol: configuration.symbol, reason: 'bad-symbol' })
    }
    if (configuration.name.trim() === '') {
      failures.push({ symbol: configuration.symbol, reason: 'empty-name' })
    }
    if (configuration.nextStatusSymbol !== '' && !symbols.has(configuration.nextStatusSymbol)) {
      failures.push({ symbol: configuration.symbol, reason: 'missing-next' })
    }
  }
  return failures
}
