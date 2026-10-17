import { localizedParams, t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

/** The title a day's diary is written under, in the interface's current language. */
export function diaryTitleFor(key: string): string {
  return t('sidebar.diary_title_value0', { value0: key })
}

export function buildDiaryContent(key: string, title: string, tag: string): string {
  // The day the diary is *about*, not the minute it happened to be filed: a random time of day
  // claimed a moment that never existed and contradicted the row's real created_at.
  const stamp = `${key} 00:00:00`
  // JSON's string form is a legal YAML double-quoted scalar, so a title or tag holding a
  // quote, a colon or a newline stays one scalar instead of rewriting the document.
  return `---
title: ${JSON.stringify(title)}
createdAt: ${stamp}
tags:
  - ${JSON.stringify(tag)}
aliases:
  - ''
---

`
}

/**
 * Make the diary for one day and open it.
 *
 * The id comes back because a caller may have more to do with the note than look at it — the diary's
 * AI entries write into the one they just made. A day already has a diary in another language? Then
 * this is a new one: the caller that cares about that is the calendar, which looks the day up first.
 */
export async function createDiaryNote(key: string): Promise<string | null> {
  const title = diaryTitleFor(key)
  const content = buildDiaryContent(key, title, t('sidebar.diary_tag'))
  const id = await useNotes.getState().createNote({ title, content, open: true })
  if (id)
    useUi.getState().toast({ title: t('sidebar.calendar_diary_created_value0', { value0: key }), tone: 'success' })
  return id
}

/** The diary titles a day may already have been written under, current language first. */
export function diaryTitlesFor(key: string): string[] {
  return [...new Set(localizedParams('sidebar.diary_title_value0', { value0: key }))]
}
