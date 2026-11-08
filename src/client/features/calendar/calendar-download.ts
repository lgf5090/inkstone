/**
 * Turn a calendar export into the file the browser saves.
 *
 * ICS and CSV are both plain text documents the route already built; the only job here is the
 * anchor download, so the same name sanitiser and object-URL lifetime cover both.
 */
export function downloadCalendarText(name: string, content: string, extension: 'ics' | 'csv'): void {
  const cleaned = name.replaceAll(/[\\/?%*:|"<>\u0000-\u001f]/g, '_').trim().slice(0, 120)
  const blob = new Blob([content], {
    type: extension === 'ics' ? 'text/calendar;charset=utf-8' : 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${cleaned || 'calendar'}.${extension}`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
