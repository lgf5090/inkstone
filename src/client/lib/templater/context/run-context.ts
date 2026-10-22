/**
 * The rules of one run, kept apart from the data it reads.
 *
 * `snapshot.ts` turns rows into a context; this module decides the three things that are not rows: what
 * the run is allowed to do, which of Templater's six situations it is in, and which title the reader's
 * `tp.file.title` will keep for the whole run.
 *
 * The title is the subtle one. Upstream freezes it: `InternalModuleFile.ts:326` returns
 * `config.target_file.basename` at the moment the object is built, and `test/specs/internal-modules/
 * file.e2e.ts` pins that a template which renames its own note still prints the *old* title twice —
 * `<% tp.file.title %><%* await tp.file.rename("new name") %><% tp.file.title %>` yields
 * `old name`, `old name`. So the title is read once here and never looked up again; a host that asked
 * the store what the note is called after a rename would print the new name and break that test.
 */
import type { Note, NoteTemplate } from '@shared/types'
import { capabilitiesFor, type Capabilities, type CapabilityProfile, type RunMode, type RunNoteRef } from '../protocol'
import { runNoteRef, templateRunRef } from './file-wrapper'
import type { NoteIndex } from './note-index'

/**
 * The numbers upstream's `tp.config.run_mode` returns, in `src/core/Templater.ts:32`'s order:
 * `CreateNewFromTemplate`, `AppendActiveFile`, `OverwriteFile`, `OverwriteActiveFile`,
 * `DynamicProcessor`, `StartupTemplate`. A template that compares `run_mode === 0` has to keep working.
 */
export const RUN_MODE_NUMBERS: Record<RunMode, number> = {
  'create-new': 0,
  'append-active': 1,
  'overwrite-file': 2,
  'overwrite-active': 3,
  'dynamic-processor': 4,
  startup: 5,
  // Upstream has no seventh number, so a render-only run reports the one for the document it produces:
  // `host/write.ts` assembles its text exactly as a create run's, and a template that branches on
  // `run_mode` is asking which of the six situations it is in. `worker/bootstrap.ts`'s own table answers
  // an unnamed mode with 0 for the same reason.
  'render-only': 0,
}

export function runModeNumber(mode: RunMode): number {
  return RUN_MODE_NUMBERS[mode]
}

export interface RunRulesInput {
  mode: RunMode
  capabilities: CapabilityProfile
  locale: string
  startedAt: number
  target: Note | null
  active: Note | null
  template: NoteTemplate | null
  /** The name the note is about to get; wins over the row's title, which a create run may not have yet. */
  frozenTitle?: string
  /** Paths come from the index rather than a second copy of it. */
  index: NoteIndex
}

/** What `tp.config` and the capability gate read for one run. */
export interface RunRules {
  mode: RunMode
  /** Upstream's numeric form, for `tp.config.run_mode`. */
  runMode: number
  profile: CapabilityProfile
  capabilities: Capabilities
  locale: string
  startedAt: number
  frozenTitle: string
  target: RunNoteRef | null
  active: RunNoteRef | null
  /** The applied library template as a file-shaped ref, for `tp.config.template_file`; `null` for a typed-in template. */
  templateFile: RunNoteRef | null
  /** Where the target and the active note sit in the tree, resolved once so `path(true)` is not a lookup each call. */
  targetPath: string | null
  activePath: string | null
}

/**
 * The title the run keeps.
 *
 * Order matters: an explicit title is what the page knows the note is going to be called, the target's
 * title is upstream's `target_file.basename`, and a library template's name is the create-new case —
 * upstream names the new note after the template, so `tp.file.title` reads as the template's name.
 * Nothing left is `''`, which is what `InternalModuleFile.ts:145` returns for a note it cannot see.
 */
export function frozenTitleFor(input: { target: Note | null; template: NoteTemplate | null; frozenTitle?: string }): string {
  const given = input.frozenTitle?.trim()
  if (given) return given
  const target = input.target?.title.trim()
  if (target) return target
  return input.template?.name.trim() ?? ''
}

export function resolveRunRules(input: RunRulesInput): RunRules {
  const index = input.index
  return {
    mode: input.mode,
    runMode: runModeNumber(input.mode),
    profile: input.capabilities,
    capabilities: capabilitiesFor(input.capabilities),
    locale: input.locale,
    startedAt: input.startedAt,
    frozenTitle: frozenTitleFor(input),
    target: input.target ? runNoteRef(input.target) : null,
    active: input.active ? runNoteRef(input.active) : null,
    templateFile: input.template ? templateRunRef(input.template) : null,
    targetPath: input.target ? index.getById(input.target.id)?.path ?? null : null,
    activePath: input.active ? index.getById(input.active.id)?.path ?? null : null,
  }
}
