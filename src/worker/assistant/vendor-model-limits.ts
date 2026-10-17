/**
 * What the vendors' own model pages say about an id nobody probed.
 *
 * A listing carries limits on two kinds of service and on nothing at all on the rest: Gemini answers with
 * `inputTokenLimit`/`outputTokenLimit`, an OpenAI-compatible relay answers with `context_length` when it
 * is one that publishes it, and OpenAI's own `/v1/models`, Anthropic's `/v1/models` and DeepSeek's answer
 * with ids alone. Detection from the listing alone therefore leaves most readers with no number at all,
 * and this table is the other half: the windows and output ceilings the vendors print in their model docs,
 * keyed by the id shapes people actually configure.
 *
 * An id that is not here reads as `null` — "not known" — and never as a plausible guess. A wrong output
 * ceiling is not cosmetic: it cuts the editor's ladder and warns about a number nobody confirmed, which
 * silently shortens somebody's answers. Where a vendor prints a round "128K" without saying which unit it
 * counts in, the smaller reading is stored: hiding one preset costs a reader a button, offering one the
 * provider rejects costs them the turn they thought they had asked for.
 *
 * Entries are matched against the last `/`-separated segment of the id, lowercased, so a gateway that
 * names its model `openai/gpt-4o-2024-11-20` still lands on the row for `gpt-4o`, and a dated snapshot
 * inherits the numbers its family prints.
 */

/** One model, or one family whose published numbers are the same, and what its docs say about it. */
export interface VendorLimitEntry {
  /** Matched against the id's own name, anchored at the start; the first row that matches wins. */
  pattern: RegExp
  /** The whole window the model publishes, or null when its docs do not say. */
  contextTokens: number | null
  /** The largest answer the model publishes, or null when the docs leave it out. */
  maxOutputTokens: number | null
}

export const VENDOR_LIMIT_ENTRIES: readonly VendorLimitEntry[] = [
  // OpenAI — platform.openai.com/docs/models prints "Context window" and "Max completion tokens" beside
  // each model: gpt-4o and gpt-4o-mini are 128,000 / 16,384; the gpt-4.1 line is 1,047,576 / 32,768;
  // gpt-5 is 400,000 / 128,000. The reasoning guide's table gives o3 and o4-mini 200,000 / 100,000.
  // Nothing older is listed, because those ceilings were stated differently and moved.
  { pattern: /^gpt-4o(\.|-|$)/, contextTokens: 128_000, maxOutputTokens: 16_384 },
  { pattern: /^gpt-4\.1(\-|$)/, contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  { pattern: /^gpt-5(\-|$)/, contextTokens: 400_000, maxOutputTokens: 128_000 },
  { pattern: /^o[34](?:-|$)/, contextTokens: 200_000, maxOutputTokens: 100_000 },

  // Anthropic — the models table at docs.anthropic.com gives every current Claude a 200,000 window and a
  // per-model output ceiling: 8,192 on the 3.5 line, 64,000 on 3.7 Sonnet and Sonnet 4, 32,000 on Opus 4.
  // A `claude-3`/`claude-4` id none of the named rows covers keeps the window the whole line states and
  // no output number, because that is the only figure the page gives it.
  { pattern: /^claude-3-5-/, contextTokens: 200_000, maxOutputTokens: 8192 },
  { pattern: /^claude-3-7-/, contextTokens: 200_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-sonnet-4/, contextTokens: 200_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-opus-4/, contextTokens: 200_000, maxOutputTokens: 32_000 },
  { pattern: /^claude-[34]/, contextTokens: 200_000, maxOutputTokens: null },

  // Gemini — ai.google.dev/gemini-api/docs/models publishes the same two numbers the listing route reads
  // back: 1.5 Pro 2,097,152 / 8,192, 1.5 Flash and the 2.0 line 1,048,576 / 8,192, the 2.5 line
  // 1,048,576 / 65,536. A row is only ever needed for a relay that strips those fields from the answer.
  { pattern: /^gemini-2\.5-/, contextTokens: 1_048_576, maxOutputTokens: 65_536 },
  { pattern: /^gemini-2\.0-/, contextTokens: 1_048_576, maxOutputTokens: 8192 },
  { pattern: /^gemini-1\.5-pro/, contextTokens: 2_097_152, maxOutputTokens: 8192 },
  { pattern: /^gemini-1\.5-/, contextTokens: 1_048_576, maxOutputTokens: 8192 },

  // DeepSeek — api.deepseek.com states one 128K context length for `deepseek-chat` and `deepseek-reasoner`
  // and no unit, so the smaller reading is stored. Its output ceiling is left out on purpose: the same
  // page ties the answer length to the thinking mode rather than to the model, and the two modes differ
  // by an order of magnitude, so any single number here would be wrong for one of them.
  { pattern: /^deepseek-(?:chat|reasoner|v[34])/, contextTokens: 128_000, maxOutputTokens: null },
]

/** What the published docs say about one model id, with `null` for anything nobody has stated. */
export function curatedModelLimits(modelId: string): { contextTokens: number | null, maxOutputTokens: number | null } {
  // The last segment, because a gateway prefixes the vendor's own name.
  const name = modelId.trim().toLowerCase().split('/').pop() ?? ''
  const entry = VENDOR_LIMIT_ENTRIES.find((candidate) => candidate.pattern.test(name))
  return { contextTokens: entry?.contextTokens ?? null, maxOutputTokens: entry?.maxOutputTokens ?? null }
}
