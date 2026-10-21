/**
 * The one place that decides to run the reader's startup templates.
 *
 * Three things have to be true before a template nobody pressed runs: this device said yes
 * (`enableStartupTemplates` is a device switch, so a phone's answer never executes templates on a desktop),
 * the account has finished loading, and the library it reads has too. Anything less and a startup template
 * would run against a half-loaded notebook — the classic way to write a daily note into an empty vault
 * before the vault arrived.
 *
 * The batch policy itself is `host/startup.ts`; this file is only the moment and the words. The interpreter
 * stays off the first screen because the run it delegates to (`run-shell.ts`) reaches the door with a
 * dynamic import of its own — a reader who never turns this on never loads the engine.
 */
import { useEffect, useRef } from 'react'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { useTemplaterDevicePrefs } from '../../lib/templater/device-prefs'
import { runStartupTemplates } from '../../lib/templater/host/startup'
import { t } from '../../lib/i18n'
import { templaterErrorText } from '../../lib/templater/errors'
import { runStartupTemplate } from './run-shell'

/**
 * Which account has already been given its batch this session.
 *
 * React runs effects twice in development, and a startup template that appends to a note would append twice.
 * Keyed by user rather than a plain boolean so signing out and back in inside one page load is still one
 * batch per account, and a second account on this device gets its own.
 */
let attemptedFor: string | null = null

/** Forget the record — for a test, or for a reader who turns the switch on and wants the answer re-asked. */
export function resetTemplaterStartupAttempt(): void {
  attemptedFor = null
}

export function useTemplaterStartup(): void {
  const status = useSession((state) => state.status)
  const userId = useSession((state) => state.user?.id ?? null)
  const startupIds = useSession((state) => state.settings.templater.startupTemplates)
  const notesHydrated = useNotes((state) => state.hydrated)
  const libraryHydrated = useNoteTemplates((state) => state.hydrated)
  const devicePrefs = useTemplaterDevicePrefs(userId)
  // The list is read when the batch starts, not when the effect is created: a settings sync landing mid-batch
  // must not change which templates run after the first one already did.
  const idsRef = useRef<string[]>([])
  idsRef.current = startupIds

  useEffect(() => {
    if (!devicePrefs.enableStartupTemplates) return
    if (status !== 'authed' || userId === null || !notesHydrated || !libraryHydrated) return
    if (attemptedFor === userId) return
    attemptedFor = userId
    const ids = idsRef.current
    if (ids.length === 0) return
    // A batch that cannot even start is reported, not swallowed: everything below it reaches the data layer,
    // and a failure there would otherwise leave the reader with a switch that is on and nothing that ever
    // happened.
    void runStartupBatch(ids).catch((error: unknown) => {
      console.error('[templater] the startup batch could not run', error)
      useUi.getState().toast({
        title: t('templater.startup.batch_failed', { reason: error instanceof Error ? error.message : String(error) }),
        tone: 'danger',
      })
    })
  }, [devicePrefs.enableStartupTemplates, status, userId, notesHydrated, libraryHydrated])
}

/**
 * Run the batch and say what came of it.
 *
 * A row the library no longer holds is counted and reported rather than skipped quietly: the reader set this
 * list on purpose, and "nothing happened" is the answer that sends them looking through every template.
 */
async function runStartupBatch(ids: readonly string[]): Promise<void> {
  const rows = new Map(useNoteTemplates.getState().templates.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !rows.has(id.trim()))
  const outcomes = await runStartupTemplates(ids, {
    run: async (templateId) => {
      const row = rows.get(templateId)
      // `missing` already counts this one, so the batch still records an answer for it rather than inventing
      // a code the error table does not carry.
      if (row === undefined) return { ok: false, code: 'render-failed' as const, detail: `template:${templateId}` }
      return runStartupTemplate(row)
    },
  })
  const ui = useUi.getState()
  if (missing.length > 0) {
    ui.toast({ title: t('templater.startup.missing', { count: missing.length }), tone: 'warning' })
  }
  for (const outcome of outcomes) {
    if (outcome.ok) continue
    const name = rows.get(outcome.templateId)?.name ?? outcome.templateId
    const reason = outcome.code === undefined ? '' : templaterErrorText({ code: outcome.code, detail: outcome.detail ?? '' }, t)
    ui.toast({ title: t('templater.startup.failed', { name, reason }), tone: 'danger' })
  }
}
