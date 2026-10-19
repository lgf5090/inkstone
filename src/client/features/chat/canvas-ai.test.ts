// @vitest-environment jsdom
/**
 * The canvas rewrite: what it sends, and where the answer lands.
 *
 * The anchor check is the part worth pinning. A draft can be edited by the reader and by the assistant
 * while the model is thinking; a replacement that trusted the offsets from the request would write over
 * a paragraph neither side selected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import {
  applyCanvasAi,
  canvasAiPrompt,
  MAX_CANVAS_AI_SOURCE,
  runCanvasAi,
  runCanvasQuickAction,
  type CanvasAiRequest,
} from './canvas-ai'
import { editorAiAnchor } from './editor-ai'

const send = vi.hoisted(() => vi.fn())

vi.mock('./editor-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./editor-ai')>()
  return { ...actual, sendForAnswerDetailed: send }
})

const WHOLE = '# Plan\n\nFirst paragraph.\n\nSecond paragraph.'

function request(over: Partial<CanvasAiRequest> = {}): CanvasAiRequest {
  const from = WHOLE.indexOf('First')
  const to = from + 'First paragraph.'.length
  return {
    artifactId: 'a1',
    version: 3,
    title: 'Plan',
    action: 'rewrite',
    whole: WHOLE,
    from,
    to,
    source: 'First paragraph.',
    anchor: editorAiAnchor(WHOLE, from, to),
    ...over,
  }
}

beforeEach(async () => {
  await initI18n()
  send.mockReset()
})

describe('canvas AI', () => {
  it('builds a prompt that names the draft and carries only the selection', () => {
    const prompt = canvasAiPrompt('rewrite', 'First paragraph.', 'Plan')
    expect(prompt).toContain('Plan')
    expect(prompt).toContain('First paragraph.')
  })

  it('sends the open draft explicitly, without tools', async () => {
    send.mockResolvedValue({ status: 'ok', text: 'Rewritten.', messageId: 'm1' })
    const result = await runCanvasAi(request())
    expect(send).toHaveBeenCalledWith(expect.stringContaining('First paragraph.'), {
      activeArtifactId: 'a1',
      noTools: true,
      modelId: null,
    })
    expect(result).toMatchObject({ status: 'ok', text: 'Rewritten.', messageId: 'm1' })
  })

  it('refuses a selection larger than one request', async () => {
    const result = await runCanvasAi(request({ source: 'x'.repeat(MAX_CANVAS_AI_SOURCE + 1) }))
    expect(result.status).toBe('failed')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a whole-document quick action without tools when the draft fits, and with them when it does not', async () => {
    send.mockResolvedValue({ status: 'ok', text: 'Done.' })
    const whole = {
      ...request({ source: '', from: 0, to: WHOLE.length, anchor: editorAiAnchor(WHOLE, 0, WHOLE.length) }),
    }
    await runCanvasQuickAction(whole, { instructions: 'Shorten it.' })
    expect(send).toHaveBeenLastCalledWith(expect.stringContaining('Shorten it.'), {
      activeArtifactId: 'a1',
      modelId: null,
      noTools: true,
    })

    await runCanvasQuickAction({ ...whole, whole: 'x'.repeat(MAX_CANVAS_AI_SOURCE + 1) }, { instructions: 'Shorten it.' })
    expect(send).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ noTools: false }))
  })

  it('applies a skill to the selection with the skill\'s model', async () => {
    send.mockResolvedValue({ status: 'ok', text: 'Done.' })
    await runCanvasQuickAction(request(), { instructions: 'Use my house style.', modelId: 'm-skill' })
    expect(send).toHaveBeenCalledWith(expect.stringContaining('Use my house style.'), {
      activeArtifactId: 'a1',
      modelId: 'm-skill',
      noTools: true,
    })
  })

  it('replaces the selection and leaves the rest of the document alone', () => {
    const result = applyCanvasAi(WHOLE, request(), 'Rewritten paragraph.')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.content).toBe('# Plan\n\nRewritten paragraph.\n\nSecond paragraph.')
  })

  it('inserts a continuation after the passage instead of replacing it', () => {
    const result = applyCanvasAi(WHOLE, { ...request(), mode: 'insert' }, 'A continuation.')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.content).toBe('# Plan\n\nFirst paragraph.\n\nA continuation.\n\nSecond paragraph.')
  })

  it('refuses when the passage is gone by the time the answer arrives', () => {
    const changed = WHOLE.replace('First paragraph.\n\n', '')
    expect(applyCanvasAi(changed, request(), 'Rewritten.')).toEqual({ status: 'stale' })
  })

  it('refuses when the selected words themselves changed in place', () => {
    const changed = WHOLE.replace('First paragraph.', 'First paragraph, edited.')
    expect(applyCanvasAi(changed, request(), 'Rewritten.')).toEqual({ status: 'stale' })
  })
})
