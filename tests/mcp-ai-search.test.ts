import { describe, expect, it } from 'vitest'
import {
  cosineSimilarity,
  extractEmbeddings,
  encodeVector,
  decodeVector,
  extractEmbedding,
  fuseByRrf,
} from '../src/worker/mcp/ai-search'

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3, 4])
    expect(cosineSimilarity(a, new Float32Array([1, 2, 3, 4]))).toBeCloseTo(1, 6)
  })

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0])
    expect(cosineSimilarity(a, new Float32Array([0, 1, 0]))).toBeCloseTo(0, 6)
  })

  it('is positive for similar and negative for opposite vectors', () => {
    const a = new Float32Array([1, 1, 1])
    expect(cosineSimilarity(a, new Float32Array([2, 2, 2]))).toBeGreaterThan(0.9)
    expect(cosineSimilarity(a, new Float32Array([-1, -1, -1]))).toBeLessThan(-0.9)
  })

  it('returns 0 for zero vectors', () => {
    const zero = new Float32Array(4)
    expect(cosineSimilarity(zero, new Float32Array([1, 0, 0, 0]))).toBe(0)
  })
})

describe('extractEmbedding', () => {
  it('accepts the { data: [{ embedding }] } shape', () => {
    const vector = extractEmbedding({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    expect(vector).toHaveLength(3)
    expect(vector[0]!).toBeCloseTo(0.1, 6)
    expect(vector[2]!).toBeCloseTo(0.3, 6)
  })

  it('accepts the { shape, data } shape', () => {
    const vector = extractEmbedding({ shape: [1, 3], data: [[0.5, 0.6, 0.7]] })
    expect(vector).toHaveLength(3)
    expect(vector[1]!).toBeCloseTo(0.6, 6)
  })

  it('throws on malformed responses', () => {
    expect(() => extractEmbedding({})).toThrow()
    expect(() => extractEmbedding({ data: [] })).toThrow()
    expect(() => extractEmbedding({ data: [{ text: 'nope' }] })).toThrow()
  })
})

describe('vector encoding', () => {
  it('round-trips through ArrayBuffer', () => {
    const original = new Float32Array([1.5, -2.25, 3.125])
    const decoded = decodeVector(encodeVector(original))
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })
})

describe('fuseByRrf', () => {
  const lexical = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const semantic = [{ id: 'c' }, { id: 'a' }, { id: 'd' }]

  it('ranks notes present in both lists above single-source notes', () => {
    const fused = fuseByRrf(lexical, semantic)
    expect(fused[0]!.item.id).toBe('a')
    expect(fused[1]!.item.id).toBe('c')
    expect(fused[0]!.sources).toEqual(new Set(['lexical', 'semantic']))
    expect(fused[1]!.sources).toEqual(new Set(['lexical', 'semantic']))
    expect(fused.map((f) => f.item.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('handles disjoint lists and empty lists', () => {
    const fused = fuseByRrf([{ id: 'x' }], [])
    expect(fused).toHaveLength(1)
    expect(fused[0]!.sources).toEqual(new Set(['lexical']))
    expect(fuseByRrf([], [])).toEqual([])
  })
})

describe('extractEmbeddings', () => {
  it('maps batch entries in order for both response shapes', () => {
    const shaped = extractEmbeddings({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }, 2)
    expect(shaped).toHaveLength(2)
    expect(Array.from(shaped[0]!)).toEqual([1, 0])
    expect(Array.from(shaped[1]!)).toEqual([0, 1])
    const bare = extractEmbeddings({ data: [[1, 2], [3, 4]] }, 2)
    expect(Array.from(bare[1]!)).toEqual([3, 4])
  })

  it('rejects a batch length mismatch or malformed body', () => {
    expect(() => extractEmbeddings({ data: [{ embedding: [1] }] }, 2)).toThrow()
    expect(() => extractEmbeddings({}, 1)).toThrow()
  })
})
