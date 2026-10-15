// @vitest-environment node
/**
 * The thinking table itself, tested where it is written.
 *
 * Two callers read it — the worker to build a request, the settings screens to offer a model its own levels
 * — so a mistake here is either a request a vendor rejects or a picker showing a level that never travels.
 * These fixtures pin the table's own rules rather than any one request body: which dialects a wire can
 * carry, which rungs a dialect publishes, and where a level lands when the dialect has no rung for it.
 */
import { describe, expect, it } from 'vitest'
import { modelWire, reasoningDialectValue, type AssistantProvider } from '../src/shared/assistant'
import { clampRung, dialectsForProtocol, openAiReasoningFields, reasoningRungs } from '../src/shared/reasoning'

describe('the dialects a wire can carry', () => {
  it('offers each protocol the dialects that speak its own shape', () => {
    // A dialect is a field name plus a ladder; an effort object means nothing inside a Gemini body, so the
    // list a provider is offered is narrowed to the wire it is on.
    expect(dialectsForProtocol('anthropic')).toEqual(['claude-budget', 'claude-effort'])
    expect(dialectsForProtocol('gemini')).toEqual(['gemini-budget', 'gemini-level'])
    expect(dialectsForProtocol('openai')).toEqual(['openai', 'deepseek', 'qwen', 'openrouter'])
  })

  it('keeps every dialect reachable from exactly one wire', () => {
    const all = [...dialectsForProtocol('openai'), ...dialectsForProtocol('anthropic'), ...dialectsForProtocol('gemini')]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('the rungs a dialect publishes', () => {
  it('lists a service its own set, cheapest first and with auto in front', () => {
    expect(reasoningRungs('deepseek')).toEqual(['auto', 'off', 'low', 'medium', 'high'])
    expect(reasoningRungs('qwen')).toEqual(['auto', 'off'])
    expect(reasoningRungs('gemini-budget')).toEqual(['auto', 'off', 'minimal', 'low', 'medium', 'high'])
    expect(reasoningRungs('claude-effort')).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('omits off where the service has no way to stop thinking', () => {
    // A 3.x Gemini floors at MINIMAL and the newest Claude refuses a disabled block, so offering them an
    // off rung would be a picker entry that cannot travel.
    expect(reasoningRungs('gemini-level')).not.toContain('off')
    expect(reasoningRungs('claude-effort')).not.toContain('off')
  })

  it('hands back a copy, so one screen cannot edit the table for every other reader', () => {
    const rungs = reasoningRungs('openai')
    rungs.push('max')
    expect(reasoningRungs('openai')).not.toContain('max')
  })
})

describe('where a level lands on a dialect', () => {
  it('keeps a level the dialect has, and auto stays where it is', () => {
    expect(clampRung('openai', 'auto')).toBe('auto')
    expect(clampRung('deepseek', 'medium')).toBe('medium')
    expect(clampRung('claude-effort', 'xhigh')).toBe('xhigh')
  })

  it('clamps upward rather than quietly giving less than was asked', () => {
    // A dialect with no rung as deep as the request takes its top one: asking a 3.x Gemini for `max` must
    // reach it as a level, not as something shallower than it chose.
    expect(clampRung('gemini-level', 'max')).toBe('high')
    expect(clampRung('deepseek', 'minimal')).toBe('low')
    expect(clampRung('deepseek', 'xhigh')).toBe('high')
  })

  it('never answers a request for thinking with a request to stop', () => {
    // Qwen's switch has no depth between off and on, so a level deeper than its ladder must still reach it
    // as "on" — landing on its off rung would turn thinking off for a reader who asked for more of it.
    expect(openAiReasoningFields('qwen', 'medium')).toEqual({ enable_thinking: true })
    expect(openAiReasoningFields('qwen', 'max')).toEqual({ enable_thinking: true })
    expect(openAiReasoningFields('qwen', 'off')).toEqual({ enable_thinking: false })
  })

  it('honours an explicit off only where the dialect has the switch', () => {
    expect(clampRung('deepseek', 'off')).toBe('off')
    expect(clampRung('claude-budget', 'off')).toBe('off')
    // A dialect without off becomes its least thinking instead — MINIMAL on a 3.x Gemini, a small budget on
    // a newer Claude — because there is no rung that stops it.
    expect(clampRung('gemini-level', 'off')).toBe('minimal')
    expect(clampRung('claude-effort', 'off')).toBe('minimal')
  })
})

describe('the pin a provider carries', () => {
  it('reads a stored dialect, and null for anything else', () => {
    expect(reasoningDialectValue('deepseek')).toBe('deepseek')
    // A column that held a value this build does not know — an older row, a hand-edited database — reads
    // as no pin rather than as a dialect that would build an unknown body.
    expect(reasoningDialectValue('gpt-9')).toBe(null)
    expect(reasoningDialectValue('')).toBe(null)
    expect(reasoningDialectValue(null)).toBe(null)
    expect(reasoningDialectValue(7)).toBe(null)
  })
})

describe('the wire a model is called on', () => {
  const provider = {
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    endpoints: { anthropic: 'https://api.example.com/anthropic' },
  } as Pick<AssistantProvider, 'protocol' | 'baseUrl' | 'endpoints'>

  it('takes the model\'s own protocol and that protocol\'s address', () => {
    // A gateway can answer on more than one wire with one key, which is why the address is looked up per
    // protocol rather than assumed to be the provider's base URL.
    expect(modelWire({ protocol: 'anthropic' }, provider)).toEqual({
      protocol: 'anthropic',
      baseUrl: 'https://api.example.com/anthropic',
    })
  })

  it('falls back to the base URL, and to the provider\'s protocol, when neither is named', () => {
    expect(modelWire({ protocol: null }, provider)).toEqual({
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
    })
    expect(modelWire({ protocol: 'gemini' }, provider)).toEqual({
      protocol: 'gemini',
      baseUrl: 'https://api.example.com/v1',
    })
  })
})
