import { describe, expect, it } from 'vitest'
import { buildPropertyTemplateHelpers, formatPropertyValue } from './property-template-helpers'
import { renderPropertyTemplate } from './property-templates'
import type { TemplateVariables } from './property-templates'

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime()

const HELPERS = buildPropertyTemplateHelpers('en-US', NOW)

function render(template: string, extra: Record<string, string> = {}): string | null {
  const variables: TemplateVariables = {
    propertyName: 'rating',
    propertyValue: '829',
    now: String(NOW),
    ...extra,
  }
  return renderPropertyTemplate(template, variables, HELPERS)
}

describe('renderPropertyTemplate', () => {
  it('substitutes the two names the plugin owns', () => {
    expect(render('{{propertyValue}}')).toBe('829')
    expect(render('{{propertyName}}: {{propertyValue}}')).toBe('rating: 829')
    expect(render('no braces at all')).toBe('no braces at all')
  })

  it('leaves a brace the author never closed as written', () => {
    expect(render('open {{propertyValue and nothing else')).toBe('open {{propertyValue and nothing else')
  })

  it('quotes a brace pair with a backslash', () => {
    expect(render('\\{{propertyValue}}')).toBe('{{propertyValue}}')
  })

  it('calls a helper with its arguments', () => {
    expect(render('{{durationFormatted propertyValue "seconds" "HH:mm:ss"}}')).toBe('00:13:49')
    expect(render('{{durationAbbreviated propertyValue "s"}}')).toBe('13m 49s')
    expect(render('{{durationHumanized propertyValue "s" true}}')).toBe('in 14 minutes')
    expect(render('{{durationHumanized propertyValue "s"}}')).toBe('14 minutes')
    expect(render('{{round 3.14159 2}}')).toBe('3.14')
    expect(render('{{percent 12 60}}')).toBe('20%')
    expect(render('{{upper status}}', { status: 'done' })).toBe('DONE')
    expect(render('{{default status "unknown"}}', { status: '' })).toBe('unknown')
    expect(render('{{if status "yes" "no"}}', { status: 'x' })).toBe('yes')
    expect(render('{{if status "yes" "no"}}', { status: 'false' })).toBe('no')
  })

  it('nests one expression inside another', () => {
    expect(render('{{upper {{default "" "none"}}}}')).toBe('NONE')
    expect(render('{{truncate propertyValue 2}}')).toBe('82…')
  })

  it('refuses a word it has never heard of instead of printing it', () => {
    expect(render('{{nonsense propertyValue "s"}}')).toBe(null)
    expect(render('{{propertyValue nonsense}}')).toBe(null)
    expect(render('{{durationHumanized propertyValue s}}')).toBe(null)
  })

  it('caps the size of a template and of what it prints', () => {
    expect(render('x'.repeat(600))).toBe(null)
    expect(render('{{'.repeat(40) + 'propertyValue' + '}}'.repeat(40))).toBe(null)
  })

  it('gives nothing for an empty expression', () => {
    expect(render('{{}}')).toBe('')
    expect(render('{{default propertyValue ""}}')).toBe('829')
  })
})

describe('formatPropertyValue', () => {
  it('hands the property name and value to the template', () => {
    expect(formatPropertyValue({
      template: '{{propertyName}}={{propertyValue}}',
      propertyName: 'pages',
      propertyValue: '312',
      locale: 'en-US',
      now: NOW,
    })).toBe('pages=312')
  })

  it('reads a date the note carries and answers with the reader\'s calendar', () => {
    expect(formatPropertyValue({
      template: '{{date propertyValue "YYYY-MM-DD"}}',
      propertyName: 'due',
      propertyValue: '2026-10-08',
      locale: 'en-US',
      now: NOW,
    })).toBe('2026-10-08')
    expect(formatPropertyValue({
      template: '{{relative propertyValue}}',
      propertyName: 'due',
      propertyValue: '2026-10-03',
      locale: 'en-US',
      now: NOW,
    })).toBe('5 days ago')
  })

  it('keeps the raw text when the pattern cannot be read', () => {
    expect(formatPropertyValue({
      template: '{{date propertyValue "YYYY"}}',
      propertyName: 'due',
      propertyValue: 'someday',
      locale: 'en-US',
      now: NOW,
    })).toBe('someday')
  })

  it('renders a steam widget the way the reference documents it', () => {
    expect(formatPropertyValue({
      template: 'https://store.steampowered.com/widget/{{propertyValue}}',
      propertyName: 'steamid',
      propertyValue: '76561198000000000',
      locale: 'en-US',
      now: NOW,
    })).toBe('https://store.steampowered.com/widget/76561198000000000')
  })
})
