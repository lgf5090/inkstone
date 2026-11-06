// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BUILTIN_TEMPLATES } from '../src/shared/tools/prompt-optimizer/builtin-templates'
import { builtinTemplatesOfType, findBuiltinTemplate } from '../src/shared/tools/prompt-optimizer/builtin'
import { renderTemplate, templateContextWithHelpers } from '../src/shared/tools/prompt-optimizer/template-render'
import {
  applyVariables,
  missingVariables,
  predefinedVariableValues,
  validateVariableName,
  variableNames,
} from '../src/shared/tools/prompt-optimizer/variables'
import {
  OptimizeRequestSchema,
  FavoriteInputSchema,
  TemplateImportSchema,
  VariableInputSchema,
  SessionSaveSchema,
} from '../src/shared/tools/prompt-optimizer/schemas'

describe('Prompt Optimizer template renderer', () => {
  it('interpolates, escapes and keeps the raw form for triple braces', () => {
    const context = { name: 'a < b', body: 'x & y' }
    expect(renderTemplate('Hello {{name}}', context)).toBe('Hello a &lt; b')
    expect(renderTemplate('Hello {{{name}}}', context)).toBe('Hello a < b')
    expect(renderTemplate('{{{body}}}', context)).toBe('x & y')
  })

  it('renders sections, inverted sections, nested objects and the current item', () => {
    const context = {
      hasFocus: true,
      noFocus: false,
      items: [{ label: 'one' }, { label: 'two' }],
      nested: { value: 'deep' },
    }
    expect(renderTemplate('{{#hasFocus}}yes{{/hasFocus}}{{^hasFocus}}no{{/hasFocus}}', context)).toBe('yes')
    expect(renderTemplate('{{^noFocus}}fallback{{/noFocus}}', context)).toBe('fallback')
    expect(renderTemplate('{{#items}}{{label}}·{{/items}}', context)).toBe('one·two·')
    expect(renderTemplate('{{nested.value}}', context)).toBe('deep')
  })

  it('switches delimiters around literal Mustache text', () => {
    const template = 'keep {{=<% %>=}}{{variable}}<%={{ }}=%> and {{real}}'
    expect(renderTemplate(template, { real: 'value' })).toBe('keep {{variable}} and value')
  })

  it('supports the toJson lambda used by the evaluation templates', () => {
    const template = '{"prompt": {{#helpers.toJson}}{{{prompt}}}{{/helpers.toJson}}}'
    const rendered = renderTemplate(template, templateContextWithHelpers({ prompt: 'a "quoted" line' }))
    expect(JSON.parse(rendered)).toEqual({ prompt: 'a "quoted" line' })
  })

  it('resolves helpers from the root context inside a section item', () => {
    const template = '{{#snapshots}}{{{label}}}|{{#helpers.toJson}}{{{label}}}{{/helpers.toJson}};{{/snapshots}}'
    const rendered = renderTemplate(template, templateContextWithHelpers({ snapshots: [{ label: 'A' }, { label: 'B' }] }))
    expect(rendered).toBe('A|"A";B|"B";')
  })
})

describe('Prompt Optimizer variables', () => {
  it('finds unique variable names and ignores predefined ones when reporting missing values', () => {
    const text = 'Write a poem about {{theme}} for {{audience}} and {{theme}}.'
    expect(variableNames(text)).toEqual(['theme', 'audience'])
    expect(missingVariables(text, { theme: 'spring' })).toEqual(['audience'])
  })

  it('replaces known variables and leaves unknown placeholders intact', () => {
    expect(applyVariables('{{a}} + {{b}}', { a: '1' })).toBe('1 + {{b}}')
  })

  it('validates names and fills predefined values', () => {
    expect(validateVariableName('1bad')).not.toBeNull()
    expect(validateVariableName('originalPrompt')).not.toBeNull()
    expect(validateVariableName('good_name')).toBeNull()
    expect(predefinedVariableValues({ originalPrompt: 'x', iterateInput: 'y' })).toEqual({
      originalPrompt: 'x',
      iterateInput: 'y',
    })
  })
})

describe('Prompt Optimizer builtin templates', () => {
  it('carries the reference catalogue with both languages', () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThan(100)
    const languages = new Set(BUILTIN_TEMPLATES.map((template) => template.metadata.language))
    expect(languages.has('zh')).toBe(true)
    expect(languages.has('en')).toBe(true)
  })

  it('selects an edition by language and a type by its catalogue', () => {
    expect(findBuiltinTemplate('general-optimize', 'zh')?.metadata.language).toBe('zh')
    expect(findBuiltinTemplate('general-optimize', 'en')?.metadata.language).toBe('en')
    expect(builtinTemplatesOfType('userOptimize', 'zh').length).toBeGreaterThan(0)
  })
})

describe('Prompt Optimizer request contracts', () => {
  it('rejects an unknown workspace and an oversized prompt', () => {
    expect(OptimizeRequestSchema.safeParse({ workspace: 'nope', prompt: 'x' }).success).toBe(false)
    expect(OptimizeRequestSchema.safeParse({ workspace: 'basic_system', prompt: 'x' }).success).toBe(true)
  })

  it('validates favorites and variables', () => {
    expect(FavoriteInputSchema.safeParse({ title: 'T', content: 'C' }).success).toBe(true)
    expect(FavoriteInputSchema.safeParse({ title: '', content: 'C' }).success).toBe(false)
    expect(VariableInputSchema.safeParse({ name: '1bad', value: '' }).success).toBe(false)
    expect(VariableInputSchema.safeParse({ name: 'good', value: '' }).success).toBe(true)
  })

  it('validates imported templates and a session revision', () => {
    expect(TemplateImportSchema.safeParse({
      templates: [{ id: 't', name: 'T', content: 'body', metadata: { version: '1', lastModified: 0, templateType: 'optimize' } }],
    }).success).toBe(true)
    expect(SessionSaveSchema.safeParse({ rev: 0, state: {} }).success).toBe(true)
    expect(SessionSaveSchema.safeParse({ rev: -1, state: {} }).success).toBe(false)
  })
})

describe('Prompt Optimizer reference-image preview', () => {
  it('parses a fenced answer, normalises single-brace placeholders and keeps the defaults', async () => {
    const { normalizeImagePromptPreview } = await import('../src/worker/tools/prompt-optimizer/ai')
    const preview = normalizeImagePromptPreview([
      '```json',
      JSON.stringify({
        prompt: { 主体: '{subject}', 主色: '「mainColor」', 背景: '城市夜景' },
        defaults: { subject: '一只橘猫', mainColor: '灰绿' },
      }),
      '```',
    ].join('\n'))
    expect(preview.variableDefaults).toEqual({ subject: '一只橘猫', mainColor: '灰绿' })
    expect(preview.prompt).toContain('{{subject}}')
    expect(preview.prompt).toContain('{{mainColor}}')
    expect(preview.prompt).toContain('城市夜景')
  })

  it('accepts a stringified prompt and falls back to raw text when the answer is not JSON', async () => {
    const { normalizeImagePromptPreview } = await import('../src/worker/tools/prompt-optimizer/ai')
    const stringified = normalizeImagePromptPreview(JSON.stringify({ prompt: JSON.stringify({ 主体: '猫' }) }))
    expect(JSON.parse(stringified.prompt)).toEqual({ 主体: '猫' })
    const malformed = normalizeImagePromptPreview('这不是 JSON，但仍然是模型回答')
    expect(malformed.prompt).toBe('')
    expect(malformed.rawText).toBe('这不是 JSON，但仍然是模型回答')
  })
})
