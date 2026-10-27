// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MusicComment } from '../src/shared/music/comments'
import type { LyricLine } from '../src/shared/music/lyrics'
import { isCreditLine, quietCommentAt, quietsFor } from '../src/client/features/music/comments/quiet-comments'

function line(startTime: number, duration: number, text = 'line'): LyricLine {
  return { startTime, duration, fullText: text, words: [] }
}

function comment(id: string, content = 'hello'): MusicComment {
  return {
    id,
    userId: 'u',
    nickname: 'N',
    avatarUrl: '',
    content,
    createdAt: 0,
    likedCount: 0,
    liked: false,
    ipLocation: '',
  }
}

describe('quiet stretches in a lyric', () => {
  it('finds intro, interlude and outro and skips credit rows', () => {
    const lyrics = [line(0, 1000, 'Lyricist: A'), line(10_000, 4000), line(30_000, 4000)]
    expect(quietsFor(lyrics, 60_000)).toEqual([
      { from: 0, to: 10_000 },
      { from: 14_000, to: 30_000 },
      { from: 34_000, to: 60_000 },
    ])
    expect(isCreditLine('Lyricist: A')).toBe(true)
    expect(isCreditLine('I said: hello')).toBe(false)
  })

  it('treats a track with no lyric as one quiet only once it has loaded and is long enough', () => {
    expect(quietsFor([], 30_000)).toEqual([{ from: 0, to: 30_000 }])
    expect(quietsFor([], 30_000, { loaded: false })).toEqual([])
    expect(quietsFor([], 7_000)).toEqual([])
  })

  it('rotates hot comments through a long quiet and leaves before the singing returns', () => {
    const quiets = [{ from: 0, to: 30_000 }]
    const hot = [comment('a'), comment('b')]
    expect(quietCommentAt(quiets, hot, 0)).toEqual({ comment: null, nextChangeMs: 1_200 })
    expect(quietCommentAt(quiets, hot, 2_000).comment?.id).toBe('a')
    expect(quietCommentAt(quiets, hot, 12_000).comment?.id).toBe('b')
    expect(quietCommentAt(quiets, hot, 29_500).comment).toBeNull()
  })

  it('ignores comments longer than the card can show and has nothing to show without hot comments', () => {
    expect(quietCommentAt([{ from: 0, to: 30_000 }], [], 2_000)).toEqual({ comment: null, nextChangeMs: null })
    const long = comment('long', 'x'.repeat(141))
    expect(quietCommentAt([{ from: 0, to: 30_000 }], [long], 2_000).comment).toBeNull()
  })
})
