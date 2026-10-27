/**
 * Which hot comment to show through a quiet stretch of a song.
 *
 * Pure timing over the parsed lyric lines: `quietsFor` finds the stretches where nobody sings, and
 * `quietCommentAt` walks them as the playhead moves, giving each of the eligible hot comments a slot.
 * A quiet that is too short for a comment shows nothing; a long one rotates through the comments
 * about every ten seconds; a song with no lyric counts as one quiet stretch from start to end.
 *
 * The credit-line predicate is local to this slice for now. The lyric slice will publish the same
 * check from `shared/music/lyrics.ts`; porting it here with escaped names keeps the two from
 * disagreeing while that module does not have the export yet.
 */
import type { MusicComment } from '@shared/music/comments'
import { isCreditLine, lyricQuiets, type LyricLine } from '@shared/music/lyrics'

/** The shortest stretch that shows a comment at all. */
export const QUIET_MIN_MS = 8000
/** How far into the quiet the card arrives, so it never covers the last sung line. */
export const QUIET_LEAD_MS = 1200
/** How long before the singing returns the card leaves. */
export const QUIET_TAIL_MS = 1000
/** About how long one comment holds a long quiet. */
export const QUIET_SLOT_MS = 10_000
/** Comments longer than this are left for the pane. */
export const QUIET_MAX_RUNES = 140

export interface QuietRange {
  from: number
  to: number
}

export interface QuietOptions {
  minMs?: number
  /** False while the lyric request is still in flight, so "no lines yet" is not read as "no lyrics". */
  loaded?: boolean
}

export interface QuietCommentOptions {
  leadMs?: number
  tailMs?: number
  slotMs?: number
  maxRunes?: number
}

export interface QuietCommentState {
  comment: MusicComment | null
  /** Milliseconds until the shown comment changes, or null when it will not change again. */
  nextChangeMs: number | null
}

export { isCreditLine }

/**
 * The stretches of a track in which no lyric line is sung.
 *
 * Credits are skipped rather than treated as sung, so an opening credit block counts as quiet. A
 * track whose lyrics are known to be empty is one quiet stretch from start to end; a track still
 * loading its lyrics is not, because its silence is not a property of the song.
 */
export function quietsFor(
  lines: readonly LyricLine[],
  trackDurationMs: number,
  options: QuietOptions = {},
): QuietRange[] {
  const minMs = options.minMs ?? QUIET_MIN_MS
  const loaded = options.loaded ?? true
  if (!loaded && lines.length === 0) return []
  return lyricQuiets(lines, trackDurationMs, minMs)
}

/**
 * The comment to show at `positionMs`, and how long until that answer changes.
 *
 * Each quiet is trimmed by the lead and tail, then cut into roughly equal slots of about ten
 * seconds; consecutive quiets continue the rotation rather than starting over. `nextChangeMs` is
 * null once the track has no further quiet, which lets a caller schedule nothing at all.
 */
export function quietCommentAt(
  quiets: readonly QuietRange[],
  hotComments: readonly MusicComment[],
  positionMs: number,
  options: QuietCommentOptions = {},
): QuietCommentState {
  const lead = options.leadMs ?? QUIET_LEAD_MS
  const tail = options.tailMs ?? QUIET_TAIL_MS
  const slotMs = options.slotMs ?? QUIET_SLOT_MS
  const maxRunes = options.maxRunes ?? QUIET_MAX_RUNES

  const eligible = hotComments.filter((comment) => {
    const runes = [...comment.content].length
    return runes > 0 && runes <= maxRunes
  })
  if (eligible.length === 0) return { comment: null, nextChangeMs: null }

  let shown = 0
  for (const quiet of quiets) {
    const from = quiet.from + lead
    const to = quiet.to - tail
    if (to <= from) continue
    if (positionMs < from) {
      return { comment: null, nextChangeMs: from - positionMs }
    }
    const span = to - from
    const slots = Math.max(1, Math.round(span / slotMs))
    const each = Math.floor(span / slots)
    if (positionMs < to) {
      const slot = Math.min(Math.floor((positionMs - from) / each), slots - 1)
      const next = slot + 1 < slots ? from + (slot + 1) * each : to
      return {
        comment: eligible[(shown + slot) % eligible.length] ?? null,
        nextChangeMs: next - positionMs,
      }
    }
    shown += slots
  }
  return { comment: null, nextChangeMs: null }
}
