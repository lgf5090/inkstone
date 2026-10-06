import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@shared/types'
import { useNotes } from '../../store/notes'

const ATT: Attachment = {
  id: 'a'.repeat(26),
  noteId: null,
  filename: 'photo.png',
  mime: 'image/png',
  size: 2048,
  width: 900,
  height: 600,
  url: `/api/files/${'a'.repeat(26)}`,
  createdAt: 1,
}
const byName = vi.fn()

vi.mock('../api', () => ({ api: { files: { byName: (name: string) => byName(name) }, notes: { get: vi.fn() } } }))

describe('attachment embeds', () => {
  afterEach(() => {
    document.body.replaceChildren()
    byName.mockReset()
  })

  async function resolve(source: string, files: Attachment[]) {
    byName.mockResolvedValue({ files })
    const { renderMarkdown } = await import('./renderer')
    const { resolveNoteEmbeds } = await import('./embeds')
    const host = document.createElement('div')
    host.innerHTML = renderMarkdown(source).html
    document.body.append(host)
    await resolveNoteEmbeds(host, { currentContent: source, currentTitle: 'Note' })
    return host
  }

  it('replaces the loading box with the sized image', async () => {
    const host = await resolve('![[photo.png|300x200]]', [ATT])
    const box = host.querySelector<HTMLElement>('.note-embed')!
    const img = box.querySelector('img')!
    expect(byName).toHaveBeenCalledWith('photo.png')
    expect(img.getAttribute('src')).toBe(ATT.url)
    expect(img.getAttribute('width')).toBe('300')
    expect(img.getAttribute('height')).toBe('200')
    expect(box.className).toContain('ready')
    expect(box.querySelector('.note-embed-head')!.textContent).toBe('photo.png')
  })

  it('matches the attachment case-insensitively and links non-images', async () => {
    const host = await resolve('![[Assets/Doc.PDF]]', [{ ...ATT, filename: 'Doc.PDF', mime: 'application/pdf', url: '/api/files/doc' }])
    expect(byName).toHaveBeenCalledWith('Doc.PDF')
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('a.attachment-open')!.getAttribute('href')).toBe('/api/files/doc')
  })

  it('reports a missing attachment instead of leaving it spinning', async () => {
    const host = await resolve('![[gone.png]]', [])
    const box = host.querySelector<HTMLElement>('.note-embed')!
    expect(box.className).toContain('error')
    expect(box.textContent).toContain('markdown.embedded_note_not_found')
    expect(box.getAttribute('aria-busy')).toBeNull()
  })

  it('still sends ordinary note targets down the note path', async () => {
    const host = await resolve('![[Some Note]]', [ATT])
    expect(byName).not.toHaveBeenCalled()
    expect(host.querySelector('.note-embed')!.className).toContain('error')
  })
})

function board(title: string, card: string): string {
  return `## ${title}\n\n\`\`\`kanban\n${JSON.stringify({
    title,
    columns: [{ id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] }],
    items: [{ id: 'i', title: card, properties: { status: 'todo' } }],
  })}\n\`\`\`\n`
}

describe('note embeds hand over their own fence bodies', () => {
  afterEach(() => {
    document.body.replaceChildren()
    useNotes.setState({ notes: {}, contents: {} })
  })

  async function embedHost(parent: string, child: string): Promise<HTMLElement> {
    useNotes.setState({
      notes: { child: { id: 'child', title: 'Child Note', excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 0, updatedAt: 0, deletedAt: null } },
      contents: { child },
    })
    const { renderMarkdown } = await import('./renderer')
    const { resolveNoteEmbeds } = await import('./embeds')
    const { renderStaticKanbans } = await import('./kanban/static')
    const { registerFenceBodies } = await import('./fence-bodies')
    const rendered = renderMarkdown(parent)
    const host = document.createElement('div')
    host.innerHTML = rendered.html
    registerFenceBodies(host, rendered.fences)
    document.body.append(host)
    await resolveNoteEmbeds(host, { currentContent: parent, currentTitle: 'Parent Note' })
    renderStaticKanbans(host)
    return host
  }

  it('draws a board inside an embed from the note it came from', async () => {
    const parent = `${board('Parent board', 'Parent Card')}\n![[Child Note]]\n`
    const host = await embedHost(parent, `${board('Child board', 'Child Card')}\n`)
    const drawn = host.querySelector<HTMLElement>('.note-embed-body .kanban-snapshot')
    expect(drawn, 'the embedded board never drew').not.toBeNull()
    expect(drawn!.textContent).toContain('Child Card')
    expect(drawn!.textContent, 'the embed read the host numbering instead of its own').not.toContain('Parent Card')
    const own = [...host.querySelectorAll<HTMLElement>('.kanban-snapshot')].find((node) => !node.closest('.note-embed-body'))
    expect(own?.textContent).toContain('Parent Card')
  })
})
