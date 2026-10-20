/**
 * What a status character means to the task layer.
 *
 * `DONE` and `CANCELLED` end a task, `TODO` and `IN_PROGRESS` keep it open, and the distinction is
 * what makes `not done` answer correctly for a vault that ticks tasks with `/` rather than `x`.
 */
export type StatusType =
  | 'TODO'
  | 'DONE'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'CANCELLED'
  | 'NON_TASK'
  | 'EMPTY'

/**
 * A registered status, as it is persisted in settings.
 *
 * `name` is data rather than chrome: readers filter on `status.name includes Done`, so translating
 * it would break their queries. The settings screen shows a translated label beside it.
 */
export interface StatusConfiguration {
  /** The character between the square brackets. */
  symbol: string
  name: string
  /** The character to write when the task moves on from this status. */
  nextStatusSymbol: string
  /** Whether the reader may bind a command to it. */
  availableAsCommand: boolean
  type: StatusType
}

export class Status {
  readonly configuration: StatusConfiguration

  constructor(configuration: StatusConfiguration) {
    this.configuration = configuration
  }

  get symbol(): string {
    return this.configuration.symbol
  }

  get name(): string {
    return this.configuration.name
  }

  get nextStatusSymbol(): string {
    return this.configuration.nextStatusSymbol
  }

  get availableAsCommand(): boolean {
    return this.configuration.availableAsCommand
  }

  get type(): StatusType {
    return this.configuration.type
  }

  /**
   * Whether a query counts this status as finished.
   *
   * Cancelled and non-task are included, not just `DONE`: the reference plugin's `done` / `not done`
   * answer with this same set, so `not done` is the list of things still to act on rather than the
   * complement of a ticked box. A reader who wants cancelled tasks back in a list asks for that by
   * name (`status.type is not CANCELLED`), which is also what the `cancelled` date is for.
   */
  get isDone(): boolean {
    return this.type === 'DONE' || this.type === 'CANCELLED' || this.type === 'NON_TASK'
  }

  /**
   * Whether the box carries a mark, which is the question a checkbox answers rather than the one a
   * query does: `[/]` and `[-]` are both visibly ticked, and only an empty box is not.
   */
  get isTicked(): boolean {
    return this.symbol !== ' '
  }

  /**
   * A group heading that sorts in a meaningful order.
   *
   * The `%%n%%` prefix orders the groups and is stripped again by the renderer; without it,
   * `CANCELLED` would lead the list purely because of its spelling.
   */
  get typeGroupText(): string {
    const prefixes: Record<StatusType, string> = {
      IN_PROGRESS: '1',
      TODO: '2',
      ON_HOLD: '3',
      DONE: '4',
      CANCELLED: '5',
      NON_TASK: '6',
      EMPTY: '7',
    }
    return `%%${prefixes[this.type]}%%${this.type}`
  }

  /** How this status reads in a checkbox the reader is looking at. */
  get previewText(): string {
    if (this.symbol === Status.EMPTY.symbol) return 'ERROR: Empty status character'
    if (this.symbol.length > 1) return `ERROR: More than one character in "${this.symbol}"`
    return `[${this.symbol}] ${this.name}`
  }

  static readonly TODO = new Status({ symbol: ' ', name: 'Todo', nextStatusSymbol: 'x', availableAsCommand: true, type: 'TODO' })
  static readonly DONE = new Status({ symbol: 'x', name: 'Done', nextStatusSymbol: ' ', availableAsCommand: true, type: 'DONE' })
  static readonly IN_PROGRESS = new Status({ symbol: '/', name: 'In Progress', nextStatusSymbol: 'x', availableAsCommand: true, type: 'IN_PROGRESS' })
  static readonly CANCELLED = new Status({ symbol: '-', name: 'Cancelled', nextStatusSymbol: ' ', availableAsCommand: true, type: 'CANCELLED' })
  static readonly ON_HOLD = new Status({ symbol: 'h', name: 'On Hold', nextStatusSymbol: ' ', availableAsCommand: true, type: 'ON_HOLD' })
  static readonly NON_TASK = new Status({ symbol: 'Q', name: 'Non-Task', nextStatusSymbol: 'A', availableAsCommand: true, type: 'NON_TASK' })
  static readonly EMPTY = new Status({ symbol: '', name: 'EMPTY', nextStatusSymbol: '', availableAsCommand: true, type: 'EMPTY' })

  /** The type a symbol carries when the reader never registered it, so old notes still read. */
  static typeForUnknownSymbol(symbol: string): StatusType {
    switch (symbol) {
      case 'x':
      case 'X':
        return 'DONE'
      case '/':
        return 'IN_PROGRESS'
      case '-':
        return 'CANCELLED'
      case '':
        return 'EMPTY'
      default:
        return 'TODO'
    }
  }

  static createUnknown(symbol: string): Status {
    return new Status({
      symbol,
      name: `UNKNOWN (${symbol})`,
      nextStatusSymbol: '',
      availableAsCommand: false,
      type: Status.typeForUnknownSymbol(symbol),
    })
  }
}
