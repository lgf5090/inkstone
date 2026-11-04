/**
 * What the ScriptsHub page tells the assistant about itself.
 *
 * The facts are the ones a sentence typed beside the page leans on: which folder or tag is in force,
 * which snippet is open, what file and language it shows, and whether it is already published. The
 * file body is not included — the assistant has `scriptshub_read` for that, and a page context that
 * carried a megabyte of code would be charged to every question asked here.
 */
import type { AssistantPageContext } from '@shared/assistant'
import type { ScriptSnippetDetail, ScriptSnippetSummary } from '@shared/scriptshub/types'

export interface ScriptsHubPageContextInput {
  folderPath: string
  tagName: string | null
  quick: string
  search: string
  visible: number
  selected: ScriptSnippetDetail | null
  items: readonly ScriptSnippetSummary[]
}

function fact(value: string, max = 120): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildScriptsHubPageContext(input: ScriptsHubPageContextInput): AssistantPageContext {
  const selected = input.selected
  const files = selected?.files.map((file) => `${file.name} (${file.language})`).join(', ') ?? ''
  const facts = [
    `view: ${input.folderPath || 'all snippets'}${input.tagName ? `, tag ${fact(input.tagName)}` : ''}`,
    `filter: ${input.quick}${input.search.trim() ? `, search "${fact(input.search)}"` : ''}`,
    `visible: ${input.visible}`,
  ]
  if (selected) {
    facts.push(`open snippet: ${fact(selected.title)} (${selected.language})`)
    if (files) facts.push(`files: ${fact(files, 180)}`)
    facts.push(`published: ${selected.publication ? selected.publication.path : 'no'}`)
  } else if (input.items.length) {
    facts.push(`recent: ${fact(input.items.slice(0, 3).map((item) => `"${item.title}"`).join(' | '), 180)}`)
  }
  return {
    surface: 'scriptshub',
    label: `ScriptsHub · ${input.folderPath || 'All snippets'}`,
    facts: facts.slice(0, 8),
  }
}
