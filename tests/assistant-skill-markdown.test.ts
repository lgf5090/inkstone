import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from '../src/worker/routes/assistant'

describe('SKILL.md parsing', () => {
  it('reads name and description from the front matter', () => {
    expect(parseSkillMarkdown('---\nname: "Meeting notes"\ndescription: Turns a transcript into decisions\n---\n# Body\nKeep every decision.')).toEqual({
      title: 'Meeting notes',
      description: 'Turns a transcript into decisions',
      content: '# Body\nKeep every decision.',
    })
  })

  it('treats a file with no front matter as the body', () => {
    expect(parseSkillMarkdown('# Task\nDo the thing.')).toEqual({
      title: '',
      description: '',
      content: '# Task\nDo the thing.',
    })
  })

  it('ignores a vertical bar earlier in the file', () => {
    expect(parseSkillMarkdown('Intro\n---\nname: Not front matter\n---\nBody')).toEqual({
      title: '',
      description: '',
      content: 'Intro\n---\nname: Not front matter\n---\nBody',
    })
  })
})
