/**
 * Four skills to start a library with.
 *
 * A skill is easiest to understand by using one, and an empty list teaches nothing — so the empty state
 * offers these instead of only explaining itself. They are the four shapes readers most often retype:
 * translate it, sum it up, write it out, review it. All four are words with no bindings, because a tool
 * set or a folder that the reader did not choose is an arrangement they would have to undo first.
 *
 * The titles and the words are catalog copy, read before they are edited like every other label. The
 * emoji is not: it is a glyph that reads the same in every language, so it stays out of the catalog.
 */
import type { MessageKey } from '../../lib/i18n'
import { t } from '../../lib/i18n'
import type { AssistantSkillExport } from '@shared/assistant'

const EXAMPLES: { icon: string, title: MessageKey, content: MessageKey }[] = [
  { icon: '🌐', title: 'assistant.skills.example.translate.title', content: 'assistant.skills.example.translate.content' },
  { icon: '📌', title: 'assistant.skills.example.summarize.title', content: 'assistant.skills.example.summarize.content' },
  { icon: '✍️', title: 'assistant.skills.example.write.title', content: 'assistant.skills.example.write.content' },
  { icon: '🔍', title: 'assistant.skills.example.review.title', content: 'assistant.skills.example.review.content' },
]

/** The starter set, in the shape the import route reads. */
export function exampleSkills(): AssistantSkillExport[] {
  return EXAMPLES.map((example) => ({
    title: t(example.title),
    content: t(example.content),
    group: t('assistant.skills.example.group'),
    icon: example.icon,
    tools: [],
    scopes: [],
    modelId: null,
  }))
}
