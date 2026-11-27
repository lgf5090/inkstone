import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const surface = readFileSync(resolve(process.cwd(), 'src/client/features/calendar/CalendarSurface.tsx'), 'utf8')

describe('calendar surface responsibility boundary', () => {
  it('composes range, event persistence and registry hooks', () => {
    expect(surface).toContain('useCalendarRangeSync({')
    expect(surface).toContain('useCalendarPersistence({')
    expect(surface).toContain('useCalendarRegistry({')
  })

  it('does not assemble range caching, revision probes or the offline write queue inline', () => {
    expect(surface).not.toContain("from './range-cache'")
    expect(surface).not.toContain("from './offline-outbox'")
    expect(surface).not.toContain('new EventPersistence(')
    expect(surface).not.toContain('flushOutbox(')
    expect(surface).not.toContain('enqueueOutbox(')
    expect(surface).not.toContain('api.getEventsRevision(')
    expect(surface).not.toContain('planEventSnapshot(')
  })
})
