// @vitest-environment node
/**
 * The rules the assistant is built on, tested where they are written.
 *
 * These are the parts a browser session cannot prove: what a Chinese sentence means to the conflict
 * rules, how a wall-clock schedule survives a daylight-saving change, how many tokens a Han vault
 * really costs. Each fixture is chosen so a plausible-but-wrong implementation would fail it — the
 * pair that differs only in a change word, a date the reader never stated, a schedule that crosses a
 * clock change — rather than so the function merely runs.
 */
import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_TOOL_BY_NAME,
  ASSISTANT_TOOL_SPECS,
  DEFAULT_LIMITS,
  LIMIT_RANGES,
  estimateTokens,
  normalizeAssistantSettings,
  normalizeLimits,
  titleFromMessage,
} from '../src/shared/assistant'
import {
  AUTO_SUPERSEDE_CONFIDENCE,
  classifyRelationship,
  decide,
  extractStatedDate,
  fitMemoryBudget,
  hasHistoricalIntent,
  memoryTokenBudget,
  memoryTokens,
  toPromptMemory,
} from '../src/shared/assistant-memory'
import {
  INTERVAL_MAX_MINUTES,
  INTERVAL_MIN_MINUTES,
  computeNextRun,
  isValidTimeZone,
  parseScheduleSpec,
  scheduleSummary,
  zonedTimeToUtc,
} from '../src/shared/assistant-schedule'
import { localDayBounds, parseLocalTime, toLocalMinute } from '../src/shared/assistant-time'
import { buildSystemPrompt, fill, offlineAnswer, promptCatalog } from '../src/shared/assistant-prompt'
import { EN_US_ASSISTANT_PROMPT } from '../src/shared/locales/en-US-assistant-prompt'
import { ZH_CN_ASSISTANT_PROMPT } from '../src/shared/locales/zh-CN-assistant-prompt'
import { EN_US_MESSAGES } from '../src/shared/locales/en-US'
import { ZH_CN_MESSAGES } from '../src/shared/locales/zh-CN'
import { assertToolsMatchSpecs } from '../src/worker/assistant/tools'
import { anthropicEndpoint, geminiEndpoint, openAiEndpoint } from '../src/worker/assistant/upstream'
import { buildContextWindow } from '../src/worker/assistant/runner'
import { fuseMemoryRecall } from '../src/worker/assistant/semantic'
import { SCHEMA_STATEMENTS, chunkStatements } from '../src/worker/db/schema'
import { ASSISTANT_REQUIRED_INDEXES, ASSISTANT_REQUIRED_TABLES } from '../src/worker/assistant/schema'

const iso = (value: Date | number) => new Date(value).toISOString()

describe('token estimate', () => {
  it('counts one token per Han character, not one per four bytes', () => {
    // A Chinese vault is charged per character, not per four of them: 100 characters is 100 tokens.
    expect(estimateTokens('我喜欢喝茶')).toBe(5)
    const han = '我喜欢喝茶。'.repeat(20)
    expect(estimateTokens(han)).toBeGreaterThan(Math.ceil(han.length / 4) * 3)
  })

  it('keeps the four-characters-per-token reading for unspaced Latin text', () => {
    expect(estimateTokens('hello world')).toBe(3)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('你好 hello')).toBe(4)
  })
})

describe('conversation title', () => {
  it('leaves a short first line alone and folds its whitespace', () => {
    expect(titleFromMessage('  Planning   the\ntrip  ')).toBe('Planning the trip')
  })

  it('returns nothing for an empty line so the client can print its own words', () => {
    expect(titleFromMessage('   ')).toBe('')
  })

  it('breaks an unspaced Han line at its last clause mark instead of at a space', () => {
    const first = '我在上海工作和生活'.repeat(3)
    const title = `${first}，${'我喜欢喝茶和咖啡'.repeat(3)}`
    expect(title.length).toBeGreaterThan(48)
    const cut = titleFromMessage(title)
    expect(cut).toBe(first)
    expect(cut).not.toContain('，')
  })

  it('takes the word boundary when there is one far enough into the line', () => {
    const title = titleFromMessage(`the assistant walks ${'step by step '.repeat(10)}until the limit`)
    expect(title.endsWith(' ')).toBe(false)
    expect(title.length).toBeGreaterThan(20)
    expect(title.length).toBeLessThan(48)
  })
})

describe('stated dates', () => {
  it('reads the shapes a reader actually writes', () => {
    expect(extractStatedDate('Moved to Lisbon since 2024-03-01')).toBe('2024-03-01')
    expect(extractStatedDate('since March 2024')).toBe('2024-03')
    expect(extractStatedDate('in 2024 I switched jobs')).toBe('2024')
    expect(extractStatedDate('2024年3月起住在上海')).toBe('2024-03')
    expect(extractStatedDate('2024年3月5日开始吃素')).toBe('2024-03-05')
    expect(extractStatedDate('2024-06')).toBe('2024-06')
  })

  it('invents nothing when the sentence says no date', () => {
    expect(extractStatedDate('I live in Shanghai and like tea')).toBeNull()
    expect(extractStatedDate('Call 555-1234 sometime')).toBeNull()
  })

  it('falls back to the year rather than storing an impossible day', () => {
    expect(extractStatedDate('since 2024-13-45')).toBe('2024')
    expect(extractStatedDate('since 2024-03-45')).toBe('2024-03')
  })
})

describe('historical intent', () => {
  it('recognises a question about how things were', () => {
    for (const query of ['what did I use to drive?', 'Where did I live before?', '我以前住的房子']) {
      expect(hasHistoricalIntent(query)).toBe(true)
    }
  })

  it('does not treat an ordinary present question as history', () => {
    for (const query of ['What should I do today?', '我今天做什么', 'Summarise my notes']) {
      expect(hasHistoricalIntent(query)).toBe(false)
    }
  })
})

describe('memory tokens', () => {
  it('splits a Han run into characters and adjacent pairs', () => {
    const tokens = memoryTokens('我爱喝茶')
    // A bare particle names nothing, but a particle plus the content beside it is a word.
    expect(tokens.has('我')).toBe(false)
    expect(tokens.has('我爱')).toBe(true)
    expect(tokens.has('爱喝')).toBe(true)
    expect(tokens.has('喝茶')).toBe(true)
    expect(tokens.has('茶')).toBe(true)
  })

  it('drops the particles so two unrelated sentences do not look alike', () => {
    // Both sentences open the same way; only the topic words are an overlap worth reporting.
    const a = memoryTokens('我喜欢喝茶')
    const b = memoryTokens('我喜欢跑步')
    const shared = [...a].filter((token) => b.has(token))
    expect(shared.length).toBeGreaterThan(0)
    expect(shared).not.toContain('喝')
    expect(shared).not.toContain('跑')
  })

  it('finds no overlap between two sentences that share only their particles', () => {
    const shared = [...memoryTokens('我爱喝茶')].filter((token) => memoryTokens('她养了猫').has(token))
    expect(shared).toEqual([])
  })
})

describe('conflict rules', () => {
  const old = (content: string) => ({ id: 'm1', content })

  it('calls an identical statement a duplicate rather than a change', () => {
    expect(classifyRelationship('I live in Shanghai', old('I live in Shanghai')).relationship).toBe('duplicate')
  })

  it('supersedes when a change word reaches most of the old fact', () => {
    const verdict = classifyRelationship('I no longer live in Shanghai.', old('I live in Shanghai'))
    expect(verdict.relationship).toBe('supersedes')
    expect(decide(verdict)).toBe('supersede')
  })

  it('supersedes a Han job change through the job slot', () => {
    const verdict = classifyRelationship('我辞职了，不在这家公司工作了', old('我在这家公司工作'))
    expect(verdict.relationship).toBe('supersedes')
    expect(verdict.confidence).toBeGreaterThanOrEqual(AUTO_SUPERSEDE_CONFIDENCE)
    expect(decide(verdict)).toBe('supersede')
  })

  it('keeps an unconfirmed slot clash for the reader instead of guessing', () => {
    const verdict = classifyRelationship('I am vegetarian', old('I am vegan'))
    expect(['contradicts', 'possible_update']).toContain(verdict.relationship)
    expect(decide(verdict)).toBe('review')
  })

  it('reports a fact that shares a topic word but no content, instead of retiring it', () => {
    const verdict = classifyRelationship('I sold my car', old('I like driving'))
    expect(verdict.relationship).not.toBe('supersedes')
    expect(decide(verdict)).toBe('review')
  })

  it('counts a strict refinement as a replacement', () => {
    const verdict = classifyRelationship('I live in Shanghai with my wife', old('I live in Shanghai'))
    expect(verdict.relationship).toBe('refines')
    expect(decide(verdict)).toBe('supersede')
  })

  it('reports two unrelated statements as unrelated', () => {
    expect(classifyRelationship('I prefer tea', old('My car is a Honda Civic')).relationship).toBe('unrelated')
  })
})

describe('memory recall shaping', () => {
  const memory = (over: Partial<import('../src/shared/assistant').AssistantMemory>) => ({
    id: 'm1',
    content: 'I live in Shanghai',
    category: 'residence',
    status: 'active',
    validFrom: null,
    validUntil: null,
    supersededBy: null,
    ...over,
  } as import('../src/shared/assistant').AssistantMemory)

  it('labels a past fact with what replaced it', () => {
    const current = memory({ id: 'm2', content: 'I live in Lisbon' })
    const prompt = toPromptMemory(memory({
      status: 'historical',
      validUntil: '2025-01',
      supersededBy: 'm2',
    }), (id) => (id === 'm2' ? current : null))
    expect(prompt.note).toContain('until 2025-01')
    expect(prompt.note).toContain('replaced by')
    expect(prompt.note).toContain('Lisbon')
  })

  it('omits a note the reader never wrote', () => {
    expect(toPromptMemory(memory({}), () => null).note).toBeUndefined()
  })

  it('skips an oversized memory instead of stopping, so later ones still fit', () => {
    const cost = (item: { content: string }) => item.content.length
    const kept = fitMemoryBudget([
      { content: 'a'.repeat(130), category: 'note', status: 'active' },
      { content: 'bb', category: 'note', status: 'active' },
      { content: 'cc', category: 'note', status: 'active' },
    ], 120, cost)
    expect(kept.map((item) => item.content)).toEqual(['bb', 'cc'])
  })

  it('caps the memory slice so it cannot crowd out the conversation', () => {
    expect(memoryTokenBudget(8000)).toBe(1500)
    expect(memoryTokenBudget(2000)).toBe(400)
  })
})

describe('schedules', () => {
  it('reads only the shapes it knows and refuses the rest', () => {
    expect(parseScheduleSpec({ type: 'daily', time: '09:00' })).toEqual({ type: 'daily', time: '09:00' })
    expect(parseScheduleSpec({ type: 'hourly' })).toBeNull()
    expect(parseScheduleSpec({ type: 'daily', time: '25:00' })).toBeNull()
    expect(parseScheduleSpec({ type: 'weekly', time: '09:00', days: [9] })).toBeNull()
    expect(parseScheduleSpec({ type: 'interval', minutes: 1 })).toBeNull()
    expect(parseScheduleSpec({ type: 'interval', minutes: INTERVAL_MAX_MINUTES + 1 })).toBeNull()
    expect(parseScheduleSpec('daily')).toBeNull()
    expect(parseScheduleSpec(null)).toBeNull()
    expect(parseScheduleSpec({ type: 'interval', minutes: INTERVAL_MIN_MINUTES })).not.toBeNull()
  })

  it('answers strictly after the given instant', () => {
    const next = computeNextRun({ type: 'daily', time: '09:00' }, 'Asia/Shanghai', new Date('2026-10-12T01:00:00Z'))
    expect(iso(next!)).toBe('2026-10-13T01:00:00.000Z')
    expect(computeNextRun({ type: 'daily', time: '09:00' }, 'Asia/Shanghai', new Date('2026-10-12T01:00:01Z'))).not.toBeNull()
  })

  it('waits for the listed weekdays', () => {
    // A Sunday afternoon; Monday is weekday 1.
    const next = computeNextRun({ type: 'weekly', time: '09:00', days: [1, 3] }, 'UTC', new Date('2026-10-11T12:00:00Z'))
    expect(iso(next!)).toBe('2026-10-12T09:00:00.000Z')
  })

  it('runs a monthly rule on the last day of a short month', () => {
    const next = computeNextRun({ type: 'monthly', time: '09:00', day: 31 }, 'UTC', new Date('2026-02-01T00:00:00Z'))
    expect(iso(next!)).toBe('2026-02-28T09:00:00.000Z')
  })

  it('finishes a one-off that has already passed', () => {
    expect(computeNextRun({ type: 'once', at: '2020-01-01T09:00' }, 'UTC', new Date('2026-01-01T00:00:00Z'))).toBeNull()
    const next = computeNextRun({ type: 'once', at: '2026-05-01T09:00' }, 'UTC', new Date('2026-01-01T00:00:00Z'))
    expect(iso(next!)).toBe('2026-05-01T09:00:00.000Z')
  })

  it('paces an interval rule from the slot that fired', () => {
    const next = computeNextRun({ type: 'interval', minutes: 90 }, 'UTC', new Date('2026-10-12T00:00:00Z'))
    expect(iso(next!)).toBe('2026-10-12T01:30:00.000Z')
  })

  it('moves a schedule that falls in the spring-forward gap to the next real minute', () => {
    // 02:30 does not exist on 2026-03-08 in New York; the clock jumps 02:00 -> 03:00.
    expect(iso(zonedTimeToUtc(2026, 3, 8, 2, 30, 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z')
  })

  it('fires a repeated fall-back hour once, on its first occurrence', () => {
    // 01:30 happens twice on 2026-11-01 in New York.
    expect(iso(zonedTimeToUtc(2026, 11, 1, 1, 30, 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z')
  })

  it('keeps a daily rule on the wall clock across the clock change', () => {
    const saturday = computeNextRun({ type: 'daily', time: '09:00' }, 'America/New_York', new Date('2026-03-07T00:00:00Z'))
    const sunday = computeNextRun({ type: 'daily', time: '09:00' }, 'America/New_York', saturday!)
    const monday = computeNextRun({ type: 'daily', time: '09:00' }, 'America/New_York', sunday!)
    // EST until the 8th, EDT after it: the wall clock stays at 09:00 while the UTC time moves.
    expect(iso(saturday!)).toBe('2026-03-07T14:00:00.000Z')
    expect(iso(sunday!)).toBe('2026-03-08T13:00:00.000Z')
    expect(iso(monday!)).toBe('2026-03-09T13:00:00.000Z')
  })

  it('describes a schedule as catalog keys, not as an English sentence', () => {
    expect(scheduleSummary({ type: 'daily', time: '09:00' })).toEqual({ key: 'assistant.schedule.daily', params: { time: '09:00' } })
    const weekly = scheduleSummary({ type: 'weekly', time: '08:00', days: [3, 1] })
    expect(weekly.key).toBe('assistant.schedule.weekly')
    expect(weekly.params?.time).toBe('08:00')
    // The reader's words come from the caller: sorted indices, handed to the formatter it supplies.
    expect(scheduleSummary({ type: 'weekly', time: '08:00', days: [3, 1] }, (days) => days.join('+')).params?.days).toBe('1+3')
    expect(scheduleSummary({ type: 'interval', minutes: 90 })).toEqual({ key: 'assistant.schedule.every_minutes', params: { minutes: 90 } })
    expect(scheduleSummary({ type: 'interval', minutes: 120 }).key).toBe('assistant.schedule.every_hours')
    expect(scheduleSummary({ type: 'monthly', time: '08:00', day: 31 }).params?.day).toBe(31)
    expect(scheduleSummary({ type: 'once', at: '2026-05-01T09:00' }).params?.at).toBe('2026-05-01 09:00')
    // Seven days is a daily rule, and the sentence should say so.
    expect(scheduleSummary({ type: 'weekly', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }).key).toBe('assistant.schedule.daily')
  })

  it('rejects a timezone that would leave every date uncomputable', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('Mars/Shady')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('local time', () => {
  it('reads a bare date as the end of that local day', () => {
    const endOfDay = parseLocalTime('2026-03-05', 'America/New_York')
    expect(toLocalMinute(endOfDay!, 'America/New_York')).toBe('2026-03-05T23:59')
  })

  it('reads a date-time in the reader zone and an explicit offset as written', () => {
    expect(toLocalMinute(parseLocalTime('2026-03-05T09:30', 'Asia/Shanghai')!, 'Asia/Shanghai')).toBe('2026-03-05T09:30')
    expect(iso(parseLocalTime('2026-03-05T09:30:00Z', 'Asia/Shanghai')!)).toBe('2026-03-05T09:30:00.000Z')
    expect(parseLocalTime('2026-13-05', 'UTC')).toBeNull()
    expect(parseLocalTime('tomorrow', 'UTC')).toBeNull()
  })

  it('bounds the reader day in their own zone', () => {
    const bounds = localDayBounds('Asia/Shanghai', new Date('2026-10-12T04:00:00Z'))
    expect(iso(bounds.start)).toBe('2026-10-11T16:00:00.000Z')
    expect(iso(bounds.end)).toBe('2026-10-12T16:00:00.000Z')
  })
})

describe('settings normalisation', () => {
  it('clamps a limit to its range instead of storing what arrived', () => {
    const limits = normalizeLimits({ maxOutputTokens: 999_999, maxAgentSteps: -5, maxToolCalls: '7' })
    expect(limits.maxOutputTokens).toBe(LIMIT_RANGES.maxOutputTokens[1])
    expect(limits.maxAgentSteps).toBe(LIMIT_RANGES.maxAgentSteps[0])
    expect(limits.maxToolCalls).toBe(7)
    expect(limits.maxRequestsPerDay).toBe(DEFAULT_LIMITS.maxRequestsPerDay)
  })

  it('drops a bad timezone and an unknown start view but keeps the rest', () => {
    const settings = normalizeAssistantSettings({
      timezone: 'Mars/Shady',
      startView: 'calendar',
      agentName: '  Friday  ',
      offlineMode: 'yes',
      noteScope: ['a'.repeat(40), 'a'.repeat(40), 3],
    })
    expect(settings.timezone).not.toBe('Mars/Shady')
    expect(settings.startView).toBe('chat')
    expect(settings.agentName).toBe('Friday')
    expect(settings.offlineMode).toBe(false)
    expect(settings.noteScope).toHaveLength(1)
    expect(settings.noteScope[0]).toHaveLength(26)
  })

  it('leaves a default-shaped blob untouched', () => {
    const settings = normalizeAssistantSettings({})
    expect(settings.activeModelId).toBeNull()
    expect(settings.sendOnEnter).toBe(true)
    expect(settings.limits).toEqual(DEFAULT_LIMITS)
  })
})

describe('model request building', () => {
  it('puts each protocol at its own endpoint without doubling the path', () => {
    expect(openAiEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
    expect(openAiEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions')
    // A pasted host carries no path, and these services answer under /v1.
    expect(openAiEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(openAiEndpoint('https://api.deepseek.com/chat/completions')).toBe('https://api.deepseek.com/chat/completions')
    expect(anthropicEndpoint('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicEndpoint('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages')
    expect(geminiEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  })
})

describe('prompt catalog', () => {
  const placeholderCount = (value: string) => [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!).sort().join(',')

  it('holds the same keys in both languages, arrays included', () => {
    const en = EN_US_ASSISTANT_PROMPT as unknown as Record<string, unknown>
    const zh = ZH_CN_ASSISTANT_PROMPT as unknown as Record<string, unknown>
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      const left = en[key]
      const right = zh[key]
      expect(Array.isArray(right)).toBe(Array.isArray(left))
      if (Array.isArray(left) && Array.isArray(right)) expect(right).toHaveLength(left.length)
    }
  })

  it('agrees on every placeholder between the two languages', () => {
    const en = EN_US_ASSISTANT_PROMPT as unknown as Record<string, string>
    const zh = ZH_CN_ASSISTANT_PROMPT as unknown as Record<string, string>
    for (const key of Object.keys(en)) expect(placeholderCount(zh[key]!)).toBe(placeholderCount(en[key]!))
  })

  it('leaves a JSON example in the catalog alone while filling the real ones', () => {
    expect(fill('Reply with {"relationship": "x"} and {name}', { name: 'Friday' }))
      .toBe('Reply with {"relationship": "x"} and Friday')
  })

  it('builds a prompt that states the clock, the scope and the memories', () => {
    const prompt = buildSystemPrompt({
      agentName: 'Friday',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      localTime: '2026-10-12 09:00',
      autoMemory: false,
      memories: [{ content: '住在上海', category: 'residence', status: 'active' }],
      noteScope: ['folder-1'],
      noteScopeLabels: ['工作'],
    })
    expect(prompt).toContain('Friday')
    expect(prompt).toContain('2026-10-12 09:00')
    expect(prompt).toContain('工作')
    expect(prompt).not.toContain('folder-1')
    expect(prompt).toContain('住在上海')
    expect(prompt).toContain(promptCatalog('zh-CN').rule_explicit_memory)
    expect(prompt).not.toContain(promptCatalog('zh-CN').rule_auto_memory)
  })

  it('answers an offline turn in the reader language and never pretends to be a model', () => {
    expect(offlineAnswer('zh-CN', 'hello')).not.toBe(offlineAnswer('en-US', 'hello'))
    expect(offlineAnswer('en-US', 'plan my week')).toContain('plan my week')
  })
})

describe('message keys and tools', () => {
  const catalog = EN_US_MESSAGES as unknown as Record<string, string>
  const chinese = ZH_CN_MESSAGES as unknown as Record<string, string>

  it('names every tool once, in a label both languages carry', () => {
    assertToolsMatchSpecs()
    expect(ASSISTANT_TOOL_BY_NAME.size).toBe(ASSISTANT_TOOL_SPECS.length)
    for (const spec of ASSISTANT_TOOL_SPECS) {
      expect(catalog[spec.labelKey], spec.labelKey).toBeTruthy()
      expect(chinese[spec.labelKey], spec.labelKey).toBeTruthy()
      if (spec.approvalKey) {
        expect(catalog[spec.approvalKey], spec.approvalKey).toContain('{title}')
        expect(chinese[spec.approvalKey], spec.approvalKey).toContain('{title}')
      }
    }
  })

  it('marks exactly the destructive tools as needing approval', () => {
    const destructive = ASSISTANT_TOOL_SPECS.filter((spec) => spec.permission === 'destructive')
    expect(destructive.length).toBeGreaterThan(0)
    for (const spec of destructive) expect(spec.approvalKey).toBeTruthy()
    for (const spec of ASSISTANT_TOOL_SPECS.filter((entry) => entry.permission !== 'destructive')) {
      expect(spec.approvalKey, spec.name).toBeUndefined()
    }
  })

  it('has a schedule sentence for every repeat type in both languages', () => {
    for (const key of [
      'assistant.schedule.once', 'assistant.schedule.daily', 'assistant.schedule.weekly',
      'assistant.schedule.monthly', 'assistant.schedule.every_hours', 'assistant.schedule.every_minutes',
      'assistant.schedule.unknown', 'assistant.weekday.1', 'assistant.weekday.7',
    ]) {
      expect(catalog[key], key).toBeTruthy()
      expect(chinese[key], key).toBeTruthy()
    }
  })
})

describe('recall fusion', () => {
  const memory = (id: string) => ({ id, content: id, category: 'fact', source: 'manual', status: 'active' }) as never

  it('puts a memory both lists agree on first, and lets the vector list surface a new one', () => {
    const lexical = [memory('a'), memory('b')]
    const semantic = [memory('c'), memory('a')]
    expect(fuseMemoryRecall(lexical, semantic, 5).map((entry) => entry.id)).toEqual(['a', 'c', 'b'])
  })

  it('is the lexical list when there is no vector list', () => {
    const lexical = [memory('a'), memory('b')]
    expect(fuseMemoryRecall(lexical, [], 5).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('honours the limit the prompt budget uses', () => {
    const fused = fuseMemoryRecall([memory('a'), memory('b'), memory('c')], [memory('d')], 2)
    expect(fused).toHaveLength(2)
  })
})

describe('context window', () => {
  const turn = (role: 'user' | 'assistant', content: string, createdAt: number) => ({ role, content, createdAt })

  it('keeps the newest turn even when it does not fit', () => {
    const history = [
      turn('user', 'one two three four five six seven eight', 1),
      turn('assistant', 'a'.repeat(400), 2),
      turn('user', 'b'.repeat(400), 3),
    ]
    const window = buildContextWindow(history, 40, null)
    expect(window.messages.at(-1)!.content).toBe('b'.repeat(400))
    expect(window.overflow.length).toBeGreaterThan(0)
  })

  it('starts with the reader, not with a dangling answer', () => {
    const history = [
      turn('assistant', 'short answer here', 1),
      turn('user', 'hi', 2),
      turn('assistant', 'hello', 3),
      turn('user', 'and then?', 4),
    ]
    const window = buildContextWindow(history, 4000, null)
    expect(window.messages[0]!.role).toBe('user')
    expect(window.messages.map((entry) => entry.content)).toEqual(['hi', 'hello', 'and then?'])
  })

  it('treats everything up to the summary mark as already summarised', () => {
    const history = [turn('user', 'old question', 10), turn('assistant', 'old answer', 20), turn('user', 'new', 30)]
    const window = buildContextWindow(history, 4000, 20)
    expect(window.messages.map((entry) => entry.content)).toEqual(['new'])
    // Already summarised rows are neither sent again nor listed as overflow waiting for a summary.
    expect(window.overflow).toEqual([])
  })

  it('drops empty rows rather than spending the budget on them', () => {
    const window = buildContextWindow([turn('assistant', '   ', 1), turn('user', 'real', 2)], 4000, null)
    expect(window.messages.map((entry) => entry.content)).toEqual(['real'])
  })
})

describe('schema batching', () => {
  it('keeps every batch inside the ceiling D1 will accept', () => {
    const batches = chunkStatements(SCHEMA_STATEMENTS, 40)
    expect(SCHEMA_STATEMENTS.length).toBeGreaterThan(40)
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(40)
    expect(batches.flat()).toEqual([...SCHEMA_STATEMENTS])
  })

  it('keeps every one of its tables and indexes under the chat_ prefix', () => {
    const tables = ASSISTANT_REQUIRED_TABLES as readonly string[]
    const indexes = ASSISTANT_REQUIRED_INDEXES as readonly string[]
    expect(tables.length).toBeGreaterThan(10)
    for (const name of tables) expect(name.startsWith('chat_'), name).toBe(true)
    for (const name of indexes) expect(name.startsWith('idx_chat_'), name).toBe(true)
    const sql = SCHEMA_STATEMENTS.join(' ')
    expect(/\bassistant_\w/.test(sql)).toBe(false)
    // The automation kind is spelled assistant_prompt; it is data, never a table name.
    expect(sql).toContain('chat_messages')
  })

  it('does not invent an empty trailing batch', () => {
    expect(chunkStatements([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
    expect(chunkStatements([], 40)).toEqual([])
  })
})
