/**
 * The diary's two AI entries: what happened today, and what tomorrow looks like.
 *
 * The diary is the one note a reader keeps opening without knowing what to write in it, which makes it
 * the place a summary belongs. Both entries run one turn and write the answer into today's diary under
 * a heading of its own — the reader's own words stay where they are, and pressing again replaces that
 * section rather than stacking a second copy of it.
 *
 * The day's notes are named in the prompt instead of being handed over whole: the assistant has note
 * tools, and a summary of forty notes is not a summary that fits in a prompt. What the reader gets is
 * the assistant's own reading of what they wrote.
 */
import { t } from '../../lib/i18n'
import { dateKey } from '../../lib/time'
import { buildActivityProjectionCached } from '../../lib/calendar-activity'
import { useUi } from '../../store/ui'
import { useNotes } from '../../store/notes'
import { askAboutNote } from '../chat/note-ai'
import { createDiaryNote, diaryTitlesFor } from './diary-note'

/** How many of the day's notes are worth naming. Past this it is a reading list, not a prompt. */
const DAY_NOTES_MAX = 40

/** The note a day's diary lives in, by the titles it may have been written under. */
export function findDiary(key: string): string | null {
  const titles = new Set(diaryTitlesFor(key))
  for (const note of Object.values(useNotes.getState().notes)) {
    if (!note.deletedAt && titles.has(note.title)) return note.id
  }
  return null
}

/** Today's diary, created and opened when there is none yet. */
async function ensureDiary(key: string): Promise<string | null> {
  const existing = findDiary(key)
  if (existing) {
    await useNotes.getState().openNote(existing)
    return existing
  }
  return createDiaryNote(key)
}

/** The titles of what the reader wrote or touched that day, newest first, without the diary itself. */
function dayNoteTitles(key: string, diaryId: string | null): string[] {
  const projection = buildActivityProjectionCached(useNotes.getState().notes)
  const entries = projection.notesByDay.get(key) ?? []
  return entries
    .filter((entry) => entry.id !== diaryId)
    .slice(0, DAY_NOTES_MAX)
    .map((entry) => `[[${entry.title}]]`)
}

/**
 * Put a section into a note, replacing the one that is already there.
 *
 * A summary of the same day replaces the previous summary of it: two of them side by side would leave
 * the reader deciding which one is true. The section runs from its heading to the next heading of the
 * same or a higher level, which is what keeps a reader's own `###` inside the section intact.
 */
export function upsertSection(content: string, heading: string, body: string): string {
  const lines = content.split('\n')
  const level = heading.match(/^#+/)?.[0].length ?? 1
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) {
    const lead = content === '' || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
    return `${content}${lead}${heading}\n\n${body}\n`
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const next = /^(#{1,6})\s/.exec(lines[index]!)
    if (next && next[1]!.length <= level) {
      end = index
      break
    }
  }
  const tail = lines.slice(end)
  const joined = [...lines.slice(0, start), heading, '', body, ...(tail.length ? ['', ...tail] : [])].join('\n')
  // The note's own trailing newline is not the section's to remove.
  return content.endsWith('\n') && !joined.endsWith('\n') ? `${joined}\n` : joined
}

/**
 * One turn, written into today's diary.
 *
 * `key` is the day the entry is about, which is also the diary it is written into — the calendar's
 * "today" is a date, not a timestamp, so the two cannot drift apart.
 */
async function writeDiarySection(key: string, heading: string, prompt: string): Promise<boolean> {
  const toast = useUi.getState().toast
  const id = await ensureDiary(key)
  if (!id) {
    toast({ title: t('sidebar.diary_ai.no_diary'), tone: 'danger' })
    return false
  }
  const answer = await askAboutNote(id, prompt)
  // Three states, three sentences: an answer still being written is worth waiting for, a run that failed
  // is worth reading the reason of, and a turn that answered with nothing is what this entry's own
  // message is for. Saying "nothing came back" for all three is how a busy assistant became a mystery.
  if (answer.status === 'busy') {
    toast({ title: t('assistant.edit.busy'), tone: 'warning' })
    return false
  }
  if (answer.status === 'failed') {
    toast({ title: t('assistant.note.answer_failed'), description: answer.error ?? undefined, tone: 'danger' })
    return false
  }
  if (answer.status === 'empty') {
    toast({ title: t('sidebar.diary_ai.empty'), tone: 'warning' })
    return false
  }
  const content = useNotes.getState().contents[id]
  if (content === undefined) {
    toast({ title: t('sidebar.diary_ai.no_diary'), tone: 'danger' })
    return false
  }
  useNotes.getState().editContent(id, upsertSection(content, heading, answer.text))
  toast({ title: t('sidebar.diary_ai.saved'), tone: 'success' })
  return true
}

/** What today looked like: the assistant reads the day's notes and writes a handful of bullets. */
export async function summarizeToday(): Promise<boolean> {
  const key = dateKey(new Date())
  const titles = dayNoteTitles(key, findDiary(key))
  return writeDiarySection(
    key,
    t('sidebar.diary_ai.summary_heading'),
    t('sidebar.diary_ai.summary_prompt', {
      date: key,
      notes: titles.length ? titles.join(', ') : t('sidebar.diary_ai.no_notes'),
    }),
  )
}

/** Tomorrow, planned from today's diary and the notes it points at. */
export async function planTomorrow(): Promise<boolean> {
  const key = dateKey(new Date())
  const tomorrow = dateKey(new Date(Date.now() + 86_400_000))
  const titles = dayNoteTitles(key, findDiary(key))
  return writeDiarySection(
    key,
    t('sidebar.diary_ai.plan_heading'),
    t('sidebar.diary_ai.plan_prompt', {
      date: key,
      tomorrow,
      notes: titles.length ? titles.join(', ') : t('sidebar.diary_ai.no_notes'),
    }),
  )
}
