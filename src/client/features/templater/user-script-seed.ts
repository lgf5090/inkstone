/**
 * The one action that makes a user script: a note whose title ends in `.js`, in the folder the reader chose,
 * holding an export the scanner can already read.
 *
 * What makes a title a script, and the name it answers to, belong to `lib/templater/host/user-scripts.ts` —
 * this file borrows neither rule and asks that module instead. What lives here is only what that one cannot
 * answer: which title is still free, and what a first script should contain so it is callable the moment it
 * is saved. Before this existed the whole feature was a sentence in a setting's description telling the reader
 * to rename a note by hand.
 */
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { userScriptNameOf } from '../../lib/templater/host/user-scripts'

/** The stem a new script starts from; a numeric suffix is added while that name is taken. */
const SCRIPT_STEM = 'my_script'

/** The suffix that makes a note a script. Kept short so the name a reader types cannot drift from it. */
const SCRIPT_SUFFIX = '.js'

/**
 * The first `<stem>.js` no note in the account already answers to.
 *
 * Checked against every title rather than only the chosen folder's, because two notes called `my_script.js`
 * in different folders are one `tp.user.my_script` with two bodies, and a run picks one without saying which.
 * Titles are compared the way the scan reads them — trimmed, extension matched case-insensitively — so a note
 * named `My_Script.JS` reserves the name too.
 */
export function nextScriptTitle(titles: Iterable<string>): string {
  const taken = new Set<string>()
  for (const title of titles) {
    const name = userScriptNameOf(title)
    if (name !== null) taken.add(name.toLowerCase())
  }
  for (let attempt = 1; attempt <= 50; attempt++) {
    const name = attempt === 1 ? SCRIPT_STEM : `${SCRIPT_STEM}_${attempt}`
    if (!taken.has(name.toLowerCase())) return `${name}${SCRIPT_SUFFIX}`
  }
  return `${SCRIPT_STEM}_${Date.now()}${SCRIPT_SUFFIX}`
}

/**
 * Create the script note, open it, and answer with the name a template will call it by — or `null` when the
 * create did not happen. A failed create is left to the store's own message: this adds no second error line
 * for the same event.
 */
export async function createUserScript(folderId: string): Promise<string | null> {
  const notes = useNotes.getState()
  const title = nextScriptTitle(Object.values(notes.notes).map((note) => note.title))
  const id = await notes.createNote({ title, content: t('templater.script.starter_body'), folderId, open: true })
  if (id === null) return null
  return userScriptNameOf(title)
}
