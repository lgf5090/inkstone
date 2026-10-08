/**
 * Who the linter is told to keep away from, and the two lists that say so.
 *
 * The lists are settings, so a menu that shows them must not drag the rule library along with it —
 * the note list and the sidebar are on the first paint, the engine is not. A run reads the same two
 * lists through `isLinterIgnoredPath`, which is where the pattern is refused before it can hang.
 */
import { isLinterIgnoredPath, type LinterSettings } from '@shared/linter'
import { folderPath } from '../folders'
import { t } from '../i18n'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'

export type NoteStamp = {
  title: string
  path: string
  folderTrail: string[]
  createdAt: number
  updatedAt: number
}

/** The note as the rules see it: a title, the path it hangs the ignore lists off, and its dates. */
export function stampOf(noteId: string): NoteStamp | null {
  const state = useNotes.getState()
  const note = state.notes[noteId]
  if (!note || note.deletedAt) {
    return null
  }
  const folderTrail = folderPath(state.folders, note.folderId).map((folder) => folder.name)

  return {
    title: note.title,
    path: [...folderTrail, note.title].join('/'),
    folderTrail,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  }
}

/**
 * A note's own entry, pinned to its path. A rename then stops the note being ignored instead of
 * silently ignoring whatever takes that name next.
 */
function ignoreMatchFor(stamp: NoteStamp): string {
  return `^${escapeForRegex(stamp.path)}$`
}

export function noteIsIgnored(settings: LinterSettings, noteId: string): boolean {
  const stamp = stampOf(noteId)
  if (!stamp) {
    return false
  }

  return isLinterIgnoredPath(settings, stamp.path, stamp.folderTrail)
}

export function folderIsIgnored(settings: LinterSettings, folderId: string): boolean {
  const trail = folderPath(useNotes.getState().folders, folderId).map((folder) => folder.name)

  return trail.some((name) => settings.foldersToIgnore.includes(name))
}

export function toggleNoteIgnored(noteId: string): void {
  const stamp = stampOf(noteId)
  if (!stamp) return
  const linter = useSession.getState().settings.linter
  const match = ignoreMatchFor(stamp)
  const kept = linter.filesToIgnore.filter((entry) => entry.match !== match)
  const ignoring = kept.length === linter.filesToIgnore.length
  void useSession.getState().updateSettings({
    linter: { ...linter, filesToIgnore: ignoring ? [...linter.filesToIgnore, { label: stamp.title, match, flags: '' }] : kept },
  })
  useUi.getState().toast({
    title: t(ignoring ? 'linter.ignore_added' : 'linter.ignore_removed', { name: stamp.title }),
  })
}

export function toggleFolderIgnored(folderId: string): void {
  const folder = folderPath(useNotes.getState().folders, folderId).pop()
  if (!folder) return
  const linter = useSession.getState().settings.linter
  const kept = linter.foldersToIgnore.filter((name) => name !== folder.name)
  const ignoring = kept.length === linter.foldersToIgnore.length
  void useSession.getState().updateSettings({
    linter: { ...linter, foldersToIgnore: ignoring ? [...linter.foldersToIgnore, folder.name] : kept },
  })
  useUi.getState().toast({
    title: t(ignoring ? 'linter.ignore_added' : 'linter.ignore_removed', { name: folder.name }),
  })
}

export function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
