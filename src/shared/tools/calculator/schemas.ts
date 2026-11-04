import { z } from 'zod'
import {
  ANGLE_MODES,
  BACKUP_MAX_BYTES,
  EQUATION_COLOR_COUNT,
  EXPRESSION_MAX_LENGTH,
  EXPRESSION_MAX_TOKENS,
  GRAPH_LINE_STYLES,
  MEMORY_LIMIT,
  MAX_EQUATIONS,
} from './contract'

const ModeSchema = z.enum(['standard', 'scientific'])
const AngleSchema = z.enum(ANGLE_MODES)
const ViewSchema = z.enum(['standard', 'scientific', 'programmer', 'date', 'unit', 'currency', 'graph', 'kinship', 'textcalc', 'settings'])
const RadixSchema = z.union([z.literal(16), z.literal(10), z.literal(8), z.literal(2)])
const WordSizeSchema = z.union([z.literal(64), z.literal(32), z.literal(16), z.literal(8)])

export const RationalValueSchema = z.object({
  n: z.string().regex(/^-?\d{1,200}$/),
  d: z.string().regex(/^[1-9]\d{0,199}$/),
})

export const ExpressionTokenSchema = z.object({
  text: z.string().max(4096),
  commandIndex: z.number().int().min(-1).max(10000),
  type: z.enum(['operand', 'operator', 'separator']),
  editable: z.boolean(),
})

export const HistoryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{3,60}$/i),
  mode: ModeSchema,
  expression: z.string().min(1).max(EXPRESSION_MAX_LENGTH),
  result: z.string().max(2048),
  tokens: z.array(ExpressionTokenSchema).max(EXPRESSION_MAX_TOKENS).default([]),
  commands: z.array(z.number().int()).max(EXPRESSION_MAX_TOKENS).default([]),
  radix: RadixSchema.default(10),
  createdAt: z.number().int().nonnegative(),
})

export const MemoryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{3,60}$/i),
  value: RationalValueSchema,
  sort: z.number().int().default(0),
  createdAt: z.number().int().nonnegative(),
})

export const CalculatorSettingsSchema = z.object({
  defaultView: ViewSchema.default('standard'),
  angleMode: AngleSchema.default('deg'),
  graphTheme: z.enum(['light', 'match_app']).default('match_app'),
  graphLineWidth: z.number().int().min(1).max(4).default(2),
  graphXMin: z.number().finite().default(-10),
  graphXMax: z.number().finite().default(10),
  graphYMin: z.number().finite().default(-10),
  graphYMax: z.number().finite().default(10),
})

export const UpdateCalculatorSettingsSchema = z.object({
  defaultView: ViewSchema.optional(),
  angleMode: AngleSchema.optional(),
  graphTheme: z.enum(['light', 'match_app']).optional(),
  graphLineWidth: z.number().int().min(1).max(4).optional(),
  graphXMin: z.number().finite().optional(),
  graphXMax: z.number().finite().optional(),
  graphYMin: z.number().finite().optional(),
  graphYMax: z.number().finite().optional(),
})

export const GraphEquationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{3,60}$/i),
  expression: z.string().max(2048),
  colorIndex: z.number().int().min(0).max(EQUATION_COLOR_COUNT - 1),
  lineStyle: z.enum(GRAPH_LINE_STYLES),
  isEnabled: z.boolean(),
})

export const GraphVariableSchema = z.object({
  name: z.string().regex(/^[a-wyz]$/),
  value: z.number().finite(),
  min: z.number().finite(),
  max: z.number().finite(),
  step: z.number().finite().positive(),
})

export const GraphViewportSchema = z.object({
  xMin: z.number().finite(),
  xMax: z.number().finite(),
  yMin: z.number().finite(),
  yMax: z.number().finite(),
})

export const GraphSessionSchema = z.object({
  equations: z.array(GraphEquationSchema).max(MAX_EQUATIONS).default([]),
  variables: z.array(GraphVariableSchema).max(26).default([]),
  viewport: GraphViewportSchema.default({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 }),
})

export const UnitPreferenceSchema = z.object({
  categoryId: z.string().max(32),
  fromUnitId: z.number().int().positive(),
  toUnitId: z.number().int().positive(),
})

export const UnitPreferencesSchema = z.array(UnitPreferenceSchema).max(13)

export const MemoryListSchema = z.array(MemoryEntrySchema).max(MEMORY_LIMIT * 5)

export const AssetKindSchema = z.enum(['graph_png', 'history_txt', 'backup_json'])
export const AssetFormatSchema = z.enum(['png', 'txt', 'json'])

export const UploadAssetSchema = z.object({
  kind: AssetKindSchema,
  fileFormat: AssetFormatSchema,
  dataBase64: z.string().min(1).max(Math.ceil((BACKUP_MAX_BYTES * 4) / 3) + 64),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const BackupSchema = z.object({
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  settings: CalculatorSettingsSchema,
  history: z.array(HistoryEntrySchema).max(40),
  memory: MemoryListSchema,
  graph: GraphSessionSchema,
  unitPreferences: UnitPreferencesSchema,
})

export const DeleteHistoryQuerySchema = z.object({
  mode: z.enum(['standard', 'scientific']).optional(),
})

export { RadixSchema, WordSizeSchema }
