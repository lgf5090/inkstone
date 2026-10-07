import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'

export function buildDiaryContent(key: string, title: string, tag: string): string {
  const [year, month, day] = key.split('-').map(Number)
  const time = new Date(year, month - 1, day)
  time.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0)
  const stamp = `${key} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`
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
