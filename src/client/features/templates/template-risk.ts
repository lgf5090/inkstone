/**
 * What a template body *is*, in the two words the gallery shows.
 *
 * The classification itself is the engine's (`lib/templater/detection.ts`), and this file is the only place
 * in the gallery that reads it — the card and the filter both ask here, so a badge and the list it filters
 * cannot disagree about the same body. That is also why it lives beside the two consumers rather than in the
 * engine: what counts as "runs code" on a card is a presentation question, and the day the wording changes
 * only this file moves.
 *
 * Nothing here runs, parses, or renders anything: it is a regex over text the reader already has in memory.
 */
import { templateRisk } from '../../lib/templater/detection'

export interface TemplateKinds {
  /** The body holds at least one `<% … %>` command, so the Templater engine is what would render it. */
  templater: boolean
  /** The body can run code rather than only print values: an execute command, a user script, or the network. */
  script: boolean
}

export function templateKinds(content: string): TemplateKinds {
  const risk = templateRisk(content)
  return { templater: risk.engine === 'templater', script: risk.executable }
}
