import { describe, expect, it } from 'vitest'
import {
  KINSHIP_MAX_CHAIN,
  kinshipChainText,
  lookupKinship,
  type KinshipRelation,
} from '@shared/tools/calculator/kinship/kinship'

describe('calculator kinship lookup', () => {
  it('resolves a basic paternal chain', () => {
    expect(lookupKinship(['father', 'mother']).forward).toContain('奶奶')
    expect(lookupKinship(['father', 'older_brother']).forward).toContain('伯父')
  })

  it('resolves a maternal uncle', () => {
    expect(lookupKinship(['mother', 'older_brother']).forward).toContain('大舅')
  })

  it('resolves a deep cousin chain', () => {
    expect(lookupKinship(['father', 'younger_sister', 'daughter', 'daughter']).forward).toContain('姑表甥女')
  })

  it('answers how the relative calls me', () => {
    const reverse = lookupKinship(['older_brother', 'son']).reverse
    expect(reverse).toContain('叔叔')
    expect(reverse).toContain('小姑')
  })

  it('reports an impossible relation as empty', () => {
    expect(lookupKinship(['husband', 'husband']).forward).toEqual([])
  })

  it('keeps the chain text in Chinese terms', () => {
    expect(kinshipChainText(['father', 'mother'])).toBe('爸爸的妈妈')
  })

  it('covers an unbounded practical chain depth', () => {
    const cycle: KinshipRelation[] = [
      'father', 'mother', 'older_brother', 'younger_brother', 'older_sister',
      'younger_sister', 'son', 'daughter', 'husband', 'wife',
    ]
    const chain: KinshipRelation[] = Array.from({ length: KINSHIP_MAX_CHAIN }, (_unused, index) =>
      cycle[index % cycle.length]!)
    expect(lookupKinship(chain).forward.length).toBeGreaterThan(0)
  })
})
