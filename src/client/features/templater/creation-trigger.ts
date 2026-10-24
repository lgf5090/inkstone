/**
 * The file-creation trigger: the listener that turns "a note was made" into "run this template over it".
 *
 * The decision is `host/trigger.ts`'s and this file holds none of it — it only gathers what that module
 * cannot see (the folder chain, the reader's settings, this device's switch) and carries out the one answer
 * it gives. That split is what keeps the rule testable without a store and this file free of rules.
 *
 * It listens on the notes store rather than wrapping one "new note" button, because notes arrive from more
 * places than the sidebar: the excalidraw and mindmap creators, a duplicate, a contextual note opened from a
 * link, and a template's own `tp.file.create_new`. Hooking a button would silently miss four of those, and
 * the last one is the recursion the device switch and `fromTemplateRun` exist to stop.
 */
import type { Note } from '@shared/types'
import { folderPath } from '../../lib/folders'
import { useNotes, subscribeNoteCreated } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { loadTemplaterDevicePrefs } from '../../lib/templater/device-prefs'
import { decideTemplateForCreatedNote } from '../../lib/templater/host/trigger'
import { virtualFolderSegment, virtualNoteName } from '../../lib/templater/context/file-wrapper'
import { applyTemplateToCreatedNote } from './run-shell'

/**
 * Start listening. Returns the unsubscribe, for the test and for a hot reload.
 *
 * One call per page: the store hands every created note to every listener, so two mounts would run two
 * templates into the same note.
 */
export function installTemplaterCreationTrigger(): () => void {
  return subscribeNoteCreated((note, fromTemplateRun) => {
    // Reported, never swallowed: the run itself answers its refusals with a toast, so anything reaching here
    // is the wiring failing, and a note left with the template's default content is something the reader
    // should be told about rather than discover.
    void handleCreatedNote(note, fromTemplateRun).catch((error: unknown) => {
      console.error('[templater] the file-creation trigger could not run', error)
    })
  })
}

async function handleCreatedNote(note: Note, fromTemplateRun: boolean): Promise<void> {
  const state = useSession.getState()
  const userId = state.user?.id ?? null
  if (userId === null) return
  const settings = state.settings.templater
  const folders = useNotes.getState().folders
  const chain = folderPath(folders, note.folderId)
  const decision = decideTemplateForCreatedNote(
    {
      path: notePath(chain, note),
      folderId: note.folderId,
      ancestorFolderIds: chain.slice(0, -1).reverse().map((folder) => folder.id),
      fromTemplateRun,
    },
    settings,
    loadTemplaterDevicePrefs(userId).triggerOnFileCreation,
  )
  if (decision.kind !== 'apply') return
  const template = useNoteTemplates.getState().templates.find((row) => row.id === decision.templateId)
  // The rule named a template the library no longer has. Saying nothing is right here for the same reason
  // the trigger is silent when no rule matches: the note the reader made is intact either way, and a toast on
  // every new note is a worse answer than the settings screen, which lists the rule and its missing template.
  if (template === undefined) return
  await applyTemplateToCreatedNote(template, note)
}

/** The path the rule matches against, in the form the note index uses: `Folder/Note.md`. */
function notePath(chain: ReturnType<typeof folderPath>, note: Note): string {
  return [...chain.map((folder) => virtualFolderSegment(folder.name)), virtualNoteName(note.title)].join('/')
}
