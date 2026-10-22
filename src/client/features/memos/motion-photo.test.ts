// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { extractEmbeddedMotionVideo, pairMemoMotionFiles } from './motion-photo'

const MP4_HEADER = new Uint8Array([
  0x00, 0x00, 0x00, 0x10,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
])

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function motionJpeg(marker: string, video: Uint8Array = MP4_HEADER): File {
  const head = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe1,
    ...ascii(`<?xpacket begin=""?>${marker}</x:xmpmeta>`),
    0xff, 0xd9,
  ])
  const bytes = new Uint8Array(head.length + video.length)
  bytes.set(head)
  bytes.set(video, head.length)
  return new File([bytes], 'IMG_1234.jpg', { type: 'image/jpeg' })
}

function file(name: string, type: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

describe('memo motion photos', () => {
  it('extracts a Google motion video using the declared offset', async () => {
    const photo = motionJpeg(
      '<rdf:Description GCamera:MotionPhoto="1" GCamera:MicroVideoOffset="16"></rdf:Description>',
    )
    const video = await extractEmbeddedMotionVideo(photo)
    expect(video).not.toBeNull()
    expect(video!.name).toBe('img_1234.mp4')
    expect(video!.type).toBe('video/mp4')
    expect(video!.size).toBe(MP4_HEADER.length)
    expect(new Uint8Array(await video!.arrayBuffer())).toEqual(MP4_HEADER)
  })

  it('finds the trailing video when the offset is absent', async () => {
    const photo = motionJpeg('<rdf:Description GCamera:MotionPhoto="1"></rdf:Description>')
    const video = await extractEmbeddedMotionVideo(photo)
    expect(video).not.toBeNull()
    expect(new Uint8Array(await video!.arrayBuffer())).toEqual(MP4_HEADER)
  })

  it('finds a video whose header straddles a backwards scan boundary', async () => {
    const bytes = new Uint8Array(200_000)
    bytes.set([
      0xff, 0xd8,
      ...ascii('<rdf:Description GCamera:MotionPhoto="1"></rdf:Description>'),
    ])
    const start = bytes.length - 64 * 1024 - 8
    bytes.set(MP4_HEADER, start)
    const photo = new File([bytes], 'panorama.jpg', { type: 'image/jpeg' })
    const video = await extractEmbeddedMotionVideo(photo)
    expect(video).not.toBeNull()
    const extracted = new Uint8Array(await video!.arrayBuffer())
    expect(extracted).toHaveLength(bytes.length - start)
    expect(extracted.subarray(0, MP4_HEADER.length)).toEqual(MP4_HEADER)
  })

  it('leaves a JPEG without motion metadata alone', async () => {
    const photo = motionJpeg('<rdf:Description></rdf:Description>')
    expect(await extractEmbeddedMotionVideo(photo)).toBeNull()
  })

  it('pairs an embedded video with its still in one group', async () => {
    const photo = motionJpeg(
      '<rdf:Description GCamera:MotionPhoto="1" GCamera:MicroVideoOffset="16"></rdf:Description>',
    )
    const pairing = await pairMemoMotionFiles([photo])
    expect(pairing.files).toHaveLength(2)
    const still = pairing.assignments.get(photo)
    const video = pairing.files[1]!
    expect(still?.role).toBe('still')
    expect(pairing.assignments.get(video)?.role).toBe('video')
    expect(pairing.assignments.get(video)?.groupId).toBe(still?.groupId)
    expect(still?.groupId).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
    expect(pairing.files[0]).toBe(photo)
  })

  it('pairs an Apple Live Photo by filename stem', async () => {
    const still = file('IMG_0042.HEIC', 'image/heic')
    const video = file('IMG_0042.MOV', 'video/quicktime')
    const other = file('IMG_0043.HEIC', 'image/heic')
    const pairing = await pairMemoMotionFiles([still, video, other])
    expect(pairing.files).toEqual([still, video, other])
    expect(pairing.assignments.get(still)?.role).toBe('still')
    expect(pairing.assignments.get(video)?.role).toBe('video')
    expect(pairing.assignments.get(still)?.groupId).toBe(pairing.assignments.get(video)?.groupId)
    expect(pairing.assignments.has(other)).toBe(false)
  })

  it('does not pair a lone video or two stills sharing a stem', async () => {
    const video = file('clip.mov', 'video/quicktime')
    const first = file('same.png', 'image/png')
    const second = file('same.jpg', 'image/jpeg')
    const pairing = await pairMemoMotionFiles([video, first, second])
    expect(pairing.assignments.size).toBe(0)
    expect(pairing.files).toEqual([video, first, second])
  })
})
