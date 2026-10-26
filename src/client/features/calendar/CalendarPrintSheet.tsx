/**
 * The paper the print dialogue gets.
 *
 * Rendered into `document.body` and hidden on screen, so the app's own layout never has to be fought
 * with: the print rules hide every other body child and show this one. The sheet is built from a range
 * read rather than from what is on screen, so printing from the year view still lists the appointments
 * the reader has, in the calendars they have visible.
 */
import { createPortal } from 'react-dom'
import type { PrintSheet } from './print'

export function CalendarPrintSheet({ sheet }: { sheet: PrintSheet | null }) {
  if (!sheet) return null
  return createPortal(
    <div className="calendar-print-sheet">
      <header>
        <h1>{sheet.title}</h1>
        {sheet.subtitle && <p>{sheet.subtitle}</p>}
      </header>
      {sheet.days.length === 0 && <p className="calendar-print-empty">{sheet.emptyLabel}</p>}
      {sheet.days.map((day) => (
        <section key={day.key}>
          <h2>{day.label}</h2>
          <ul>
            {day.items.map((item) => (
              <li key={item.key}>
                <span className="calendar-print-time">{item.time}</span>
                <span className="calendar-print-title">{item.title}</span>
                <span className="calendar-print-meta">
                  <span className="calendar-print-dot" style={{ background: item.color }} aria-hidden="true" />
                  {item.calendarName}
                  {item.location ? ` · ${item.location}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>,
    document.body,
  )
}
