/**
 * The reminder tiers, in one place.
 *
 * This lives in a module with no imports at all, which is the only reason `shared/constants.ts` can read
 * it: the settings merge validates `todo.defaultRemind` here, and `todos/model.ts` reaches
 * `organizer-colors`, which reaches `constants` — so importing the tiers from the model would have made
 * the cycle, and a cycle at module scope is a value that is undefined during the first import rather
 * than an error anyone sees.
 *
 * The tiers were spelled in four places before this file existed: the enum, the arithmetic that turns
 * one into an instant, the client's copy of that arithmetic, and the settings validator's own list. Each
 * new tier had to be remembered in all four, and the two that matter fail quietly — a validator that
 * does not know a tier folds it to null, so the reader's saved default simply stops being applied, and a
 * distance the arithmetic does not know becomes no reminder at all.
 *
 * So there is one list (`REMIND_OFFSETS`), one total map from each tier to the distance it means
 * (`REMIND_OFFSET_MS`, which the compiler forces every new tier to price), and the two readings that
 * go with them. A form or a tool door builds its choices from the list, so nothing has to be edited
 * twice.
 */

/** How far before the due instant a reminder may be set. A preset is a form shortcut, not a stored unit. */
export const REMIND_OFFSETS = ['none', 'due', '5m', '10m', '15m', '30m', '1h', '1d', '3d', '1w'] as const
export type RemindOffset = (typeof REMIND_OFFSETS)[number]

/** A tier the reader can be asked to pick, and the only ones that have a distance: `none` has none. */
export type RemindTier = Exclude<RemindOffset, 'none'>

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How far before the due instant each tier fires, in milliseconds.
 *
 * `due` is zero rather than absent: "at the time it is owed" is a distance, and treating it as one is
 * what lets `remindAtFor` have a single expression instead of a branch per tier.
 *
 * Total over `RemindTier` on purpose. Adding a tier to `REMIND_OFFSETS` without pricing it here is a
 * compile error rather than a reminder that silently never fires.
 */
export const REMIND_OFFSET_MS: Record<RemindTier, number> = {
  due: 0,
  '5m': 5 * MINUTE,
  '10m': 10 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': HOUR,
  '1d': DAY,
  '3d': 3 * DAY,
  '1w': 7 * DAY,
}

/** Whether a value is one of the tiers a form may send. `none` is a valid answer and still included. */
export function isRemindOffset(value: unknown): value is RemindOffset {
  return typeof value === 'string' && (REMIND_OFFSETS as readonly string[]).includes(value)
}

/**
 * The instant a tier fires at, for a task owed at `dueAt`.
 *
 * Null means "no reminder", which is what `none` says and what a task with no due time cannot answer:
 * a reminder measured from nothing is not a reminder.
 *
 * The answer is stored as an instant rather than as the tier, because the sweep has to decide "is it due"
 * without knowing which preset the reader chose, and because a reminder set for "1 day before" must not
 * slide along when the due date is later edited by hand.
 */
export function remindAtFor(dueAt: number | null, offset: RemindOffset): number | null {
  if (dueAt === null || offset === 'none') return null
  return dueAt - REMIND_OFFSET_MS[offset]
}

/**
 * The tier a stored distance stands for, or `none` for a distance no preset names.
 *
 * A reminder is stored as an absolute instant, so this is the inverse reading the forms need to open on
 * the row's own value. A distance that is not a tier is not rounded to the nearest one: an offset the
 * reader set by hand at 45 minutes is shown as "no preset", because claiming it said "1 hour" would be
 * the form answering for the reader.
 */
export function remindOffsetForDelta(msBeforeDue: number): RemindOffset {
  if (msBeforeDue <= 0) return 'due'
  for (const tier of REMIND_OFFSETS) {
    if (tier === 'none') continue
    if (REMIND_OFFSET_MS[tier] === msBeforeDue) return tier
  }
  return 'none'
}
