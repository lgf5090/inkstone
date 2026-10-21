/**
 * The `tp.user` completion source, without dragging the sandbox into the first screen.
 *
 * The note editor is in the entry chunk, and answering "which scripts does this reader have" needs the page
 * host's store port and the export scanner — several hundred kilobytes of Templater that a reader who never
 * types `tp.user.` should not download. So this is the only piece of the completion path the editor may import
 * statically: it holds two closures, and the real work arrives on the first keystroke that asks for a list.
 *
 * `tests/templater-offline-footprint.test.ts` is what would notice if this indirection were removed, because
 * the sandbox's modules would then join the entry graph.
 */
import type { TemplaterScriptSource } from '../../editor/templater-completion'

let loaded: Promise<TemplaterScriptSource> | null = null

function source(): Promise<TemplaterScriptSource> {
  if (!loaded) loaded = import('./completion-surface').then((module) => module.templaterScriptSource())
  return loaded
}

export const templaterUserScripts: TemplaterScriptSource = {
  names: () => source().then((one) => one.names()),
  members: (name) => source().then((one) => one.members(name)),
}
