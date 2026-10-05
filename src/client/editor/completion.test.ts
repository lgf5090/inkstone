import { CompletionContext } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { containerDirectiveSource } from './completion'

function complete(doc: string) {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) })
  return containerDirectiveSource(new CompletionContext(state, doc.length, true))
}

describe('containerDirectiveSource', () => {
  it('offers the container directives right after the colon marker', () => {
    const result = complete(':::')
    expect(result).not.toBeNull()
    expect(result!.from).toBe(3)
    expect(result!.options.map((option) => option.label)).toEqual(['details', 'tabs', 'tab-item', '{tab-set}', '{tab-item}'])
  })

  it('keeps the marker length out of the replacement range', () => {
    expect(complete(':::::')!.from).toBe(5)
    expect(complete(':::: tab')!.from).toBe(4)
  })

  it('accepts the space-free spelling', () => {
    expect(complete(':::details')!.from).toBe(3)
  })

  it('stays quiet away from the start of a line', () => {
    expect(complete('see :::')).toBeNull()
    expect(complete('### :::')).toBeNull()
    expect(complete('```')).toBeNull()
    expect(complete('- :::')).toBeNull()
  })
})
