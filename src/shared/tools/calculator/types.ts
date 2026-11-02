import type {
  AngleMode,
  CalculatorMode,
  CalculatorView,
  GraphLineStyle,
  Radix,
  TrigMode,
  WordSize,
} from './contract'

export interface RationalValue {
  n: string
  d: string
}

export type ExpressionTokenType = 'operand' | 'operator' | 'separator'

export interface ExpressionToken {
  text: string
  commandIndex: number
  type: ExpressionTokenType
  editable: boolean
}

export interface CalculatorDisplayState {
  primary: string
  isError: boolean
  isBinaryOperatorPending: boolean
  expressionTokens: ExpressionToken[]
  parenthesisCount: number
  memory: string[]
  history: HistoryEntry[]
  mode: CalculatorMode
  radix: Radix
  wordSize: WordSize
  programmer: {
    hex: string
    dec: string
    oct: string
    bin: string
  }
  bitFlip: boolean
  binaryDigits: boolean[]
  isFToEEnabled: boolean
  angleMode: AngleMode
  shift: boolean
  hyp: boolean
}

export interface HistoryEntry {
  id: string
  mode: Exclude<CalculatorMode, 'programmer'>
  expression: string
  result: string
  tokens: ExpressionToken[]
  commands: number[]
  radix: number
  createdAt: number
}

export interface MemoryEntry {
  id: string
  value: RationalValue
  sort: number
  createdAt: number
}

export interface EngineSnapshot {
  version: 1
  mode: CalculatorMode
  history: HistoryEntry[]
  memory: MemoryEntry[]
  displayCommands: number[]
  radix: Radix
  wordSize: WordSize
  angleMode: AngleMode
}

export interface CalculatorSettings {
  defaultView: CalculatorView
  angleMode: AngleMode
  graphTheme: 'light' | 'match_app'
  graphLineWidth: number
  graphXMin: number
  graphXMax: number
  graphYMin: number
  graphYMax: number
  updatedAt?: number
}

export interface GraphEquation {
  id: string
  expression: string
  colorIndex: number
  lineStyle: GraphLineStyle
  isEnabled: boolean
}

export interface GraphVariable {
  name: string
  value: number
  min: number
  max: number
  step: number
}

export interface GraphViewport {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface GraphSession {
  equations: GraphEquation[]
  variables: GraphVariable[]
  viewport: GraphViewport
  updatedAt?: number
}

export interface UnitCategoryDef {
  id: string
  nameKey: string
  supportsNegative: boolean
  order: number
}

export interface UnitDef {
  id: number
  categoryId: string
  nameKey: string
  abbrKey: string
  order: number
  factor?: number
  isConversionSource?: boolean
  isConversionTarget?: boolean
  isWhimsical?: boolean
  regions?: readonly string[]
}

export interface UnitPreference {
  categoryId: string
  fromUnitId: number
  toUnitId: number
  updatedAt?: number
}

export interface CurrencyDef {
  id: number
  code: string
  region: string
}

export interface CurrencyRates {
  base: string
  rates: Record<string, number>
  fetchedAt: number
  cachedAt: number
  stale: boolean
  source: string
}

export interface SupplementaryResult {
  value: string
  unitId: number
  isWhimsical: boolean
}

export interface DateDifferenceResult {
  years: number
  months: number
  days: number
  totalDays: number
  sameDate: boolean
}

export interface CalculatorAsset {
  id: string
  kind: 'graph_png' | 'history_txt' | 'backup_json'
  fileFormat: 'png' | 'txt' | 'json'
  mimeType: string
  fileSize: number
  r2Key: string
  metadata: Record<string, unknown>
  createdAt: number
}

export interface GraphFeatureValue {
  titleKey: string
  values: string[]
  isText: boolean
}

export interface GraphAnalysisResult {
  error: 'none' | 'could_not_analyze' | 'not_supported' | 'variable_not_x'
  features: GraphFeatureValue[]
}

export type { AngleMode, CalculatorMode, CalculatorView, GraphLineStyle, Radix, TrigMode, WordSize }
