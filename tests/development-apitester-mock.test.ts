// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MockLanguage } from '../src/shared/development/api-tester/keywords'
import { MOCK_COMMON, MOCK_EN, MOCK_ZH } from '../src/shared/development/api-tester/mock-data'
import {
  TYPE_DOCS,
  exampleTemplate,
  generateMock,
  generateMockJson,
} from '../src/client/features/development/api-tester/lib/mock-generator'

const LANGUAGES: MockLanguage[] = ['zh', 'en']
const ZH_GIVEN = [...MOCK_ZH.givenNamesM, ...MOCK_ZH.givenNamesF]
const EN_GIVEN = [...MOCK_EN.givenNamesM, ...MOCK_EN.givenNamesF]

function fullNames(surnames: readonly string[], given: readonly string[]): Set<string> {
  const names = new Set<string>()
  for (const surname of surnames) {
    for (const name of given) names.add(surname + name)
  }
  return names
}

const ZH_NAMES = fullNames(MOCK_ZH.surnames, ZH_GIVEN)
const EN_NAMES = new Set<string>()
for (const given of EN_GIVEN) {
  for (const surname of MOCK_EN.surnames) EN_NAMES.add(`${given} ${surname}`)
}

const SAMPLE_TYPES: Record<string, string> = {
  name: 'name',
  firstName: 'firstName',
  lastName: 'lastName',
  gender: 'gender',
  age: 'age',
  phone: 'phone',
  email: 'email',
  idCard: 'idCard',
  uuid: 'uuid',
  address: 'address',
  province: 'province',
  city: 'city',
  district: 'district',
  street: 'street',
  zip: 'zip',
  country: 'country',
  company: 'company',
  department: 'department',
  jobTitle: 'jobTitle',
  industry: 'industry',
  salary: 'salary',
  url: 'url',
  domain: 'domain',
  ip: 'ip',
  ipv6: 'ipv6',
  mac: 'mac',
  userAgent: 'userAgent',
  color: 'color',
  'int:min:max': 'int:2:5',
  'float:min:max:d': 'float:2:4:2',
  bool: 'bool',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'timestamp',
  time: 'time',
  word: 'word',
  sentence: 'sentence',
  paragraph: 'paragraph',
  'text:min:max': 'text:3:6',
  'pick:a,b,c': 'pick:red,green,blue',
  'array:type:n': 'array:word:3',
  'image:w:h': 'image:120:80',
  avatar: 'avatar',
  status: 'status',
  'price:min:max': 'price:10:20',
  emoji: 'emoji',
}

function readMock(type: string, lang: MockLanguage): unknown {
  const template = JSON.stringify({ value: `{{mock:${type}}}` })
  const parsed = JSON.parse(generateMockJson(template, lang)) as { value: unknown }
  return parsed.value
}

function asString(value: unknown): string {
  expect(typeof value).toBe('string')
  return value as string
}

function asNumber(value: unknown): number {
  expect(typeof value).toBe('number')
  return value as number
}

function oneOf(value: unknown, pool: readonly string[]): void {
  expect(typeof value).toBe('string')
  expect(pool).toContain(value as string)
}

function expectValid(type: string, value: unknown, lang: MockLanguage): void {
  switch (type) {
    case 'name':
      expect(
        (lang === 'zh' ? ZH_NAMES : EN_NAMES).has(asString(value)),
      ).toBe(true)
      break
    case 'firstName':
      oneOf(value, lang === 'zh' ? ZH_GIVEN : EN_GIVEN)
      break
    case 'lastName':
      oneOf(value, lang === 'zh' ? MOCK_ZH.surnames : MOCK_EN.surnames)
      break
    case 'gender':
      oneOf(value, lang === 'zh' ? MOCK_ZH.genders : MOCK_EN.genders)
      break
    case 'age': {
      const age = asNumber(value)
      expect(Number.isInteger(age)).toBe(true)
      expect(age).toBeGreaterThanOrEqual(18)
      expect(age).toBeLessThanOrEqual(65)
      break
    }
    case 'phone':
      expect(asString(value)).toMatch(lang === 'zh' ? /^1\d{10}$/ : /^\+1-\d{3}-\d{3}-\d{4}$/)
      break
    case 'email':
      expect(asString(value)).toMatch(
        lang === 'zh' ? /^[\u4e00-\u9fff]+\d+@[a-z0-9.-]+$/ : /^[a-z]+\.[a-z]+@[a-z0-9.-]+$/i,
      )
      break
    case 'idCard':
      expect(asString(value)).toMatch(/^\d{17}[\dX]$/)
      break
    case 'uuid':
      expect(asString(value)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      break
    case 'address': {
      const address = asString(value)
      if (lang === 'zh') {
        expect(MOCK_ZH.provinces.some((province) => address.includes(province))).toBe(true)
        expect(MOCK_ZH.districts.some((district) => address.includes(district))).toBe(true)
        expect(MOCK_ZH.streets.some((street) => address.includes(street))).toBe(true)
        expect(/\d+/.test(address)).toBe(true)
      } else {
        expect(address).toMatch(/^\d{3,4} .+, .+ \d{5}$/)
      }
      break
    }
    case 'province':
      oneOf(value, lang === 'zh' ? MOCK_ZH.provinces : MOCK_EN.provinces)
      break
    case 'city':
      oneOf(value, lang === 'zh' ? MOCK_ZH.cities : MOCK_EN.cities)
      break
    case 'district':
      oneOf(value, MOCK_ZH.districts)
      break
    case 'street':
      oneOf(value, lang === 'zh' ? MOCK_ZH.streets : MOCK_EN.streets)
      break
    case 'zip':
      expect(asString(value)).toMatch(lang === 'zh' ? /^\d{6}$/ : /^\d{5}$/)
      break
    case 'country':
      if (lang === 'zh') {
        expect(value).toBe(new Intl.DisplayNames(['zh'], { type: 'region' }).of('CN'))
      } else {
        expect(value).toBe('United States')
      }
      break
    case 'company': {
      const company = asString(value)
      const suffixes = lang === 'zh' ? MOCK_ZH.companySuffix : MOCK_EN.companySuffix
      expect(suffixes.some((suffix) => company.endsWith(suffix))).toBe(true)
      break
    }
    case 'department':
      oneOf(value, lang === 'zh' ? MOCK_ZH.departments : MOCK_EN.departments)
      break
    case 'jobTitle':
      oneOf(value, lang === 'zh' ? MOCK_ZH.jobTitles : MOCK_EN.jobTitles)
      break
    case 'industry':
      oneOf(value, lang === 'zh' ? MOCK_ZH.industries : MOCK_EN.industries)
      break
    case 'salary': {
      const salary = asString(value)
      if (lang === 'zh') {
        expect(salary).toMatch(/^\d+$/)
        expect(Number(salary)).toBeGreaterThanOrEqual(5000)
        expect(Number(salary)).toBeLessThanOrEqual(50000)
      } else {
        expect(salary).toMatch(/^\d+\.\d{2}$/)
        expect(Number(salary)).toBeGreaterThanOrEqual(3000)
        expect(Number(salary)).toBeLessThanOrEqual(20000)
      }
      break
    }
    case 'url':
      expect(asString(value)).toMatch(/^https:\/\/.+\/\d+$/)
      break
    case 'domain':
      expect(asString(value)).toMatch(/^[a-z]+\.[a-z]+$/)
      break
    case 'ip': {
      const parts = asString(value).split('.').map(Number)
      expect(parts).toHaveLength(4)
      expect(parts[0]).toBeGreaterThanOrEqual(1)
      expect(parts[3]).toBeGreaterThanOrEqual(1)
      for (const part of parts) {
        expect(Number.isInteger(part)).toBe(true)
        expect(part).toBeGreaterThanOrEqual(0)
        expect(part).toBeLessThanOrEqual(255)
      }
      break
    }
    case 'ipv6': {
      const groups = asString(value).split(':')
      expect(groups).toHaveLength(8)
      for (const group of groups) expect(group).toMatch(/^[0-9a-f]{1,4}$/)
      break
    }
    case 'mac':
      expect(asString(value)).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/)
      break
    case 'userAgent':
      expect(asString(value)).toMatch(/^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36/)
      break
    case 'color':
      oneOf(value, MOCK_COMMON.colors)
      break
    case 'int:min:max': {
      const number = asNumber(value)
      expect(Number.isInteger(number)).toBe(true)
      expect(number).toBeGreaterThanOrEqual(2)
      expect(number).toBeLessThanOrEqual(5)
      break
    }
    case 'float:min:max:d': {
      const number = asNumber(value)
      expect(Number.isFinite(number)).toBe(true)
      expect(number).toBeGreaterThanOrEqual(2)
      expect(number).toBeLessThanOrEqual(4)
      const decimals = String(number).split('.')[1]?.length ?? 0
      expect(decimals).toBeLessThanOrEqual(2)
      break
    }
    case 'bool':
      expect(typeof value).toBe('boolean')
      break
    case 'date':
      expect(asString(value)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(asString(value)))).toBe(false)
      break
    case 'datetime':
      expect(asString(value)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
      expect(Number.isNaN(Date.parse(asString(value)))).toBe(false)
      break
    case 'timestamp': {
      const timestamp = Number(asString(value))
      expect(Number.isInteger(timestamp)).toBe(true)
      expect(timestamp).toBeGreaterThanOrEqual(946684800)
      expect(timestamp).toBeLessThanOrEqual(1893456000)
      break
    }
    case 'time':
      expect(asString(value)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
      break
    case 'word':
      oneOf(value, lang === 'zh' ? MOCK_ZH.textWords : MOCK_EN.textWords)
      break
    case 'sentence':
      oneOf(value, lang === 'zh' ? MOCK_ZH.sentences : MOCK_EN.sentences)
      break
    case 'paragraph': {
      const paragraph = asString(value)
      expect(paragraph.length).toBeGreaterThan(0)
      if (lang === 'en') {
        const count = paragraph.split('. ').length
        expect(count).toBeGreaterThanOrEqual(3)
        expect(count).toBeLessThanOrEqual(6)
      }
      break
    }
    case 'text:min:max': {
      const text = asString(value)
      expect(text.length).toBeGreaterThan(0)
      if (lang === 'en') {
        const count = text.split(' ').length
        expect(count).toBeGreaterThanOrEqual(3)
        expect(count).toBeLessThanOrEqual(6)
      }
      break
    }
    case 'pick:a,b,c':
      expect(['red', 'green', 'blue']).toContain(asString(value))
      break
    case 'array:type:n': {
      expect(Array.isArray(value)).toBe(true)
      const array = value as unknown[]
      expect(array).toHaveLength(3)
      for (const item of array) oneOf(item, lang === 'zh' ? MOCK_ZH.textWords : MOCK_EN.textWords)
      break
    }
    case 'image:w:h':
      expect(asString(value)).toMatch(/^https:\/\/picsum\.photos\/seed\/\d+\/120\/80$/)
      break
    case 'avatar':
      expect(asString(value)).toMatch(/^https:\/\/i\.pravatar\.cc\/150\?img=\d+$/)
      break
    case 'status':
      expect(MOCK_COMMON.httpStatus).toContain(asNumber(value))
      break
    case 'price:min:max': {
      const price = asString(value)
      expect(price).toMatch(/^\d+\.\d{2}$/)
      expect(Number(price)).toBeGreaterThanOrEqual(10)
      expect(Number(price)).toBeLessThanOrEqual(20)
      break
    }
    case 'emoji':
      oneOf(value, lang === 'zh' ? MOCK_ZH.emoji : MOCK_EN.emoji)
      break
    default:
      throw new Error(`Missing validator for mock type: ${type}`)
  }
}

describe('mock generator', () => {
  it('documents 46 types with i18n suffixes and neutral examples', () => {
    expect(TYPE_DOCS).toHaveLength(46)
    expect(new Set(TYPE_DOCS.map((doc) => doc.type)).size).toBe(46)
    expect(new Set(TYPE_DOCS.map((doc) => doc.descKey)).size).toBe(46)
    for (const doc of TYPE_DOCS) {
      expect(doc.descKey).toMatch(/^[A-Za-z][A-Za-z0-9]*$/)
      expect(doc.example.length).toBeGreaterThan(0)
      expect(doc.example).not.toMatch(/[\u4e00-\u9fff]/)
      expect('desc' in doc).toBe(false)
      expect(SAMPLE_TYPES[doc.type]).toBeTruthy()
    }
  })

  it('generates a valid value for every documented type in both languages', () => {
    for (const doc of TYPE_DOCS) {
      const sample = SAMPLE_TYPES[doc.type] as string
      for (const lang of LANGUAGES) {
        const value = readMock(sample, lang)
        expect(value, `${doc.type} (${lang})`).not.toBeUndefined()
        expect(String(value), `${doc.type} (${lang})`).not.toContain('{{mock:')
        expectValid(doc.type, value, lang)
      }
    }
  })

  it('keeps JSON quoting correct for quoted and unquoted placeholders', () => {
    const output = generateMockJson(
      '{"name": "{{mock:name}}", "age": "{{mock:int:18:65}}", "active": "{{mock:bool}}", ' +
        '"tags": "{{mock:array:word:2}}", "score": {{mock:float:0:1:2}}, "label": {{mock:word}}}',
      'en',
    )
    const parsed = JSON.parse(output) as {
      name: unknown
      age: unknown
      active: unknown
      tags: unknown
      score: unknown
      label: unknown
    }
    expect(typeof parsed.name).toBe('string')
    expect(EN_GIVEN.some((given) => (parsed.name as string).startsWith(given))).toBe(true)
    expect(Number.isInteger(parsed.age as number)).toBe(true)
    expect(parsed.age as number).toBeGreaterThanOrEqual(18)
    expect(parsed.age as number).toBeLessThanOrEqual(65)
    expect(typeof parsed.active).toBe('boolean')
    expect(Array.isArray(parsed.tags)).toBe(true)
    expect(parsed.tags).toHaveLength(2)
    expect(typeof parsed.score).toBe('number')
    expect(typeof parsed.label).toBe('string')
    expect(MOCK_EN.textWords).toContain(parsed.label)
  })

  it('uses the Chinese and English pools for names, words and sentences', () => {
    const zhName = generateMock('{{mock:name}}', 'zh')
    const enName = generateMock('{{mock:name}}', 'en')
    expect(ZH_NAMES.has(zhName)).toBe(true)
    expect(EN_NAMES.has(enName)).toBe(true)
    expect(zhName).toMatch(/[\u4e00-\u9fff]/)
    expect(generateMock('{{mock:word}}', 'zh')).toMatch(/[\u4e00-\u9fff]/)
    expect(MOCK_EN.textWords).toContain(generateMock('{{mock:word}}', 'en'))
    expect(MOCK_EN.sentences).toContain(generateMock('{{mock:sentence}}', 'en'))
  })

  it('honours int, float, pick and array arguments', () => {
    expect(readMock('int:10:10', 'en')).toBe(10)
    expect(readMock('float:1:1:2', 'en')).toBe(1)
    expect(generateMock('{{mock:int:7:7}}', 'en')).toBe('7')
    expect(generateMock('{{mock:pick:fixed}}', 'en')).toBe('fixed')
    expect(readMock('pick:only', 'en')).toBe('only')

    const integers = readMock('array:int:3', 'en') as unknown[]
    expect(integers).toHaveLength(3)
    for (const value of integers) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
  })

  it('produces a parseable example template for both languages', () => {
    for (const lang of LANGUAGES) {
      const parsed = JSON.parse(generateMockJson(exampleTemplate(lang), lang)) as Record<string, unknown>
      expect(Object.keys(parsed)).toHaveLength(22)
      expect(typeof parsed.id).toBe('string')
      expect(typeof parsed.age).toBe('number')
      expect(typeof parsed.isActive).toBe('boolean')
      expect(Array.isArray(parsed.tags)).toBe(true)
      expect(parsed.tags).toHaveLength(3)
      expect(typeof parsed.score).toBe('number')
      expect(MOCK_COMMON.colors).toContain(parsed.color)
    }
  })

  it('leaves unknown types untouched and quotes them in JSON output', () => {
    expect(generateMock('{{mock:nope}}', 'en')).toBe('{{mock:nope}}')
    expect(generateMockJson('{"value": {{mock:nope}}}', 'en')).toBe('{"value": "{{mock:nope}}"}')
  })
})
