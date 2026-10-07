import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { ZH_CN_MESSAGES } from '@shared/locales/zh-CN'
import { getLocale, initI18n, setLocaleAsync, t } from '../src/client/lib/i18n'
import { pinyinKeysOf, preloadPinyin } from '../src/client/lib/pinyin'
import { SETTINGS_SEARCH_INDEX, countBySection, searchSettings } from '../src/client/features/settings/settingsSearch'

const featureRoot = resolve('src/client/features/settings')
const MAX_HITS = 80

function messageKeyOf(node: ts.Node | undefined): string | null {
  if (!node)
    return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't')
    return messageKeyOf(node.arguments[0])
  return null
}

function scanSources(): { rendered: Set<string>, translated: Set<string>, anchored: Set<string> } {
  const rendered = new Set<string>()
  const translated = new Set<string>()
  const anchored = new Set<string>()
  for (const file of readdirSync(featureRoot).filter((name) => name.endsWith('.tsx'))) {
    const path = join(featureRoot, file)
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const argumentOf = (node: ts.CallExpression) => messageKeyOf(node.arguments[0])
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        const key = argumentOf(node)
        if (key)
          translated.add(key)
      }
      const opening = ts.isJsxSelfClosingElement(node) ? node
        : ts.isJsxElement(node) ? node.openingElement : null
      if (opening && opening.tagName.getText(source) === 'SettingRow') {
        for (const property of opening.attributes.properties) {
          if (!ts.isJsxAttribute(property) || property.name.getText(source) !== 'title')
            continue
          const key = messageKeyOf(jsxExpression(property.initializer))
          if (key)
            rendered.add(key)
        }
      }
      if (opening) {
        for (const property of opening.attributes.properties) {
          if (!ts.isJsxAttribute(property) || property.name.getText(source) !== 'data-setting-title')
            continue
          const key = messageKeyOf(jsxExpression(property.initializer))
          if (key)
            anchored.add(key)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { rendered, translated, anchored }
}

function jsxExpression(initializer: ts.JsxAttribute['initializer']): ts.Node | undefined {
  if (!initializer)
    return undefined
  return ts.isJsxExpression(initializer) ? initializer.expression : initializer
}

const scanned = scanSources()

beforeAll(async () => {
  localStorage.clear()
  await initI18n()
  await preloadPinyin()
})

describe('settings search index', () => {
  it('indexes every setting the panels render', () => {
    const indexed = new Set<string>(SETTINGS_SEARCH_INDEX.map((entry) => entry.titleKey))
    const missing = [...scanned.rendered].filter((title) => !indexed.has(title))
    expect(missing).toEqual([])
  })

  it('keeps every indexed label attached to a real setting', () => {
    const used = scanned.translated
    const stale = SETTINGS_SEARCH_INDEX
      .filter((entry) => !used.has(entry.titleKey))
      .map((entry) => entry.titleKey)
    expect(stale).toEqual([])
  })

  it('reaches every indexed setting through its own label', () => {
    const unreachable = SETTINGS_SEARCH_INDEX
      .filter((entry) => !searchSettings(t(entry.titleKey)).some((hit) => hit.entry === entry))
      .map((entry) => entry.titleKey)
    expect(unreachable).toEqual([])
  })

  it('gives every indexed setting an element the jump can land on', () => {
    const anchorless = SETTINGS_SEARCH_INDEX
      .filter((entry) => !scanned.rendered.has(entry.titleKey) && !scanned.anchored.has(entry.titleKey))
      .map((entry) => entry.titleKey)
    expect(anchorless).toEqual([])
  })
})

describe('settings search matching', () => {
  it('rebuilds its index when the language is switched', async () => {
    const previous = getLocale()
    const next = previous === 'en-US' ? 'zh-CN' : 'en-US'
    try {
      await setLocaleAsync(next, false)
      const hit = searchSettings(t('settings.theme')).find((item) => item.entry.titleKey === 'settings.theme')
      const expected = (next === 'zh-CN' ? ZH_CN_MESSAGES : EN_US_MESSAGES)['settings.theme']
      expect(hit?.title).toBe(expected)
    }
    finally {
      await setLocaleAsync(previous, false)
    }
  })

  it('returns nothing for a blank query', () => {
    expect(searchSettings('')).toEqual([])
    expect(searchSettings('   ')).toEqual([])
  })

  it('matches a setting label and highlights where it matched', () => {
    const label = t('settings.theme')
    const hit = searchSettings(label).find((item) => item.entry.titleKey === 'settings.theme')
    expect(hit).toBeDefined()
    expect(hit?.ranges.length).toBeGreaterThan(0)
  })

  it('matches the text of the language that is not on screen', () => {
    const other = getLocale() === 'en-US' ? ZH_CN_MESSAGES : EN_US_MESSAGES
    const hits = searchSettings(other['settings.theme'])
    expect(hits.map((hit) => hit.entry.titleKey)).toContain('settings.theme')
  })

  it('reads a Chinese label by its first letters and by its full reading', async () => {
    const previous = getLocale()
    try {
      await setLocaleAsync('zh-CN', false)
      const keys = pinyinKeysOf(t('settings.theme'))
      expect(keys).not.toBeNull()
      for (const query of [keys!.initials, keys!.full]) {
        expect(searchSettings(query).map((hit) => hit.entry.titleKey), query).toContain('settings.theme')
      }
    }
    finally {
      await setLocaleAsync(previous, false)
    }
  })

  it('matches a setting by one of its control values', () => {
    expect(searchSettings(t('settings.dark')).map((hit) => hit.entry.titleKey)).toContain('settings.theme')
  })

  it('ranks a label match above a description match', () => {
    const byLabel = searchSettings(t('settings.autosave_delay')).find((hit) => hit.entry.titleKey === 'settings.autosave_delay')
    const entry = SETTINGS_SEARCH_INDEX.find((item) => item.titleKey === 'settings.autosave_delay')
    const byDescription = searchSettings(t(entry!.detailKey!)).find((hit) => hit.entry.titleKey === 'settings.autosave_delay')
    expect(byLabel!.score).toBeGreaterThan(byDescription!.score)
  })

  it('requires every word of a query to match somewhere', () => {
    expect(searchSettings(`${t('settings.theme')} nosuchsettinganywhere`)).toEqual([])
  })

  it('caps the result list', () => {
    expect(searchSettings('a').length).toBeLessThanOrEqual(MAX_HITS)
  })

  it('counts matches per section so navigation can show them', () => {
    const hits = searchSettings(t('settings.backup'))
    const counts = countBySection(hits)
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0)
    expect(total).toBe(hits.length)
    expect(counts.get('backup')).toBeGreaterThan(0)
  })
})
