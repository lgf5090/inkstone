/**
 * Derived from Templater 2.26.0 (AGPL-3.0-only)
 * docs/documentation.toml and docs/src/internal-functions/internal-modules/*.md, with Inkstone
 * adaptations. The data itself is in `./docs.ts`; this file is the contract every consumer reads.
 *
 * One registry, two readers. The syntax-reference panel and the editor's completion tooltips are
 * separate surfaces that would otherwise disagree in exactly the way that costs a reader a broken
 * template: the tooltip says a parameter exists and the panel does not. Both are therefore built on
 * {@link TEMPLATER_REFERENCE} and nothing else, and neither may hold a name list of its own.
 *
 * Three rules the shape exists to enforce:
 *
 * - `descriptionKey`, `returnsKey` and every argument's key are `MessageKey`, not free strings. This
 *   app ships no hardcoded UI copy, so a reference sentence that is not in a catalog cannot reach a
 *   reader at all — the type is what makes that a build failure rather than a review comment.
 * - `signature` and `examples` are code. They are deliberately plain strings outside the translation
 *   layer: a translated signature is a signature that no longer describes the call.
 * - `dynamic` marks the members whose set is decided at run time (`tp.user.<script>`,
 *   `tp.frontmatter.<key>`, the `tp.app`/`tp.obsidian` façade). The panel has to render those without
 *   presenting its list as exhaustive, and `./registry.test.ts` skips name matching for them — which is
 *   why the flag is per entry as well as per module, and why the test refuses it anywhere else.
 */
import type { MessageKey } from '@shared/locales/en-US'
import type { Capabilities, ReferenceEntry } from '../protocol'

/**
 * The panel's entry shape, narrowed from the wire contract's.
 *
 * `../protocol.ts` owns the shape so a future server-side renderer can read the same table; this narrows
 * the three key fields from `string` to `MessageKey`, which is the difference between "a key" and "a key
 * this build can actually translate". A typo has to fail `tsc`, not look fine until somebody opens the panel.
 */
export interface ReferenceDocEntry extends Omit<ReferenceEntry, 'descriptionKey' | 'returnsKey' | 'args'> {
  descriptionKey: MessageKey
  returnsKey?: MessageKey
  args: ReferenceArgDoc[]
  /**
   * True when the member is one of a set only known at run time — a script name, a frontmatter key.
   *
   * Such an entry names a placeholder rather than an export, so the engine-coverage gate cannot look for it
   * in the prelude; the gate keeps checking every other entry, which is what stops the flag from spreading.
   */
  dynamic?: boolean
}

export interface ReferenceArgDoc {
  name: string
  descriptionKey: MessageKey
}

/** One `tp` module: what it is for, and whether its member list can be closed. */
export interface ReferenceModuleDoc {
  module: string
  descriptionKey: MessageKey
  /**
   * True when the members below this module are not a fixed list.
   *
   * `tp.user` and `tp.frontmatter` are decided by the reader's own notes; `tp.app` and `tp.obsidian` are
   * façades whose unknown members answer a throwing placeholder rather than `undefined`. Upstream hands out
   * the whole `App` instance and the whole `obsidian` namespace, so a reader arriving from Templater's docs
   * needs the panel to say "this list is not a subset of something bigger you can reach here" out loud.
   */
  dynamic: boolean
}

/** Which of the reader's eight rights a member needs before it can do anything. */
export type ReferenceRequirement = keyof Capabilities

import { REFERENCE_ENTRIES, REFERENCE_MODULES } from './docs'

/** The data, re-exported so a consumer imports one file and cannot read the tables past the guards. */
export { REFERENCE_ENTRIES, REFERENCE_MODULES }

/** `tp.file.rename`, `tp.user.<script_name>`: the text both surfaces show beside an entry. */
export function referenceMemberPath(entry: ReferenceDocEntry): string {
  return `tp.${entry.module}.${entry.name}`
}

export function referenceModuleDoc(module: string): ReferenceModuleDoc | undefined {
  return REFERENCE_MODULES.find((candidate) => candidate.module === module)
}

export function referenceEntriesForModule(module: string): ReferenceDocEntry[] {
  return REFERENCE_ENTRIES.filter((entry) => entry.module === module)
}

export function findReferenceEntry(module: string, name: string): ReferenceDocEntry | undefined {
  return REFERENCE_ENTRIES.find((entry) => entry.module === module && entry.name === name)
}

/**
 * Whether the reader's rights can run this member at all.
 *
 * Returned rather than baked into the prose because the same sentence then serves a community template and
 * the reader's own: the panel greys the member out, the completion tooltip can say why, and neither writes
 * its own list of which members need which right.
 */
export function referenceIsAvailable(entry: ReferenceDocEntry, capabilities: Capabilities): boolean {
  return (entry.requires ?? []).every((right) => capabilities[right] === true)
}
