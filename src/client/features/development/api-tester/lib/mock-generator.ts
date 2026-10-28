import type { MockLanguage } from '@shared/development/api-tester/keywords'
import { MOCK_COMMON, MOCK_EN, MOCK_ZH } from '@shared/development/api-tester/mock-data'

/** Reference-compatible alias; the shared keyword module owns the actual union. */
export type MockLang = MockLanguage

/**
 * Mock data generator.
 *
 * Replaces `{{mock:type}}` placeholders with realistic random values. The Chinese and English data
 * pools live in `@shared/development/api-tester/mock-data` because they are sample data rather than
 * interface copy.
 *
 * Usage:
 *   generateMock('{"name":"{{mock:name}}","age":{{mock:int:18:65}}}', 'zh')
 */

/* ============ Random helpers ============ */
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function int(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function float(min: number, max: number, decimals = 2): number {
  const value = Math.random() * (max - min) + min
  return parseFloat(value.toFixed(decimals))
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

/* ============ Type documentation ============ */
export interface MockTypeDoc {
  type: string
  /** Suffix of `development.apitester.mock.type_<descKey>`; the UI translates it. */
  descKey: string
  /** A representative value; examples are data and stay language-neutral. */
  example: string
}

export const TYPE_DOCS: MockTypeDoc[] = [
  { type: 'name', descKey: 'name', example: 'John Smith' },
  { type: 'firstName', descKey: 'firstName', example: 'John' },
  { type: 'lastName', descKey: 'lastName', example: 'Smith' },
  { type: 'gender', descKey: 'gender', example: 'Male' },
  { type: 'age', descKey: 'age', example: '32' },
  { type: 'phone', descKey: 'phone', example: '+1-212-555-0134' },
  { type: 'email', descKey: 'email', example: 'user@example.com' },
  { type: 'idCard', descKey: 'idCard', example: '110101199001011234' },
  { type: 'uuid', descKey: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
  { type: 'address', descKey: 'address', example: '123 Main St, New York, California 10001' },
  { type: 'province', descKey: 'province', example: 'California' },
  { type: 'city', descKey: 'city', example: 'New York' },
  { type: 'district', descKey: 'district', example: 'Haidian' },
  { type: 'street', descKey: 'street', example: 'Main St' },
  { type: 'zip', descKey: 'zip', example: '10001' },
  { type: 'country', descKey: 'country', example: 'United States' },
  { type: 'company', descKey: 'company', example: 'Global Tech Inc' },
  { type: 'department', descKey: 'department', example: 'Engineering' },
  { type: 'jobTitle', descKey: 'jobTitle', example: 'Senior Engineer' },
  { type: 'industry', descKey: 'industry', example: 'Internet' },
  { type: 'salary', descKey: 'salary', example: '15000' },
  { type: 'url', descKey: 'url', example: 'https://example.com/abc' },
  { type: 'domain', descKey: 'domain', example: 'example.com' },
  { type: 'ip', descKey: 'ip', example: '192.168.1.100' },
  { type: 'ipv6', descKey: 'ipv6', example: '2001:db8::1' },
  { type: 'mac', descKey: 'mac', example: '00:1A:2B:3C:4D:5E' },
  { type: 'userAgent', descKey: 'userAgent', example: 'Mozilla/5.0 (X11; Linux x86_64)' },
  { type: 'color', descKey: 'color', example: '#FF6B6B' },
  { type: 'int:min:max', descKey: 'int', example: '{{mock:int:1:100}}' },
  { type: 'float:min:max:d', descKey: 'float', example: '{{mock:float:0:1:4}}' },
  { type: 'bool', descKey: 'bool', example: 'true / false' },
  { type: 'date', descKey: 'date', example: '2024-03-15' },
  { type: 'datetime', descKey: 'datetime', example: '2024-03-15T14:30:00Z' },
  { type: 'timestamp', descKey: 'timestamp', example: '1710502200' },
  { type: 'time', descKey: 'time', example: '14:30:00' },
  { type: 'word', descKey: 'word', example: 'hello' },
  { type: 'sentence', descKey: 'sentence', example: 'The weather is beautiful today.' },
  { type: 'paragraph', descKey: 'paragraph', example: 'Multiple sentences.' },
  { type: 'text:min:max', descKey: 'text', example: '{{mock:text:10:50}}' },
  { type: 'pick:a,b,c', descKey: 'pick', example: '{{mock:pick:red,green,blue}}' },
  { type: 'array:type:n', descKey: 'array', example: '{{mock:array:name:3}}' },
  { type: 'image:w:h', descKey: 'image', example: 'https://picsum.photos/seed/1/200/200' },
  { type: 'avatar', descKey: 'avatar', example: 'https://i.pravatar.cc/150?img=1' },
  { type: 'status', descKey: 'status', example: '200' },
  { type: 'price:min:max', descKey: 'price', example: '99.99' },
  { type: 'emoji', descKey: 'emoji', example: MOCK_ZH.emoji[0] ?? '' },
]

/* ============ Generators ============ */
// House-number suffix used by Chinese addresses; kept as a code point so this client file stays
// free of Han literals while the shared pools own the rest of the sample data.
const ADDRESS_HOUSE_SUFFIX = String.fromCodePoint(0x53f7)

function genName(lang: MockLanguage): string {
  if (lang === 'zh') {
    return pick(MOCK_ZH.surnames) + pick(MOCK_ZH.givenNamesM.concat(MOCK_ZH.givenNamesF))
  }
  return pick(MOCK_EN.givenNamesM.concat(MOCK_EN.givenNamesF)) + ' ' + pick(MOCK_EN.surnames)
}

function genFirstName(lang: MockLanguage): string {
  if (lang === 'zh') return pick(MOCK_ZH.givenNamesM.concat(MOCK_ZH.givenNamesF))
  return pick(MOCK_EN.givenNamesM.concat(MOCK_EN.givenNamesF))
}

function genLastName(lang: MockLanguage): string {
  if (lang === 'zh') return pick(MOCK_ZH.surnames)
  return pick(MOCK_EN.surnames)
}

function genPhone(lang: MockLanguage): string {
  if (lang === 'zh') {
    const prefixes = ['133', '135', '137', '138', '139', '150', '151', '152', '158', '159', '180', '181', '182', '183', '185', '186', '187', '188', '189', '199']
    return pick(prefixes) + pad(int(0, 99999999), 8)
  }
  return `+1-${int(200, 999)}-${int(200, 999)}-${pad(int(0, 9999), 4)}`
}

function genEmail(lang: MockLanguage): string {
  const name =
    lang === 'zh'
      ? pick(MOCK_ZH.givenNamesM).toLowerCase() + int(1, 999)
      : pick(MOCK_EN.givenNamesM).toLowerCase() + '.' + pick(MOCK_EN.surnames).toLowerCase()
  return `${name}@${pick(MOCK_COMMON.emailDomains)}`
}

function genIdCard(): string {
  // Simplified Chinese ID card number: format only, no checksum validation.
  const region = pad(int(110000, 659004), 6)
  const year = int(1960, 2005)
  const month = pad(int(1, 12), 2)
  const day = pad(int(1, 28), 2)
  const sequence = pad(int(0, 999), 3)
  const checksum = pick('0123456789X'.split(''))
  return `${region}${year}${month}${day}${sequence}${checksum}`
}

function genAddress(lang: MockLanguage): string {
  if (lang === 'zh') {
    return pick(MOCK_ZH.provinces) + pick(MOCK_ZH.cities) + pick(MOCK_ZH.districts) + pick(MOCK_ZH.streets) + int(1, 999) + ADDRESS_HOUSE_SUFFIX
  }
  return `${int(100, 9999)} ${pick(MOCK_EN.streets)}, ${pick(MOCK_EN.cities)}, ${pick(MOCK_EN.provinces)} ${pad(int(10000, 99999), 5)}`
}

function genCompany(lang: MockLanguage): string {
  if (lang === 'zh') {
    return pick(MOCK_ZH.companyPrefix) + pick(MOCK_ZH.companies) + pick(MOCK_ZH.companySuffix)
  }
  return pick(MOCK_EN.companyPrefix) + ' ' + pick(MOCK_EN.companies) + ' ' + pick(MOCK_EN.companySuffix)
}

function genUrl(): string {
  return `https://${pick(MOCK_COMMON.imageCategories)}.${pick(['com', 'io', 'net', 'dev'])}${'/' + pick(MOCK_COMMON.imageCategories)}/${int(1, 9999)}`
}

function genDomain(): string {
  const name = pick(MOCK_COMMON.imageCategories) + pick(['hub', 'lab', 'app', 'io', 'tech', 'pro'])
  return `${name}${pick(MOCK_COMMON.tlds)}`
}

function genIp(): string {
  return `${int(1, 255)}.${int(0, 255)}.${int(0, 255)}.${int(1, 255)}`
}

function genIpv6(): string {
  const groups: string[] = []
  for (let index = 0; index < 8; index++) groups.push(int(0, 65535).toString(16))
  return groups.join(':')
}

function genMac(): string {
  const parts: string[] = []
  for (let index = 0; index < 6; index++) {
    parts.push(int(0, 255).toString(16).padStart(2, '0').toUpperCase())
  }
  return parts.join(':')
}

function genUserAgent(): string {
  const browsers = [
    'Chrome/120.0.0.0 Safari/537.36',
    'Firefox/121.0',
    'Edge/120.0.0.0 Chrome/120.0.0.0 Safari/537.36',
    'Safari/605.1.15 Version/17.1',
  ]
  const systems = [
    'Windows NT 10.0; Win64; x64',
    'Macintosh; Intel Mac OS X 10_15_7',
    'X11; Linux x86_64',
    'iPhone; CPU iPhone OS 17_1 like Mac OS X',
    'Android 14; Pixel 8',
  ]
  return `Mozilla/5.0 (${pick(systems)}) AppleWebKit/537.36 (KHTML, like Gecko) ${pick(browsers)}`
}

function genDate(): string {
  const year = int(2000, 2025)
  const month = pad(int(1, 12), 2)
  const day = pad(int(1, 28), 2)
  return `${year}-${month}-${day}`
}

function genDatetime(): string {
  const year = int(2000, 2025)
  const month = pad(int(1, 12), 2)
  const day = pad(int(1, 28), 2)
  const hour = pad(int(0, 23), 2)
  const minute = pad(int(0, 59), 2)
  const second = pad(int(0, 59), 2)
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
}

function genTimestamp(): string {
  return String(int(946684800, 1893456000)) // 2000-01-01 through 2030-01-01
}

function genTime(): string {
  return `${pad(int(0, 23), 2)}:${pad(int(0, 59), 2)}:${pad(int(0, 59), 2)}`
}

function genWord(lang: MockLanguage): string {
  return lang === 'zh' ? pick(MOCK_ZH.textWords) : pick(MOCK_EN.textWords)
}

function genSentence(lang: MockLanguage): string {
  return lang === 'zh' ? pick(MOCK_ZH.sentences) : pick(MOCK_EN.sentences)
}

function genParagraph(lang: MockLanguage): string {
  const count = int(3, 6)
  const sentences: string[] = []
  for (let index = 0; index < count; index++) {
    sentences.push(lang === 'zh' ? pick(MOCK_ZH.sentences) : pick(MOCK_EN.sentences))
  }
  return sentences.join(lang === 'zh' ? '' : ' ')
}

function genText(lang: MockLanguage, min: number, max: number): string {
  const words = lang === 'zh' ? MOCK_ZH.textWords : MOCK_EN.textWords
  const count = int(min, max)
  const picked: string[] = []
  for (let index = 0; index < count; index++) picked.push(pick(words))
  return picked.join(lang === 'zh' ? '' : ' ')
}

function genImage(width: number, height: number): string {
  const seed = int(1, 1000)
  return `https://picsum.photos/seed/${seed}/${width}/${height}`
}

function genAvatar(): string {
  return `https://i.pravatar.cc/150?img=${int(1, 70)}`
}

function genStatus(): { code: number; text: string } {
  const code = pick(MOCK_COMMON.httpStatus)
  return { code, text: MOCK_COMMON.httpStatusText[code] || '' }
}

function genPrice(min: number, max: number): string {
  return float(min, max, 2).toFixed(2)
}

function genSalary(lang: MockLanguage): string {
  if (lang === 'zh') return String(int(5000, 50000))
  return float(3000, 20000, 2).toFixed(2)
}

const countryNames = new Map<MockLanguage, string>()

function genCountry(lang: MockLanguage): string {
  const cached = countryNames.get(lang)
  if (cached) return cached
  const region = lang === 'zh' ? 'CN' : 'US'
  const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([lang], { type: 'region' }) : null
  const name = names?.of(region) ?? region
  countryNames.set(lang, name)
  return name
}

function randomUuid(): string {
  const generator = globalThis.crypto?.randomUUID
  if (typeof generator === 'function') return generator.call(globalThis.crypto)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

/** Generate one mock value. */
function genValue(typeString: string, lang: MockLanguage): unknown {
  const parts = typeString.split(':')
  const type = parts[0]
  const args = parts.slice(1)

  switch (type) {
    case 'name':
      return genName(lang)
    case 'firstName':
      return genFirstName(lang)
    case 'lastName':
      return genLastName(lang)
    case 'gender':
      return lang === 'zh' ? pick(MOCK_ZH.genders) : pick(MOCK_EN.genders)
    case 'age':
      return int(18, 65)
    case 'phone':
      return genPhone(lang)
    case 'email':
      return genEmail(lang)
    case 'idCard':
      return genIdCard()
    case 'uuid':
      return randomUuid()
    case 'address':
      return genAddress(lang)
    case 'province':
      return lang === 'zh' ? pick(MOCK_ZH.provinces) : pick(MOCK_EN.provinces)
    case 'city':
      return lang === 'zh' ? pick(MOCK_ZH.cities) : pick(MOCK_EN.cities)
    case 'district':
      return pick(MOCK_ZH.districts)
    case 'street':
      return lang === 'zh' ? pick(MOCK_ZH.streets) : pick(MOCK_EN.streets)
    case 'zip':
      return lang === 'zh' ? pad(int(100000, 659000), 6) : pad(int(10000, 99999), 5)
    case 'country':
      return genCountry(lang)
    case 'company':
      return genCompany(lang)
    case 'department':
      return lang === 'zh' ? pick(MOCK_ZH.departments) : pick(MOCK_EN.departments)
    case 'jobTitle':
      return lang === 'zh' ? pick(MOCK_ZH.jobTitles) : pick(MOCK_EN.jobTitles)
    case 'industry':
      return lang === 'zh' ? pick(MOCK_ZH.industries) : pick(MOCK_EN.industries)
    case 'salary':
      return genSalary(lang)
    case 'url':
      return genUrl()
    case 'domain':
      return genDomain()
    case 'ip':
      return genIp()
    case 'ipv6':
      return genIpv6()
    case 'mac':
      return genMac()
    case 'userAgent':
      return genUserAgent()
    case 'color':
      return pick(MOCK_COMMON.colors)
    case 'int':
      return int(Number(args[0]) || 0, Number(args[1]) || 100)
    case 'float':
      return float(Number(args[0]) || 0, Number(args[1]) || 1, Number(args[2]) || 2)
    case 'bool':
      return Math.random() < 0.5
    case 'date':
      return genDate()
    case 'datetime':
      return genDatetime()
    case 'timestamp':
      return genTimestamp()
    case 'time':
      return genTime()
    case 'word':
      return genWord(lang)
    case 'sentence':
      return genSentence(lang)
    case 'paragraph':
      return genParagraph(lang)
    case 'text':
      return genText(lang, Number(args[0]) || 10, Number(args[1]) || 50)
    case 'pick': {
      const options = args.join(':').split(',')
      return options.length > 0 ? pick(options) : ''
    }
    case 'array': {
      const itemType = args[0] || 'name'
      const count = Number(args[1]) || 3
      const values: unknown[] = []
      for (let index = 0; index < count; index++) values.push(genValue(itemType, lang))
      return values
    }
    case 'image':
      return genImage(Number(args[0]) || 200, Number(args[1]) || 200)
    case 'avatar':
      return genAvatar()
    case 'status':
      return genStatus().code
    case 'price':
      return genPrice(Number(args[0]) || 0, Number(args[1]) || 1000)
    case 'emoji':
      return pick(lang === 'zh' ? MOCK_ZH.emoji : MOCK_EN.emoji)
    default:
      return `{{mock:${typeString}}}`
  }
}

/**
 * Replace `{{mock:type}}` placeholders in a template.
 *
 * String values are inserted as-is; numbers, booleans and arrays become bare JSON values. This
 * matches the reference implementation and is intended for non-JSON templates.
 */
export function generateMock(template: string, lang: MockLanguage = 'zh'): string {
  const pattern = /\{\{mock:([^}]+)\}\}/g
  return template.replace(pattern, (_match, typeString: string) => {
    const value = genValue(typeString.trim(), lang)
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  })
}

/**
 * JSON-aware replacement: quoted string placeholders keep valid JSON quoting, while numeric,
 * boolean and array placeholders become bare values.
 */
export function generateMockJson(template: string, lang: MockLanguage = 'zh'): string {
  let result = template

  // Quoted placeholder: replace the whole quoted span.
  result = result.replace(/"(\{\{mock:([^}]+)\}\})"/g, (_match, _full, typeString: string) => {
    const value = genValue(typeString.trim(), lang)
    return JSON.stringify(value)
  })

  // Unquoted placeholder: a string value gets quotes, everything else stays a bare value.
  result = result.replace(/(?<!")\{\{mock:([^}]+)\}\}(?!")/g, (_match, typeString: string) => {
    const value = genValue(typeString.trim(), lang)
    return JSON.stringify(value)
  })

  return result
}

/** Example template shown by the mock generator dialog. */
export function exampleTemplate(_lang: MockLanguage = 'zh'): string {
  return JSON.stringify(
    {
      id: '{{mock:uuid}}',
      name: '{{mock:name}}',
      gender: '{{mock:gender}}',
      age: '{{mock:int:18:65}}',
      email: '{{mock:email}}',
      phone: '{{mock:phone}}',
      avatar: '{{mock:avatar}}',
      address: '{{mock:address}}',
      company: '{{mock:company}}',
      department: '{{mock:department}}',
      jobTitle: '{{mock:jobTitle}}',
      salary: '{{mock:salary}}',
      isActive: '{{mock:bool}}',
      registerDate: '{{mock:datetime}}',
      lastLogin: '{{mock:timestamp}}',
      score: '{{mock:float:0:100:1}}',
      tags: '{{mock:array:word:3}}',
      status: '{{mock:status}}',
      website: '{{mock:url}}',
      ip: '{{mock:ip}}',
      color: '{{mock:color}}',
      description: '{{mock:sentence}}',
    },
    null,
    2,
  )
}
