/**
 * The task rewrite: what a tick in a query result is allowed to do to another note's line. The refusals
 * matter as much as the edits, because the line the reader sees may no longer be the line in the file.
 */
import { describe, expect, it } from 'vitest'
import { rewriteTask, setInlineField, type TaskCompletionSettings } from './tasks'

const now = new Date(2026, 9, 8, 12, 0, 0)
const off: TaskCompletionSettings = { tracked: false, emojiShorthand: false, key: 'completion', dateFormat: 'yyyy-MM-dd', recursive: false }
const tracked: TaskCompletionSettings = { ...off, tracked: true }
const emoji: TaskCompletionSettings = { ...tracked, emojiShorthand: true }
const deep: TaskCompletionSettings = { ...off, recursive: true }

const target = (line: number, text: string) => ({ line, text })

describe('flipping a task', () => {
    it('changes only the status character', () => {
        expect(rewriteTask('- [ ] buy milk', target(0, 'buy milk'), true, off, now)).toBe('- [x] buy milk')
        expect(rewriteTask('- [x] buy milk', target(0, 'buy milk'), false, off, now)).toBe('- [ ] buy milk')
        expect(rewriteTask('  - [ ] nested', target(0, 'nested'), true, off, now)).toBe('  - [x] nested')
        expect(rewriteTask('  > - [ ] quoted', target(0, 'quoted'), true, off, now)).toBe('  > - [x] quoted')
        expect(rewriteTask('3. [ ] ordered', target(0, 'ordered'), true, off, now)).toBe('3. [x] ordered')
    })

    it('refuses a line that is not the task any more', () => {
        expect(rewriteTask('- [ ] buy milk', target(0, 'sell milk'), true, off, now)).toBeNull()
        expect(rewriteTask('not a list item', target(0, 'x'), true, off, now)).toBeNull()
        expect(rewriteTask('- plain text', target(0, 'plain text'), true, off, now)).toBeNull()
        expect(rewriteTask('- [ ] one\n- [ ] two', target(9, 'two'), true, off, now)).toBeNull()
    })

    it('keeps a trailing block id last', () => {
        expect(rewriteTask('- [ ] task text ^abc-1', target(0, 'task text ^abc-1'), true, off, now)).toBe('- [x] task text ^abc-1')
    })

    it('keeps the file’s own line endings', () => {
        expect(rewriteTask('a\r\n- [ ] task\r\nb', target(1, 'task'), true, off, now)).toBe('a\r\n- [x] task\r\nb')
    })
})

describe('completion tracking', () => {
    it('adds and removes the inline field', () => {
        const added = rewriteTask('- [ ] ship it', target(0, 'ship it'), true, tracked, now)
        expect(added).toBe('- [x] ship it [completion:: 2026-10-08]')
        expect(rewriteTask(added!, target(0, 'ship it [completion:: 2026-10-08]'), false, tracked, now)).toBe('- [ ] ship it')
        const other: TaskCompletionSettings = { ...tracked, key: 'done', dateFormat: 'yyyy/MM/dd' }
        expect(rewriteTask('- [ ] x', target(0, 'x'), true, other, now)).toBe('- [x] x [done:: 2026/10/08]')
    })

    it('uses the emoji shorthand when asked', () => {
        const added = rewriteTask('- [ ] ship it', target(0, 'ship it'), true, emoji, now)
        expect(added).toBe('- [x] ship it ✅ 2026-10-08')
        expect(rewriteTask(added!, target(0, 'ship it ✅ 2026-10-08'), false, emoji, now)).toBe('- [ ] ship it')
    })

    it('leaves the marker alone when tracking is off', () => {
        expect(rewriteTask('- [x] ship it [completion:: 2026-10-01]', target(0, 'ship it [completion:: 2026-10-01]'), false, off, now)).toBe('- [ ] ship it [completion:: 2026-10-01]')
    })
})

describe('recursive completion', () => {
    const source = [
        '- [ ] parent',
        '\t- [ ] first child',
        '\t\t- [ ] grandchild',
        '- [ ] sibling',
    ].join('\n')

    it('carries the state down and stops at a sibling', () => {
        const next = rewriteTask(source, target(0, 'parent'), true, deep, now)!.split('\n')
        expect(next[0]).toBe('- [x] parent')
        expect(next[1]).toBe('\t- [x] first child')
        expect(next[2]).toBe('\t\t- [x] grandchild')
        expect(next[3]).toBe('- [ ] sibling')
    })

    it('does not cascade when recursion is off', () => {
        const next = rewriteTask(source, target(0, 'parent'), true, off, now)!.split('\n')
        expect(next[1]).toBe('\t- [ ] first child')
    })
})

describe('setInlineField', () => {
    it('replaces, appends and removes', () => {
        expect(setInlineField('a [due:: 1] b', 'due', '2')).toBe('a b [due:: 2]')
        expect(setInlineField('a [due:: 1] b', 'due')).toBe('a b')
        expect(setInlineField('nothing here', 'due', '3')).toBe('nothing here [due:: 3]')
        expect(setInlineField('a [Due:: 1]', 'due', '9')).toBe('a [due:: 9]')
    })
})
