export type CalculatorMode = 'standard' | 'scientific' | 'programmer'

export type CalculatorView =
  | 'standard'
  | 'scientific'
  | 'programmer'
  | 'date'
  | 'unit'
  | 'currency'
  | 'graph'
  | 'kinship'
  | 'textcalc'
  | 'settings'

export const CALCULATOR_VIEWS: readonly CalculatorView[] = [
  'standard',
  'scientific',
  'programmer',
  'date',
  'unit',
  'currency',
  'graph',
  'kinship',
  'textcalc',
  'settings',
]

export const CALCULATOR_MODES: readonly CalculatorMode[] = ['standard', 'scientific', 'programmer']

export const HISTORY_LIMIT = 20
export const MEMORY_LIMIT = 100
export const MAX_EQUATIONS = 14
export const EQUATION_COLOR_COUNT = 14
export const EQUATION_LINE_WIDTHS = [1, 2, 3, 4] as const
export const EQUATION_DEFAULT_LINE_WIDTH = 2
export const GRAPH_DEFAULT_VIEWPORT = { xMin: -10, xMax: 10, yMin: -10, yMax: 10 } as const

export const UNIT_MAX_DIGITS = 15
export const UNIT_OPTIMAL_DIGITS = 7
export const UNIT_MIN_DECIMAL = 1e-14
export const UNIT_OPTIMAL_DECIMAL = 1e-6

export const DATE_MIN_YEAR = 1601
export const DATE_MAX_YEAR = 9999

export const EXPRESSION_MAX_LENGTH = 4096
export const EXPRESSION_MAX_TOKENS = 512
export const HISTORY_ITEM_MAX_BYTES = 32 * 1024
export const GRAPH_SESSION_MAX_BYTES = 256 * 1024
export const BACKUP_MAX_BYTES = 2 * 1024 * 1024
export const ASSET_PNG_MAX_BYTES = 2 * 1024 * 1024
export const ASSET_TEXT_MAX_BYTES = 256 * 1024
export const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,39}$/

export const CALCULATOR_R2_PREFIX = 'calculator'

export const CALCULATOR_R2_PATHS = {
  images: 'images',
  text: 'txt',
  json: 'json',
} as const

export const GRAPH_LINE_STYLES = ['solid', 'dot', 'dash', 'dash_dot', 'dash_dot_dot'] as const
export type GraphLineStyle = (typeof GRAPH_LINE_STYLES)[number]

export const GRAPH_COLORS = [
  '#d13438',
  '#0b6a0b',
  '#7a7574',
  '#ca5010',
  '#4f6bed',
  '#986f0b',
  '#038387',
  '#c239b3',
  '#8e562e',
  '#69797e',
  '#00b294',
  '#8764b8',
  '#e3008c',
  '#5d5a58',
] as const

export const WORD_SIZES = [64, 32, 16, 8] as const
export type WordSize = (typeof WORD_SIZES)[number]

export const RADICES = [16, 10, 8, 2] as const
export type Radix = (typeof RADICES)[number]

export const ANGLE_MODES = ['deg', 'rad', 'grad'] as const
export type AngleMode = (typeof ANGLE_MODES)[number]

export const TRIG_MODES = ['rad', 'deg', 'grad'] as const
export type TrigMode = (typeof TRIG_MODES)[number]

/**
 * Numeric command ids are the reference calculator's own `Command.h` values. Keeping them means a
 * golden fixture recorded from the C++ engine can be replayed by the TypeScript engine unchanged.
 */
export const CMD = {
  digit0: 130,
  digit1: 131,
  digit2: 132,
  digit3: 133,
  digit4: 134,
  digit5: 135,
  digit6: 136,
  digit7: 137,
  digit8: 138,
  digit9: 139,
  a: 140,
  b: 141,
  c: 142,
  d: 143,
  e: 144,
  f: 145,

  clear: 81,
  clearEntry: 82,
  back: 83,
  decimal: 84,
  sign: 80,
  equals: 121,
  percent: 118,

  add: 93,
  subtract: 94,
  multiply: 92,
  divide: 91,
  mod: 95,
  power: 97,
  root: 96,

  and: 86,
  or: 87,
  xor: 88,
  not: 101,
  leftShift: 89,
  rightShift: 90,
  leftShiftLogical: 505,
  rotateLeft: 99,
  rotateRight: 100,
  rotateLeftCarry: 416,
  rotateRightCarry: 417,
  nand: 501,
  nor: 502,

  sin: 102,
  cos: 103,
  tan: 104,
  sinh: 105,
  cosh: 106,
  tanh: 107,
  ln: 108,
  log: 109,
  sqrt: 110,
  square: 111,
  cube: 112,
  factorial: 113,
  reciprocal: 114,
  dms: 115,
  cubeRoot: 116,
  tenPower: 117,
  exp: 127,
  pi: 120,
  euler: 601,
  rand: 600,
  fe: 119,
  abs: 413,
  floor: 414,
  ceil: 415,

  asin: 202,
  acos: 203,
  atan: 204,
  powE: 205,
  asinh: 206,
  acosh: 207,
  atanh: 208,
  sec: 400,
  asec: 401,
  csc: 402,
  acsc: 403,
  cot: 404,
  acot: 405,
  sech: 406,
  asech: 407,
  csch: 408,
  acsch: 409,
  coth: 410,
  acoth: 411,
  twoPower: 412,
  logBaseY: 500,

  memoryClear: 122,
  memoryRecall: 123,
  memoryStore: 124,
  memoryAdd: 125,
  memorySubtract: 126,

  openParen: 128,
  closeParen: 129,

  deg: 321,
  rad: 322,
  grad: 323,
  degrees: 324,
  hyp: 325,
  modeBasic: 200,
  modeScientific: 201,
  modeProgrammer: 209,

  hex: 313,
  dec: 314,
  oct: 315,
  bin: 316,
  qword: 317,
  dword: 318,
  word: 319,
  byte: 320,

  bitFlipStart: 700,
  bitFlipEnd: 763,
} as const

export type CalculatorCommand = number

export const DIGIT_COMMANDS: readonly number[] = [
  CMD.digit0,
  CMD.digit1,
  CMD.digit2,
  CMD.digit3,
  CMD.digit4,
  CMD.digit5,
  CMD.digit6,
  CMD.digit7,
  CMD.digit8,
  CMD.digit9,
]

export const PROGRAMMER_DIGIT_COMMANDS: readonly number[] = [
  ...DIGIT_COMMANDS,
  CMD.a,
  CMD.b,
  CMD.c,
  CMD.d,
  CMD.e,
  CMD.f,
]

export const MEMORY_COMMANDS: readonly number[] = [
  CMD.memoryClear,
  CMD.memoryRecall,
  CMD.memoryStore,
  CMD.memoryAdd,
  CMD.memorySubtract,
]

export const MODE_COMMANDS: readonly number[] = [CMD.modeBasic, CMD.modeScientific, CMD.modeProgrammer]

export const VALID_REPLAY_COMMANDS: ReadonlySet<number> = new Set<number>([
  ...DIGIT_COMMANDS,
  CMD.a,
  CMD.b,
  CMD.c,
  CMD.d,
  CMD.e,
  CMD.f,
  CMD.clear,
  CMD.clearEntry,
  CMD.back,
  CMD.decimal,
  CMD.sign,
  CMD.equals,
  CMD.percent,
  CMD.add,
  CMD.subtract,
  CMD.multiply,
  CMD.divide,
  CMD.mod,
  CMD.power,
  CMD.root,
  CMD.and,
  CMD.or,
  CMD.xor,
  CMD.not,
  CMD.leftShift,
  CMD.rightShift,
  CMD.leftShiftLogical,
  CMD.rotateLeft,
  CMD.rotateRight,
  CMD.rotateLeftCarry,
  CMD.rotateRightCarry,
  CMD.nand,
  CMD.nor,
  CMD.sin,
  CMD.cos,
  CMD.tan,
  CMD.sinh,
  CMD.cosh,
  CMD.tanh,
  CMD.ln,
  CMD.log,
  CMD.sqrt,
  CMD.square,
  CMD.cube,
  CMD.factorial,
  CMD.reciprocal,
  CMD.dms,
  CMD.cubeRoot,
  CMD.tenPower,
  CMD.exp,
  CMD.pi,
  CMD.euler,
  CMD.rand,
  CMD.fe,
  CMD.abs,
  CMD.floor,
  CMD.ceil,
  CMD.asin,
  CMD.acos,
  CMD.atan,
  CMD.powE,
  CMD.asinh,
  CMD.acosh,
  CMD.atanh,
  CMD.sec,
  CMD.asec,
  CMD.csc,
  CMD.acsc,
  CMD.cot,
  CMD.acot,
  CMD.sech,
  CMD.asech,
  CMD.csch,
  CMD.acsch,
  CMD.coth,
  CMD.acoth,
  CMD.twoPower,
  CMD.logBaseY,
  CMD.openParen,
  CMD.closeParen,
  CMD.deg,
  CMD.rad,
  CMD.grad,
  CMD.hyp,
  CMD.hex,
  CMD.dec,
  CMD.oct,
  CMD.bin,
  CMD.qword,
  CMD.dword,
  CMD.word,
  CMD.byte,
])

export function isReplayableCommand(command: number): boolean {
  if (VALID_REPLAY_COMMANDS.has(command)) return true
  return command >= CMD.bitFlipStart && command <= CMD.bitFlipEnd
}

export const DEFAULT_CALCULATOR_SETTINGS = {
  defaultView: 'standard' as CalculatorView,
  angleMode: 'deg' as AngleMode,
  graphTheme: 'match_app' as 'light' | 'match_app',
  graphLineWidth: EQUATION_DEFAULT_LINE_WIDTH,
  graphXMin: GRAPH_DEFAULT_VIEWPORT.xMin,
  graphXMax: GRAPH_DEFAULT_VIEWPORT.xMax,
  graphYMin: GRAPH_DEFAULT_VIEWPORT.yMin,
  graphYMax: GRAPH_DEFAULT_VIEWPORT.yMax,
}
