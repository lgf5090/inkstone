/**
 * Which template a created note gets — and, when it gets none, the reason as a tag.
 *
 * Derived from Templater 2.26.0 (AGPL-3.0-only) src/core/Templater.ts
 * (`on_file_creation`, `get_new_file_template_for_folder`, `get_new_file_template_for_file`), with
 * Inkstone adaptations.
 *
 * This is the decision half only: it takes the note, the account's rules and the device's answer, and
 * returns data. It imports no store, no editor, no dialog and not even `../device-prefs` — the device
 * switch is a parameter, because reading it here would put a localStorage read inside a pure function and
 * make the whole thing untestable without a browser. The caller in the note-creation path does the asking,
 * the writing and the telling; what it cannot do is decide, and that is the point of putting the decision
 * somewhere else: the three rules below each cost a reader something when they get decided twice, and a
 * second copy of a rule is how one gets fixed while the other does not.
 *
 * What the port kept, in upstream's own words from `src/settings/Settings.ts`:
 *
 * - the device switch is consulted first and nothing else is consulted after it (upstream returns from
 *   `on_file_creation` at once on the same test);
 * - folder rules are matched by walking from the note's own folder up to the root, so "the most specific
 *   (deepest) matching folder wins, so a rule for a subfolder takes precedence over a rule for its
 *   parent" (Settings.ts, the folder trigger description);
 * - pattern rules run in order, so "if a file matches multiple regex templates, only the first match will
 *   be applied" (Settings.ts, the regex trigger description);
 * - an excluded folder wins over a matching rule, and it excludes the folder's whole subtree — upstream
 *   tests the note's path against each exclusion, which is an ancestor test by another name.
 *
 * Two adaptations are deliberate and worth naming before they are read as oversights.
 *
 * 1. **No tree view.** Upstream walks `file.parent`, and this module has no folders to walk, so the caller
 *    hands over the note's live ancestors. That is not a loss: a rule pointing at a folder that has been
 *    deleted cannot appear in a chain built from a tree that no longer contains it, so such a rule is inert
 *    rather than silently retargeted somewhere else. It also means an id is compared to an id, never a path
 *    prefix to a path — upstream's `startsWith` excluded a sibling called `/notes-old` whenever `/notes` was
 *    on the list, and an id cannot be a prefix of another id.
 * 2. **`none` really is none.** Upstream's `none` still listens for the creation and replaces the commands
 *    the new file already contains; that is its documented behaviour and it is a different question from
 *    "which template applies", which is all this module answers. The in-place replacement is the caller's
 *    run path, not a decision made here.
 *
 * Not ported, because the decision does not need it: upstream's `template_has_extension` filter (a `.md`
 * rule is not offered to an `.excalidraw` file). This app's templates are library rows rather than files
 * with extensions, and the plan (FC6) keeps the extension question on the caller's side.
 */
import type { TemplaterFolderTrigger, TemplaterFileTrigger, TemplaterSettings } from '@shared/types'

/** The note the trigger is being asked about, as the caller holds it at the moment of creation. */
export interface TemplateTriggerNote {
  /**
   * The virtual path the note index uses — `Folder/Note.md` — passed through untouched.
   *
   * Normalising it here would be a second copy of the path rules, and it would also change what a reader's
   * pattern matches against without their knowing; the pattern is tested against exactly what the caller
   * called this note.
   */
  path: string
  /** The folder the note is filed in. `null` is the tree root, which a reader can pick as a rule. */
  folderId: string | null
  /**
   * Every live ancestor of {@link folderId}, nearest first, root excluded since the root has no id.
   *
   * The order is the precedence: this list is walked front to back, so the note's own folder is asked
   * before its parent and the root is asked last.
   */
  ancestorFolderIds: readonly string[]
  /**
   * Whether this creation is itself the product of a template run.
   *
   * Upstream keeps a set of paths with a template pending and refuses those (`files_with_pending_templates`);
   * the flag is this app's equivalent, and it is the caller's to know — a note written by `tp.file.create_new`,
   * by the trigger's own apply, or by a QuickAdd choice that has handled the note already all arrive `true`.
   */
  fromTemplateRun: boolean
}

/**
 * Why nothing was applied, as one tag from a closed set.
 *
 * The tag carries no wording: the caller maps every one of these to the reader's own language, which is the
 * only half that can say which screen the reader is standing on. `Record<TemplateTriggerRefusalReason, …>`
 * is exhaustive by construction, so adding a tag here is what forces a new sentence there.
 */
export type TemplateTriggerRefusalReason =
  /** This device has the trigger switched off. Nothing else was looked at. */
  | 'device-off'
  /** The note exists because a template made it; triggering on it is the recursion. */
  | 'template-run-creation'
  /** The account's matching mode is `none`. */
  | 'mode-none'
  /** The note's folder, or an ancestor of it, is on the exclusion list. */
  | 'ignored-folder'
  /** The mode's rule list produced no match — including when it holds no rules at all. */
  | 'no-rule-matched'
  /** A pattern rule could not be compiled, so nothing past it could be decided. */
  | 'invalid-pattern'

export type TemplateTriggerDecision =
  | {
      kind: 'apply'
      templateId: string
      /** The row's position in the list the mode reads: `folderTemplates` or `fileTemplates`. */
      ruleIndex: number
    }
  | {
      kind: 'refuse'
      reason: 'invalid-pattern'
      /** The row that failed, in `fileTemplates`. */
      ruleIndex: number
      /** The reader's pattern, echoed back as stored so the caller can name the broken rule. */
      pattern: string
    }
  | { kind: 'refuse'; reason: Exclude<TemplateTriggerRefusalReason, 'invalid-pattern'> }

/**
 * The template a created note gets, or the reason it gets none.
 *
 * Refusals are answered in a stated order, because two of them can be true at once and a caller that shows
 * one sentence has to be shown the same one every time: the device's no, then the recursion, then the mode,
 * then the exclusions, then the rules. Upstream's order differs only in that it checks exclusions before the
 * mode — it has no early return for `none` to have one before.
 *
 * @param note The created note, as the caller knows it.
 * @param settings The account's `templater` block, already cleaned by `mergeSettings`.
 * @param triggerOnFileCreation This device's switch, read by the caller from `../device-prefs`.
 */
export function decideTemplateForCreatedNote(
  note: TemplateTriggerNote,
  settings: TemplaterSettings,
  triggerOnFileCreation: boolean,
): TemplateTriggerDecision {
  if (!triggerOnFileCreation) return { kind: 'refuse', reason: 'device-off' }
  if (note.fromTemplateRun) return { kind: 'refuse', reason: 'template-run-creation' }
  if (settings.fileCreationMode === 'none') return { kind: 'refuse', reason: 'mode-none' }

  const folders = folderChainOf(note)
  // An exclusion names a folder, and the note is inside every folder of its chain.
  if (settings.ignoreFoldersOnCreation.some((id) => id !== '' && folders.includes(id))) {
    return { kind: 'refuse', reason: 'ignored-folder' }
  }

  return settings.fileCreationMode === 'regex'
    ? matchPatternRule(note.path, settings.fileTemplates)
    : matchFolderRule(folders, settings.folderTemplates)
}

/**
 * The note's folder and each live ancestor, nearest first, with the root last.
 *
 * The root is `null` rather than an id, which is what lets a rule with `folderId: null` be the catch-all
 * upstream's `/` rule is. Empty ids are dropped: a caller that could not resolve a folder hands `''`, and
 * treating that as a folder would let one malformed row match every note that fails the same way.
 */
function folderChainOf(note: TemplateTriggerNote): (string | null)[] {
  const chain: (string | null)[] = []
  if (note.folderId !== null && note.folderId !== '') chain.push(note.folderId)
  for (const id of note.ancestorFolderIds) {
    if (id !== '') chain.push(id)
  }
  chain.push(null)
  return chain
}

/** The deepest folder that has a row wins, and a folder with two rows takes the first of them. */
function matchFolderRule(
  folders: readonly (string | null)[],
  rules: readonly TemplaterFolderTrigger[],
): TemplateTriggerDecision {
  for (const folderId of folders) {
    const ruleIndex = rules.findIndex((rule) => rule.folderId === folderId && isAppliable(rule.templateId))
    if (ruleIndex !== -1) {
      const rule = rules[ruleIndex]!
      return { kind: 'apply', templateId: rule.templateId, ruleIndex }
    }
  }
  return { kind: 'refuse', reason: 'no-rule-matched' }
}

/**
 * The first pattern that matches the path, in the order the reader put them in.
 *
 * A pattern is the reader's own text compiled by `new RegExp`, so two failures have to be answered rather
 * than propagated: a syntax error — which upstream lets throw, and the throw lands in an event handler
 * nobody awaits, so nothing is applied and nothing is said — and a pattern that compiles but takes a
 * person's afternoon to decide.
 *
 * The syntax error is caught and refused by name. **The pathological pattern is not defended against at
 * all**: matching is synchronous on the caller's thread, and neither JavaScript nor this module can stop
 * `(a+)+$` from taking long on input crafted to make it. Upstream does nothing here either. What bounds it
 * is the settings block rather than anything in this function — the sanitizer caps the list at
 * `LIMITS.templaterFileTriggersMax` rows of `LIMITS.templaterRegexMaxLength` characters — and that cap is
 * about the request body, not about backtracking: a 100-character pattern can be plenty. A caller that
 * cannot tolerate a stalled main thread has to run the match somewhere cancellable, not here.
 */
function matchPatternRule(
  path: string,
  rules: readonly TemplaterFileTrigger[],
): TemplateTriggerDecision {
  for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
    const rule = rules[ruleIndex]!
    if (!isAppliable(rule.templateId)) continue
    let expression: RegExp
    try {
      expression = new RegExp(rule.regex)
    } catch {
      // Not skipped: rows past a broken one cannot be reached honestly, because the reader's order is the
      // precedence and a row that does not compile has already broken it.
      return { kind: 'refuse', reason: 'invalid-pattern', ruleIndex, pattern: rule.regex }
    }
    if (expression.test(path)) {
      return { kind: 'apply', templateId: rule.templateId, ruleIndex }
    }
  }
  return { kind: 'refuse', reason: 'no-rule-matched' }
}

/**
 * Whether a row can be applied at all.
 *
 * `mergeSettings` drops a row whose template id is missing, and the type allows `''` anyway; handing the
 * caller back an empty id would be a run against no template, so such a row is simply not a rule.
 */
function isAppliable(templateId: string): boolean {
  return templateId !== ''
}
