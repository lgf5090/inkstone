import { describe, expect, it } from 'vitest'
import { downsamplePeaks } from './audio-peaks'

describe('downsamplePeaks', () => {
  it('takes the loudest sample in each bucket and normalises to one', () => {
    const peaks = downsamplePeaks([0, 0.5, -0.25, 0.125, 1, -1, 0, 0], 2)
    expect(peaks).toEqual([0.5, 1])
  })

  it('answers no bars for empty audio', () => {
    expect(downsamplePeaks([], 64)).toEqual([])
    expect(downsamplePeaks([0.1, 0.2], 0)).toEqual([])
  })

  it('never amplifies silence into noise', () => {
    expect(downsamplePeaks([0, 0, 0, 0], 2)).toEqual([0, 0])
  })
})
