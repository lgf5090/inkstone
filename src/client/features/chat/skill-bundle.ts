/**
 * The skills library as a file, in both directions.
 *
 * The write is the same one every other export uses. The read is the half that has to be careful, because
 * a reader may hand this app anything at all: only the outermost shape is judged here — whether the text
 * parses, and whether it holds a list — and the entries go on to the server unread. That is deliberate.
 * What a skill entry may contain is a rule about what this app will store, and a rule answered in two
 * places is two answers that drift; the server is the trust boundary, so it is the one that answers.
 */
import { skillBundleEntries, type AssistantSkillBundle } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { downloadTextFile, safeFileName } from '../../lib/export-note'

/** Writes the library to the reader's downloads folder. */
export function downloadSkillBundle(bundle: AssistantSkillBundle): void {
  downloadTextFile(
    `${safeFileName(t('assistant.skills.bundle_name'))}.json`,
    `${JSON.stringify(bundle, null, 2)}\n`,
    'application/json;charset=utf-8',
  )
}

/**
 * The entries a chosen file holds.
 *
 * Every failure is a sentence the reader can act on rather than a stack: "that is not JSON" and "that
 * holds no list" are the two things they can fix by picking another file, and anything past them is the
 * server's to report per entry.
 */
export async function readSkillBundleFile(file: File): Promise<unknown[]> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(t('assistant.skills.import_bad_json'))
  }
  const entries = skillBundleEntries(parsed)
  if (entries === null) throw new Error(t('assistant.skills.import_no_list'))
  return entries
}
