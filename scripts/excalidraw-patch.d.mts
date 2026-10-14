/**
 * The contract of `excalidraw-patch.mjs`, the single source for the exact-string edits the vendored
 * engine build needs. A miss here is silent by nature — one renamed local turns a `.replace()` into a
 * no-op and the bundle ships unpatched while every gate still passes — so the shape of a patch and of
 * the report `applyExcalidrawPatches` returns is declared, and the table test reads it as data.
 */

export interface ExcalidrawPatch {
  /** Named in kebab-case and quoted in the build log, so a miss says which edit failed. */
  id: string
  /** The exact minified text this edit looks for. */
  target: string
  /** The text it becomes. */
  replacement: string
  /** Older spellings of `target` that a previously patched bundle may still carry. */
  superseded?: string[]
}

export declare const EXCALIDRAW_PATCHES: readonly ExcalidrawPatch[]

export interface ExcalidrawPatchReport {
  /** The bundle text with every patch the source accepted applied to it. */
  content: string
  /** Ids applied in this run, whether from the current or a superseded spelling. */
  applied: string[]
  /** Ids whose replacement text was already in the source, so nothing changed. */
  already: string[]
  /** Ids found in neither form — the list a build must refuse to ship on. */
  unmatched: string[]
}

export declare function applyExcalidrawPatches(source: string): ExcalidrawPatchReport
