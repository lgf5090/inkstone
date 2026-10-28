/** Recording timelines: the stroke deltas a page saw, and how a replay puts them back. */
import type { InknotePageContent, InknoteStroke } from '@shared/inknote/types'

export type InknoteTimelineEvent =
  | { t: number; type: 'stroke'; pageId: string; data: InknoteStroke }
  | { t: number; type: 'erase'; pageId: string; data: { ids: string[] } }
  | { t: number; type: 'page'; pageId: string; data: { to: number } }

function parse(value: string): InknotePageContent | null {
  try {
    const content = JSON.parse(value) as InknotePageContent
    return content && Array.isArray(content.strokes) ? content : null
  } catch {
    return null
  }
}

/**
 * What one committed page edit changed about its ink.
 *
 * Text and images are deliberately absent: the recorder replays strokes, and a text box the reader
 * typed during a recording is already in the page a replay starts from.
 */
export function strokeEventsForCommit(before: string, after: string, pageId: string, at: number): InknoteTimelineEvent[] {
  const first = parse(before)
  const second = parse(after)
  if (!first || !second) return []
  const beforeIds = new Set(first.strokes.map((stroke) => stroke.id))
  const afterIds = new Set(second.strokes.map((stroke) => stroke.id))
  const events: InknoteTimelineEvent[] = []
  const removed = first.strokes.filter((stroke) => !afterIds.has(stroke.id)).map((stroke) => stroke.id)
  if (removed.length) events.push({ t: at, type: 'erase', pageId, data: { ids: removed } })
  for (const stroke of second.strokes) {
    if (!beforeIds.has(stroke.id)) events.push({ t: at, type: 'stroke', pageId, data: stroke })
  }
  return events
}

/** Apply one event to a page copy; a page event changes nothing in the page itself. */
export function applyTimelineEvent(content: InknotePageContent, event: InknoteTimelineEvent): InknotePageContent {
  if (event.type === 'page') return content
  if (event.type === 'stroke') {
    if (content.strokes.some((stroke) => stroke.id === event.data.id)) return content
    return { ...content, strokes: [...content.strokes, event.data] }
  }
  const doomed = new Set(event.data.ids)
  if (!content.strokes.some((stroke) => doomed.has(stroke.id))) return content
  return { ...content, strokes: content.strokes.filter((stroke) => !doomed.has(stroke.id)) }
}

/** Deep copy of the pages a replay will touch, so the recording cannot leave its ink behind. */
export function snapshotReplayPages(pages: readonly { id: string; content: InknotePageContent }[]): Map<string, InknotePageContent> {
  return new Map(pages.map((page) => [page.id, JSON.parse(JSON.stringify(page.content)) as InknotePageContent]))
}

/** Timeline events in recorded order, capped to the byte budget the server accepts. */
export function trimTimeline(events: readonly InknoteTimelineEvent[], maxBytes: number): InknoteTimelineEvent[] {
  const out: InknoteTimelineEvent[] = []
  let bytes = 2
  for (const event of events) {
    const size = JSON.stringify(event).length * 2
    if (bytes + size > maxBytes) break
    bytes += size
    out.push(event)
  }
  return out
}
