/**
 * The compare tool's assistant tools.
 *
 * Both are read-only: one compares two pieces of text the reader or the model already holds, one
 * lists comparisons the reader saved. Neither creates, changes or shares anything, so the model can
 * ask them in a scheduled run as well as a chat turn.
 */
import {
  DEFAULT_TEXT_OPTIONS,
  normalizeTextOptions,
  type CompareKind,
  type TextCompareOptions,
} from '@shared/tools/compare/types'
import { computeTextDiff, formatUnifiedPatch, regexProblem, diffSummaryLine } from '@shared/tools/compare/engine'
import { CompareStore } from '../tools/compare/store'
import { ToolError, type FieldSpec, type ToolContext, type ToolDefinition } from './tools'

const MAX_COMPARE_CHARS = 60_000
const MAX_PATCH_CHARS = 8_000
const MAX_LISTED = 30

function textOf(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string') throw new ToolError(`"${name}" must be a string`)
  if (value.length > MAX_COMPARE_CHARS) throw new ToolError(`"${name}" exceeds ${MAX_COMPARE_CHARS} characters`)
  return value
}

const optionsFields: Record<string, FieldSpec> = {
  ignore_whitespace: { type: 'boolean', description: 'Treat runs of whitespace as one space and trim the edges.', optional: true },
  ignore_case: { type: 'boolean', description: 'Compare lines case-insensitively.', optional: true },
  ignore_line_endings: { type: 'boolean', description: 'Treat CRLF and LF as the same (default true).', optional: true },
  ignore_regex: { type: 'string', description: 'A JavaScript regular expression whose matches are removed before comparing.', maxLength: 256, optional: true },
}

function optionsFrom(args: Record<string, unknown>): TextCompareOptions {
  const ignoreRegex = typeof args.ignore_regex === 'string' ? args.ignore_regex : ''
  const problem = regexProblem(ignoreRegex)
  if (problem) throw new ToolError(`"ignore_regex" is not a valid regular expression: ${problem}`)
  return normalizeTextOptions({
    ...DEFAULT_TEXT_OPTIONS,
    ignoreWhitespace: Boolean(args.ignore_whitespace),
    ignoreCase: Boolean(args.ignore_case),
    ignoreLineEndings: args.ignore_line_endings === undefined ? true : Boolean(args.ignore_line_endings),
    ignoreRegex,
  })
}

export const COMPARE_TOOLS: ToolDefinition[] = [
  {
    name: 'compare_texts',
    description: 'Compare two pieces of text line by line. Returns how many lines were added, removed and changed, and a unified diff of the first changes.',
    permission: 'read',
    fields: {
      left: { type: 'string', description: 'The original text (left side).', maxLength: MAX_COMPARE_CHARS },
      right: { type: 'string', description: 'The revised text (right side).', maxLength: MAX_COMPARE_CHARS },
      ...optionsFields,
    },
    maxCallsPerTurn: 3,
    async run(args, _ctx: ToolContext) {
      const left = textOf(args, 'left')
      const right = textOf(args, 'right')
      const options = optionsFrom(args)
      const diff = computeTextDiff(left, right, options)
      const patch = formatUnifiedPatch(diff, 'left', 'right')
      return {
        identical: diff.hunks.length === 0,
        added: diff.stats.added,
        removed: diff.stats.removed,
        changed: diff.stats.changed,
        changed_blocks: diff.stats.changedBlocks,
        unchanged: diff.stats.same,
        summary: diffSummaryLine(diff.stats),
        // The patch is clipped rather than dropped: a model that needs the whole file can ask for a
        // narrower range, while a reply that carries a twenty-thousand-line patch helps nobody.
        patch: patch.length > MAX_PATCH_CHARS ? `${patch.slice(0, MAX_PATCH_CHARS)}\n… (truncated)` : patch,
      }
    },
  },
  {
    name: 'list_comparisons',
    description: 'List the comparisons the reader saved in the toolbox, newest first.',
    permission: 'read',
    fields: {
      kind: { type: 'string', description: 'Filter by kind.', enum: ['text', 'file', 'dir', 'image', 'binary'], optional: true },
      search: { type: 'string', description: 'Match part of the comparison name.', maxLength: 60, optional: true },
      limit: { type: 'integer', description: `How many to return, at most ${MAX_LISTED}.`, minimum: 1, maximum: MAX_LISTED, optional: true },
    },
    maxCallsPerTurn: 2,
    async run(args, ctx: ToolContext) {
      const limit = typeof args.limit === 'number' ? Math.min(MAX_LISTED, Math.max(1, Math.floor(args.limit))) : 10
      const kind = typeof args.kind === 'string' ? args.kind as CompareKind : null
      const search = typeof args.search === 'string' ? args.search : null
      const store = new CompareStore(ctx.env.DB, ctx.store.userId)
      const { items, total } = await store.listProjects({
        limit,
        offset: 0,
        kind,
        search,
      })
      return {
        total,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          left: item.left_label ?? item.left_filename,
          right: item.right_label ?? item.right_filename,
          added: item.summary.added ?? 0,
          removed: item.summary.removed ?? 0,
          shared: Boolean(item.share_slug),
          updated_at: item.updated_at,
        })),
      }
    },
  },
]
