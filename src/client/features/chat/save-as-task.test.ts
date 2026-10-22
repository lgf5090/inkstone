/**
 * What one message becomes when the reader keeps it as a task.
 *
 * The interesting cases are the ones a message actually has: a heading or a list item on its first
 * line, a wall of text that has to be cut to a title, and a message with no words at all — an image the
 * reader sent with nothing typed — which must not become a task called "Untitled".
 */
import { describe, expect, it } from 'vitest'
import { taskDraftFromMessage } from './save-as-task'

describe('taskDraftFromMessage', () => {
  it('takes the first line as the title and the whole text as the note', () => {
    const draft = taskDraftFromMessage('订水\n楼下便利店的，两桶', 'c1')
    expect(draft).toMatchObject({
      title: '订水',
      description: '订水\n楼下便利店的，两桶',
      conversationId: 'c1',
    })
  })

  it('drops the markdown the first line was written in', () => {
    expect(taskDraftFromMessage('## 交周报\n周五之前', null)?.title).toBe('交周报')
    expect(taskDraftFromMessage('- 买牛奶\n顺便买鸡蛋', null)?.title).toBe('买牛奶')
    expect(taskDraftFromMessage('**交周报**', null)?.title).toBe('交周报')
  })

  it('cuts a title that will not fit on a card', () => {
    const title = taskDraftFromMessage('长'.repeat(200), null)?.title ?? ''
    expect(title).toHaveLength(80)
  })

  it('makes no task out of a message with no words', () => {
    expect(taskDraftFromMessage('   \n  ', 'c1')).toBeNull()
  })

  it('leaves the conversation out when there is none', () => {
    expect(taskDraftFromMessage('买牛奶', null)).not.toHaveProperty('conversationId')
  })
})
