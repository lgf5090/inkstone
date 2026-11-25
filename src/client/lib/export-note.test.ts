import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLockedNoteAttachment } from '../store/note-locks'
import { exportNoteAsHtml } from './export-note'

const FILE_ID = '00000000000000000000000001'

vi.mock('./markdown/renderer', () => ({
  renderMarkdown: () => ({
    html: `<img src="/api/files/${FILE_ID}"><a href="/api/files/${FILE_ID}">photo</a>`,
    fences: new Map(),
    hasMath: false,
  }),
}))
vi.mock('./markdown/enhance', () => ({
  applyMediaLayouts: vi.fn(),
  applyPanelColumnTracks: vi.fn(),
  bakeChartsToImages: vi.fn(),
  renderMath: vi.fn(async () => {}),
  renderPendingCharts: vi.fn(async () => {}),
  renderPendingMermaid: vi.fn(async () => {}),
}))
vi.mock('./markdown/embeds', () => ({ resolveNoteEmbeds: vi.fn(async () => {}) }))
vi.mock('./markdown/fence-bodies', () => ({ registerFenceBodies: vi.fn() }))
vi.mock('./markdown/kanban/static', () => ({ renderStaticKanbans: vi.fn() }))
vi.mock('../store/note-locks', () => ({
  resolveLockedNoteAttachment: vi.fn(async () => ({ url: 'blob:decrypted', filename: 'photo.png', mime: 'image/png' })),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('encrypted note export', () => {
  it('embeds decrypted attachment bytes and never exports the private ciphertext URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]))))
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await exportNoteAsHtml({ title: 'Locked note', content: '![photo](/api/files/' + FILE_ID + ')' }, 'en', 'note-1')

    expect(resolveLockedNoteAttachment).toHaveBeenCalledWith('note-1', FILE_ID)
    const exported = create.mock.calls[0]?.[0]
    expect(exported).toBeInstanceOf(Blob)
    const html = await (exported as Blob).text()
    expect(html).toContain('data:image/png;base64,iVBORw==')
    expect(html).toContain('download="photo.png"')
    expect(html).not.toContain('/api/files/')
  })
})
