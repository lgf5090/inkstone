import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

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

export async function createDiaryNote(key: string, diaryTitle: (value: string) => string): Promise<void> {
  const title = diaryTitle(key)
  const content = buildDiaryContent(key, title, t('sidebar.diary_tag'))
  const id = await useNotes.getState().createNote({ title, content, open: true })
  if (id)
    useUi.getState().toast({ title: t('sidebar.calendar_diary_created_value0', { value0: key }), tone: 'success' })
}
