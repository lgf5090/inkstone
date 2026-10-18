// @vitest-environment jsdom
/**
 * The viewer prints the reason the server gave for refusing a file.
 *
 * The download reports its own line — `Download failed (404)` — and the route answers that status with a
 * sentence about *this* file: that its bytes were pruned with the shelf they sat on, that the reader asking
 * never owned it, that the object store is not configured. The viewer threw that sentence away, because it
 * caught the error and printed `reason.message`, which is the transport's line. Everything else in the chat
 * was moved onto `ApiError.serverMessage` for exactly this reason: the assistant's toast, a streamed turn,
 * and the thread-load banner all say the deployment's sentence beside their own, bounded and flattened by
 * the one policy in `api.ts`. The viewer was the last surface still reading the headline alone.
 *
 * Two things have to stay true while it joins them. What it prints is text, never markup — the reason is
 * another process's writing, and the shape it is most likely to carry is the shape of the field that was
 * refused. And a refusal with nothing to say has to land exactly where it lands today: one line, no empty
 * row under it, because a panel with a blank paragraph reads as a second, unsaid failure.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { AttachmentViewer } from './ChatAttachments'

const NOTE: ChatAttachment = {
  id: 'd1', kind: 'file', filename: 'notes.md', mime: 'text/markdown', size: 512, key: 'chat/files/u/d1.md', createdAt: 1,
}

let rendered: RenderedElement | null = null

/** Answers the download with whatever the case needs, then lets the viewer settle on it. */
async function openRefusedBy(response: Response): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => response))
  rendered = renderElement(createElement(AttachmentViewer, { attachment: NOTE, onClose: () => {} }))
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  const dialog = document.body.querySelector('[role="dialog"]')
  return dialog?.textContent ?? ''
}

/** The paragraph the viewer draws in place of the file's body, or none when the body arrived. */
function bodyLine(): HTMLElement | null {
  const dialog = document.body.querySelector('[role="dialog"]')
  const paragraphs = [...(dialog?.querySelectorAll('p') ?? [])].filter((node) => !node.hasAttribute('id'))
  expect(paragraphs.length, 'the viewer body is not the single line it draws').toBeLessThanOrEqual(1)
  return paragraphs[0] ?? null
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('a download the route refused with a reason', () => {
  it('says which file and why, in the one line the reader reads', async () => {
    const said = await openRefusedBy(new Response(JSON.stringify({
      error: { code: 'not_found', message: 'The stored bytes were pruned with the shelf they sat on.', details: { id: 'd1' } },
    }), { status: 404, headers: { 'content-type': 'application/json' } }))

    expect(said).toContain('Download failed (404)')
    expect(said).toContain('pruned with the shelf')
    expect(said).toContain('id: d1')
  })

  it('prints a hostile reason as text and mounts nothing of it', async () => {
    await openRefusedBy(new Response(JSON.stringify({
      error: { code: 'bad_request', message: 'bad name <img src=x onerror=alert(1)> was refused' },
    }), { status: 400, headers: { 'content-type': 'application/json' } }))

    const line = bodyLine()
    expect(line?.textContent).toContain('<img src=x onerror=alert(1)>')
    // The sentence is quoted, not interpreted: no element out of it, and the panel keeps its own parts.
    expect(document.body.querySelectorAll('img, script')).toHaveLength(0)
    expect(document.body.querySelector('pre')).toBeNull()
  })

  it('keeps the loading row alone rather than adding a blank one when the route said nothing', async () => {
    // Every field of the no-reason case is what it was before the reason was wired in: the transport's own
    // line, one paragraph, and no ` — ` hanging off the end of it.
    const said = await openRefusedBy(new Response('', { status: 500 }))
    const line = bodyLine()

    expect(line?.textContent).toBe('Download failed (500)')
    expect(line?.textContent).not.toContain(' — ')
    expect(said).toContain('text/markdown')
  })

  it('does not repeat the headline as its own reason', async () => {
    // The surface rule every other failure line holds to: a detail that says the headline again is one
    // mistake shown twice, so it is left out and the line stays single.
    const said = await openRefusedBy(new Response(JSON.stringify({
      error: { code: 'unknown', message: 'Download failed (404)' },
    }), { status: 404, headers: { 'content-type': 'application/json' } }))

    expect(bodyLine()?.textContent).toBe('Download failed (404)')
    expect(said).toContain(t('assistant.attach.download'))
  })

  it('still shows the whole file when the download answers', async () => {
    const said = await openRefusedBy(new Response('# the notes\n\nline two', { status: 200, headers: { 'content-type': 'text/plain' } }))

    expect(document.body.querySelector('pre')?.textContent).toContain('line two')
    expect(said).not.toContain('Download failed')
    expect(bodyLine()).toBeNull()
  })
})
