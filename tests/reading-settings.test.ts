// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_READER_SETTINGS, useReaderSettings } from '../src/client/features/reading/store/reader-settings'
import type { ReaderSettings } from '../src/client/features/reading/store/reader-settings'

type Key = keyof typeof DEFAULT_READER_SETTINGS

/** One legal value per setting, none of them the default, so a dropped write is visible. */
const CHANGED: ReaderSettings = {
  theme: 'night', fontSize: 22, lineHeight: 2, letterSpacing: 0.1, paragraphSpacing: 1.5,
  fontFamily: 'sans', customFamily: 'Noto Serif',
  importedFonts: [{ id: 'f1', family: 'Inkstone Test', label: 'test.ttf', bytes: 2048 }],
  columns: 2, margin: 40, textAlign: 'justify', hyphenate: true, firstLineIndent: false,
  readMode: 'scroll', pageTurnAnimation: false, showFigures: false, immersive: false,
  pageButtons: 'hover', defaultHighlightColor: 'blue', selectionLabels: true, timerEnabled: false,
  dailyGoalMinutes: 30, translateEnabled: true, translateTo: 'en', translateEngine: 'ai',
  tapZones: 'edges', swipeTurns: false, showScrubber: false, estimateTimeLeft: false,
  dimming: 0.4, autoScrollSpeed: 60, autoBookNote: false, quoteBacklinks: false, notesFolder: 'Reading',
}

/**
 * What a setting is for: it is still there after a reload.
 *
 * The store sanitises through an explicit rule per non-flag key, which is where a new key silently
 * stops persisting — the panel shows the switch, the switch works, and the page forgets it on reload.
 */
describe('reader settings persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('names every setting, so a new one cannot go untested', () => {
    expect(Object.keys(CHANGED).sort()).toEqual(Object.keys(DEFAULT_READER_SETTINGS).sort())
    const changed: Record<string, unknown> = CHANGED
    for (const key of Object.keys(CHANGED)) {
      expect(changed[key], `${key} must differ from its default to prove the round trip`).not.toEqual(DEFAULT_READER_SETTINGS[key as Key])
    }
  })

  it('keeps every setting across a reload', async () => {
    useReaderSettings.getState().patch(CHANGED)
    const { useReaderSettings: reloaded } = await import('../src/client/features/reading/store/reader-settings')
    const changed: Record<string, unknown> = CHANGED
    for (const key of Object.keys(CHANGED)) {
      expect((reloaded.getState() as Record<string, unknown>)[key], key).toEqual(changed[key])
    }
  })

  const repairs: [string, Key, unknown][] = [
    ['{"fontSize":"big"}', 'fontSize', 19],
    ['{"margin":-500}', 'margin', 0],
    ['{"fontSize":9999}', 'fontSize', 34],
    ['{"theme":"<script>"}', 'theme', 'auto'],
    ['{"columns":7}', 'columns', 1],
    ['{"readMode":"teleport"}', 'readMode', 'paged'],
    ['{"hyphenate":"yes"}', 'hyphenate', false],
    ['{"pageTurnAnimation":1}', 'pageTurnAnimation', true],
    ['{"importedFonts":[{"family":{}}]}', 'importedFonts', []],
    ['{"notesFolder":{"toString":1}}', 'notesFolder', ''],
  ]
  for (const [raw, key, fallback] of repairs) {
    it(`repairs a hand-edited record: ${raw}`, async () => {
      localStorage.setItem(storageKey(), raw)
      vi.resetModules()
      const { useReaderSettings: reloaded } = await import('../src/client/features/reading/store/reader-settings')
      expect(reloaded.getState()[key]).toEqual(fallback)
    })
  }
})

/** The store picks its own key by mode, so the test reads it back from the write path instead of guessing. */
function storageKey(): string {
  useReaderSettings.getState().patch({ fontSize: 21 })
  const key = Object.keys(localStorage).find((one) => one.endsWith('reader.settings'))
  if (!key) throw new Error('the settings store wrote nothing to localStorage')
  return key
}
