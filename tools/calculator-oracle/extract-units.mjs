import fs from 'node:fs'
import path from 'node:path'

const REF = '/home/kubuntu/projects/reference/calculator'
const OUT = '/home/kubuntu/code/cloudflare/inkstone-5090-calculator'

const loaderPath = path.join(REF, 'src/Calculator.ViewModels/DataLoaders/UnitConverterDataLoader.cs')
const loader = fs.readFileSync(loaderPath, 'utf8')

const constants = new Map()
for (const match of loader.matchAll(/private const int ([A-Za-z0-9_]+) = (\d+);/g)) {
  constants.set(match[1], Number(match[2]))
}

const categoryOrder = [
  ['Currency', 'currency', false],
  ['Volume', 'volume', false],
  ['Length', 'length', false],
  ['Weight', 'weight', false],
  ['Temperature', 'temperature', true],
  ['Energy', 'energy', false],
  ['Area', 'area', false],
  ['Speed', 'speed', false],
  ['Time', 'time', false],
  ['Power', 'power', true],
  ['Data', 'data', false],
  ['Pressure', 'pressure', false],
  ['Angle', 'angle', true],
]

const categoryResource = {
  Currency: 'CategoryName_Currency',
  Volume: 'CategoryName_Volume',
  Length: 'CategoryName_Length',
  Weight: 'CategoryName_Weight',
  Temperature: 'CategoryName_Temperature',
  Energy: 'CategoryName_Energy',
  Area: 'CategoryName_Area',
  Speed: 'CategoryName_Speed',
  Time: 'CategoryName_Time',
  Power: 'CategoryName_Power',
  Data: 'CategoryName_Data',
  Pressure: 'CategoryName_Pressure',
  Angle: 'CategoryName_Angle',
}

const addUnitRe =
  /AddUnit\(ViewMode\.([A-Za-z]+),\s*([A-Za-z0-9_]+),\s*"([^"]+)",\s*"([^"]+)",\s*(\d+)([^)]*)\)/g
const units = []
for (const match of loader.matchAll(addUnitRe)) {
  const [, viewMode, constant, nameKey, abbrKey, order, rest] = match
  const id = constants.get(constant)
  if (!id) throw new Error(`Unknown unit constant ${constant}`)
  const flags = rest.split(',').map((value) => value.trim()).filter(Boolean)
  const resolveFlag = (value) => {
    if (!value) return false
    if (value === 'true') return true
    if (value === 'false') return false
    if (value.startsWith('useUSCustomary')) return true
    return false
  }
  const isSource = resolveFlag(flags[0])
  const isTarget = resolveFlag(flags[1])
  const isWhimsical = resolveFlag(flags[2])
  units.push({
    id,
    categoryId: viewMode.toLowerCase(),
    nameKey: `tools.calculator.unit.${id}.name`,
    abbrKey: `tools.calculator.unit.${id}.abbr`,
    order: Number(order),
    constant,
    resourceName: nameKey.trim(),
    resourceAbbr: abbrKey.trim(),
    isConversionSource: isSource,
    isConversionTarget: isTarget,
    isWhimsical,
  })
}

const factorBlock = /\[ViewMode\.([A-Za-z]+)\] = new Dictionary<int, double>\s*\{([\s\S]*?)\n\s*\},/g
const factors = {}
for (const match of loader.matchAll(factorBlock)) {
  const category = match[1].toLowerCase()
  const body = match[2]
  factors[category] = {}
  for (const entry of body.matchAll(/\{\s*([A-Za-z0-9_]+),\s*([-0-9.eE+]+)\s*\}/g)) {
    const id = constants.get(entry[1])
    if (!id) throw new Error(`Unknown factor constant ${entry[1]}`)
    factors[category][id] = Number(entry[2])
  }
}

const explicitBlock = /\[Temperature_([A-Za-z]+)\] = new Dictionary<int, \(double, double, bool\)>\s*\{([\s\S]*?)\n\s*\},/g
const explicit = {}
for (const match of loader.matchAll(explicitBlock)) {
  const fromId = constants.get(`Temperature_${match[1]}`)
  explicit[fromId] = {}
  for (const entry of match[2].matchAll(/\{\s*Temperature_([A-Za-z]+),\s*\(([^)]*)\)\s*\}/g)) {
    const toId = constants.get(`Temperature_${entry[1]}`)
    const parts = entry[2].split(',').map((value) => value.trim())
    explicit[fromId][toId] = {
      ratio: Number(parts[0]),
      offset: Number(parts[1]),
      offsetFirst: parts[2] === 'true',
    }
  }
}

// resw strings
function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
function parseResw(file) {
  const xml = fs.readFileSync(file, 'utf8')
  const map = new Map()
  for (const match of xml.matchAll(/<data name="([^"]+)"[^>]*>[\s\S]*?<value>([\s\S]*?)<\/value>/g)) {
    map.set(match[1], decodeXml(match[2]).trim())
  }
  return map
}
const en = parseResw(path.join(REF, 'src/Calculator/Resources/en-US/Resources.resw'))
const zh = parseResw(path.join(REF, 'src/Calculator/Resources/zh-CN/Resources.resw'))

const enEntries = {}
const zhEntries = {}
for (const [viewMode, categoryId] of categoryOrder.map(([view]) => [view, view.toLowerCase()])) {
  const resource = categoryResource[viewMode]
  const key = `tools.calculator.unit.category.${categoryId}`
  const enName = en.get(resource) ?? en.get(`${resource}Text`)
  const zhName = zh.get(resource) ?? zh.get(`${resource}Text`)
  if (enName) enEntries[key] = enName
  else enEntries[key] = viewMode
  if (zhName) zhEntries[key] = zhName
  else zhEntries[key] = enEntries[key]
}
for (const unit of units) {
  const enName = en.get(unit.resourceName)
  const enAbbr = en.get(unit.resourceAbbr)
  const zhName = zh.get(unit.resourceName)
  const zhAbbr = zh.get(unit.resourceAbbr)
  if (enName) enEntries[unit.nameKey] = enName
  if (enAbbr) enEntries[unit.abbrKey] = enAbbr
  if (zhName) zhEntries[unit.nameKey] = zhName
  else if (enName) zhEntries[unit.nameKey] = enName
  if (zhAbbr) zhEntries[unit.abbrKey] = zhAbbr
  else if (enAbbr) zhEntries[unit.abbrKey] = enAbbr
}

const categories = categoryOrder.map(([view, id, supportsNegative], index) => ({
  id,
  nameKey: `tools.calculator.unit.category.${id}`,
  supportsNegative,
  order: index,
}))

const unitLines = units
  .sort((a, b) => a.id - b.id)
  .map((unit) => {
    const bits = [
      `id: ${unit.id}`,
      `categoryId: '${unit.categoryId}'`,
      `nameKey: '${unit.nameKey}'`,
      `abbrKey: '${unit.abbrKey}'`,
      `order: ${unit.order}`,
    ]
    if (factors[unit.categoryId]?.[unit.id] !== undefined) bits.push(`factor: ${factors[unit.categoryId][unit.id]}`)
    if (unit.isConversionSource) bits.push('isConversionSource: true')
    if (unit.isConversionTarget) bits.push('isConversionTarget: true')
    if (unit.isWhimsical) bits.push('isWhimsical: true')
    return `  { ${bits.join(', ')} },`
  })

const factorEntries = Object.entries(factors)
  .map(([category, values]) => {
    const inner = Object.entries(values)
      .map(([id, value]) => `    ${id}: ${value},`)
      .join('\n')
    return `  ${category}: {\n${inner}\n  },`
  })
  .join('\n')

const explicitEntries = Object.entries(explicit)
  .map(([fromId, values]) => {
    const inner = Object.entries(values)
      .map(([toId, data]) => `    ${toId}: { ratio: ${data.ratio}, offset: ${data.offset}, offsetFirst: ${data.offsetFirst} },`)
      .join('\n')
    return `  ${fromId}: {\n${inner}\n  },`
  })
  .join('\n')

const unitsTs = `import type { UnitCategoryDef, UnitDef } from '../types'

export const UNIT_CATEGORIES: readonly UnitCategoryDef[] = [
${categories.map((category) => `  { id: '${category.id}', nameKey: '${category.nameKey}', supportsNegative: ${category.supportsNegative}, order: ${category.order} },`).join('\n')}
]

export const UNITS: readonly UnitDef[] = [
${unitLines.join('\n')}
]

export const UNIT_BY_ID: ReadonlyMap<number, UnitDef> = new Map(UNITS.map((unit) => [unit.id, unit]))

export const UNIT_FACTORS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
${factorEntries}
}

export const EXPLICIT_CONVERSIONS: Readonly<
  Record<number, Readonly<Record<number, { ratio: number; offset: number; offsetFirst: boolean }>>>
> = {
${explicitEntries}
}

export function unitsForCategory(categoryId: string): UnitDef[] {
  return UNITS.filter((unit) => unit.categoryId === categoryId).sort((left, right) => left.order - right.order)
}
`

fs.writeFileSync(path.join(OUT, 'src/shared/tools/calculator/converters/units.ts'), unitsTs)

function localeFile(name, entries, comment) {
  return `// ${comment}\nexport const ${name} = {\n${Object.entries(entries)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join('\n')}\n} as const\n`
}
fs.writeFileSync(
  path.join(OUT, 'src/shared/locales/en-US-calculator.ts'),
  localeFile('EN_US_CALCULATOR', enEntries, 'Generated from the reference calculator en-US resources.'),
)
fs.writeFileSync(
  path.join(OUT, 'src/shared/locales/zh-CN-calculator.ts'),
  localeFile('ZH_CN_CALCULATOR', zhEntries, 'Generated from the reference calculator zh-CN resources.'),
)

console.log(
  JSON.stringify(
    {
      units: units.length,
      categories: categories.length,
      factors: Object.values(factors).reduce((total, values) => total + Object.keys(values).length, 0),
      explicit: Object.keys(explicit).length,
      enKeys: Object.keys(enEntries).length,
      zhKeys: Object.keys(zhEntries).length,
    },
    null,
    2,
  ),
)
