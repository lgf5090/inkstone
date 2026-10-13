/**
 * Whether a new memory replaces, refines or contradicts an older one.
 *
 * The reference project's rules are English-only: it looked for the words "no longer", "moved",
 * "sold", and it split statements into words at spaces. Both assumptions fail silently on Chinese,
 * which is the language most of this app's readers write in — a Han statement has no spaces, so its
 * word sets came back as one long token and nothing ever overlapped with anything. The Han markers
 * here are what make the same judgement work in the reader's own language, and the tokeniser splits
 * Han runs into characters and adjacent pairs, which is how this app's own note index segments them.
 *
 * Every Han phrase is written as escapes because the i18n gate keeps interface copy out of `src/`.
 * These are not copy: they are the words a memory is *written with*, so they cannot come from the
 * locale catalog — a memory saved in Chinese must be recognised the same whatever language the
 * interface is currently in. Each constant is named in pinyin so the escapes stay reviewable.
 */

import type { AssistantMemory } from './assistant'

export type MemoryRelationship
  = | 'supersedes'
    | 'refines'
    | 'contradicts'
    | 'possible_update'
    | 'complements'
    | 'unrelated'
    | 'duplicate'

export interface ConflictAssessment {
  relationship: MemoryRelationship
  confidence: number
  /** A stable code, translated at render time; the reason is never stored prose. */
  reason: string
  oldMemoryId: string
}

/** Below this, nothing changes automatically: the owner decides on the Memory page instead. */
export const AUTO_SUPERSEDE_CONFIDENCE = 0.8

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'do', 'does', 'did', 'for',
  'from', 'had', 'has', 'have', 'how', 'i', 'im', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'us', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would',
  'you', 'your', 'about', 'also', 'just', 'like', 'now', 'new', 'very', 'really', 'still', 'been',
  'being', 'am', 'he', 'she', 'his', 'her', 'owner', 'user',
])

/** Words that name a feeling rather than a topic, so "likes" cannot carry an overlap alone. */
const GENERIC_WORDS = new Set([
  'like', 'likes', 'love', 'loves', 'enjoy', 'enjoys', 'prefer', 'prefers', 'old', 'good', 'great',
  'best', 'favorite', 'favourite', 'much', 'more', 'less', 'time', 'day', 'days', 'year', 'years',
  'week', 'weeks', 'month', 'months', 'always', 'never', 'usually', 'often', 'thing', 'things',
  'people', 'lot', 'want', 'need', 'going', 'got', 'get', 'make', 'made', 'use', 'used',
])

/**
 * The topicless syllables of written Chinese, listed by pronunciation: de, le, zhe, guo, hen, ye, dou,
 * shi, zai, he, wo, ni, ta, you, mei, jiu, hai, ne, ma, ge, men, xie, and the two- and three-syllable
 * shenme and zenme. Single strokes plus the particles that name no topic, so a run of them is never an
 * overlap between two memories.
 */
const HAN_STOP_CHARS = [
  '\u7684', '\u4e86', '\u7740', '\u8fc7', '\u5f88', '\u4e5f', '\u90fd', '\u662f', '\u5728', '\u548c',
  '\u6211', '\u4f60', '\u4ed6', '\u5979', '\u6709', '\u6ca1', '\u5c31', '\u8fd8', '\u5462', '\u5417',
  '\u4e2a', '\u4eec', '\u4e9b',
]

/** Two-character particles that are equally topic-free. */
const HAN_STOP_PAIRS = [
  '\u4ec0\u4e48', // shenme — what
  '\u600e\u4e48', // zenme — how
  '\u4e00\u4e2a', // yige — a
  '\u89c9\u5f97', // juede — think
  '\u53ef\u4ee5', // keyi — can
  '\u5df2\u7ecf', // yijing — already
  '\u73b0\u5728', // xianzai — now
  '\u559c\u6b22', // xihuan — like
  '\u504f\u597d', // pianhao — prefer
]

const HAN_STOP_SET = new Set([...HAN_STOP_CHARS, ...HAN_STOP_PAIRS])

const HAN_RUN = /[\p{Script=Han}]+/gu
const WORD_PATTERN = /[\p{L}\p{N}]+/gu
const HAS_HAN = /\p{Script=Han}/u

/**
 * The meaningful units of a statement.
 *
 * Latin text splits into words. A Han run has no spaces, so it contributes each character and each
 * adjacent pair — the segmentation the app's own search already uses. Skipping the stop set keeps a
 * sentence that opens with a particle from overlapping with every other sentence that opens that way.
 */
export function memoryTokens(text: string): Set<string> {
  const out = new Set<string>()
  const lowered = text.toLowerCase()
  for (const match of lowered.matchAll(HAN_RUN)) {
    const run = match[0]
    for (let index = 0; index < run.length; index++) {
      const single = run[index]!
      if (!HAN_STOP_SET.has(single)) out.add(single)
      const pair = run.slice(index, index + 2)
      if (pair.length === 2 && !HAN_STOP_SET.has(pair)) out.add(pair)
    }
  }
  for (const match of lowered.matchAll(WORD_PATTERN)) {
    const raw = match[0]
    if (HAS_HAN.test(raw) || raw.length < 3 || STOP_WORDS.has(raw) || GENERIC_WORDS.has(raw)) continue
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw)
  }
  return out
}

/** An alternation source matching any of the given phrases, used to build the marker patterns. */
function phrases(list: readonly string[]): string {
  return `(?:${list.join('|')})`
}

/** "no longer", "switched", "sold", "quit" and the rest of the wording that says a fact has changed. */
const HAN_CHANGE
  = [
    '\u4e0d\u518d', // bu zai — no longer
    '\u4e0d\u518d\u662f', // bu zai shi — is no longer
    '\u5df2\u5356', // yi mai — has sold
    '\u5356\u6389', // mai diao — sold away
    '\u5356\u4e86', // mai le — sold
    '\u6362\u6210', // huan cheng — swapped for
    '\u6539\u6210', // gai cheng — changed to
    '\u6362\u6389', // huan diao — replaced
    '\u8f9e\u804c', // ci zhi — resigned
    '\u79bb\u804c', // li zhi — left a job
    '\u8df3\u69fd', // tiao cao — changed jobs
    '\u9000\u4f11', // tui xiu — retired
    '\u88ab\u88c1', // bei cai — laid off
    '\u79bb\u5f00', // li kai — left
    '\u5206\u624b', // fen shou — broke up
    '\u79bb\u5a5a', // li hun — divorced
    '\u7ed3\u5a5a', // jie hun — married
    '\u8ba2\u5a5a', // ding hun — engaged
    '\u642c\u5bb6', // ban jia — moved house
    '\u642c\u5230', // ban dao — moved to
    '\u79fb\u5c45', // yi ju — relocated to live
    '\u5b9a\u5c45', // ding ju — settled in
    '\u653e\u5f03', // fang qi — gave up
    '\u505c\u6b62', // ting zhi — stopped
    '\u53d6\u6d88', // qu xiao — cancelled
    '\u4e0d\u5403', // bu chi — does not eat
    '\u6210\u4e86', // cheng le — has become
  ]

const EXPLICIT_CHANGE = new RegExp(
  `\\b(?:no longer|not anymore|anymore|used to|instead of|replaced|switched|changed|stopped|quit|sold|traded|got rid of|moved (?:from|away|out)|gave up)\\b|${phrases(HAN_CHANGE)}`, 'i')

interface Slot {
  name: string
  /** Search terms for finding older memories on this topic. */
  keywords: string
  about: RegExp
  change: RegExp
}

const SLOTS: Slot[] = [
  {
    name: 'residence',
    keywords: 'live lives living reside based moved relocated address city',
    about: new RegExp(
      `\\b(?:live[sd]?|living|reside[sd]?|based in|moved|relocated|address|city)\\b|${phrases([
        '\u4f4f', // zhu — live/reside
        '\u5c45\u4f4f', // ju zhu — reside
        '\u5b9a\u5c45',
        '\u642c', // ban — move
        '\u5730\u5740', // dizhi — address
        '\u57ce\u5e02', // chengshi — city
        '\u751f\u6d3b\u5728', // shenghuo zai — live in
      ])}`, 'i'),
    change: new RegExp(
      `\\b(?:moved|relocated)\\b(?!.*\\b(?:temporarily|for (?:a|the) (?:week|weekend|month|trip))\\b)|\\bno longer live\\b|\\bdon'?t live\\b|${phrases([
        '\u4e0d\u518d\u4f4f', // bu zai zhu — no longer live
        '\u642c\u5bb6',
        '\u642c\u5230',
        '\u79fb\u5c45',
        '\u79bb\u5f00',
      ])}`, 'i'),
  },
  {
    name: 'vehicle',
    keywords: 'car drive drives vehicle tesla volkswagen vw bmw toyota honda ford audi mercedes truck',
    about: new RegExp(
      `\\b(?:car|drive[sn]?|driving|vehicle|tesla|volkswagen|vw|bmw|toyota|honda|ford|audi|mercedes|truck)\\b|${phrases([
        '\u8f66', // che — car
        '\u5f00\u8f66', // kai che — drive
        '\u9a7e\u9a76', // jia shi — drive
        '\u7535\u52a8\u8f66', // diandong che — EV
        '\u81ea\u884c\u8f66', // zixingche — bicycle
        '\u6469\u6258', // motuo — motorbike
      ])}`, 'i'),
    change: new RegExp(
      `\\b(?:sold|traded|trade[ds]? in|replaced|got rid of|no longer (?:drive|own|have))\\b|${phrases([
        '\u5356\u8f66', // mai che — sold the car
        '\u6362\u8f66', // huan che — changed the car
        '\u4e0d\u518d\u5f00', // bu zai kai — no longer drives
        '\u62a5\u5e9f', // bao fei — written off
      ])}`, 'i'),
  },
  {
    name: 'job',
    keywords: 'work works job employer employed position role company',
    about: new RegExp(
      `\\b(?:work(?:s|ing)? (?:at|for|as)|job|employer|employed|position at|role at|company)\\b|${phrases([
        '\u5de5\u4f5c', // gongzuo — work
        '\u516c\u53f8', // gongsi — company
        '\u804c\u4f4d', // zhiwei — position
        '\u804c\u4e1a', // zhiye — profession
        '\u4e0a\u73ed', // shangban — go to work
        '\u96c7\u4e3b', // guzhu — employer
        '\u5c31\u4e1a', // jiuye — employed
      ])}`, 'i'),
    change: new RegExp(
      `\\b(?:new job|quit|left (?:my|the) job|started (?:a new job|working)|joined|switched jobs|was laid off|retired|no longer work)\\b|${phrases([
        '\u8f9e\u804c',
        '\u79bb\u804c',
        '\u6362\u5de5\u4f5c', // huan gongzuo — changed job
        '\u8df3\u69fd',
        '\u5165\u804c', // ru zhi — joined
        '\u9000\u4f11',
        '\u88ab\u88c1',
        '\u4e0d\u518d\u5de5\u4f5c',
      ])}`, 'i'),
  },
  {
    name: 'diet',
    keywords: 'vegetarian vegan pescatarian keto meat carnivore gluten',
    about: new RegExp(
      `\\b(?:vegetarian|vegan|pescatarian|keto|eat(?:s)? meat|carnivore|gluten[- ]free)\\b|${phrases([
        '\u7d20\u98df', // sushi — vegetarian
        '\u5403\u7d20', // chi su — eat vegetarian
        '\u7eaf\u7d20', // chun su — vegan
        '\u751f\u916e', // shengtong — keto
        '\u4e0d\u5403\u8089', // bu chi rou — no meat
        '\u9ea8\u8d28', // mai zhi — gluten
      ])}`, 'i'),
    change: new RegExp(
      `\\b(?:no longer|not anymore|stopped being|stopped eating|became|gave up|switched to)\\b|${phrases([
        '\u4e0d\u518d\u5403', // bu zai chi — no longer eats
        '\u6539\u5403', // gai chi — switched to eating
        '\u5f00\u59cb\u5403\u7d20', // kaishi chi su — went vegetarian
        '\u6212\u6389', // jie diao — quit
      ])}`, 'i'),
  },
  {
    name: 'relationship',
    keywords: 'married single divorced partner wife husband boyfriend girlfriend engaged dating',
    about: new RegExp(
      `\\b(?:married|single|divorced|partner|wife|husband|boyfriend|girlfriend|engaged|dating)\\b|${phrases([
        '\u5df2\u5a5a', // yihun — married
        '\u5355\u8eab', // danshen — single
        '\u59bb\u5b50', // qizi — wife
        '\u4e08\u592b', // zhangfu — husband
        '\u5973\u53cb', // nvyou — girlfriend
        '\u7537\u53cb', // nanyou — boyfriend
        '\u4f34\u4fa3', // banlv — partner
        '\u604b\u7231', // lianai — dating
        '\u5bf9\u8c61', // duixiang — partner
      ])}`, 'i'),
    change: new RegExp(
      `\\b(?:divorced|broke up|separated|got married|got engaged|no longer (?:married|dating|with))\\b|${phrases([
        '\u79bb\u5a5a',
        '\u5206\u624b',
        '\u7ed3\u5a5a',
        '\u8ba2\u5a5a',
        '\u590d\u5408', // fuhe — got back together
        '\u4e0d\u518d\u5728\u4e00\u8d77', // bu zai zai yiqi — no longer together
      ])}`, 'i'),
  },
]

/** Topic keywords for the single-valued topics a statement is about, used to find older candidates. */
export function slotSearchTerms(text: string): string[] {
  return SLOTS.filter((slot) => slot.about.test(text)).map((slot) => slot.keywords)
}

/**
 * How a new statement relates to an older one.
 *
 * Overlap alone never replaces anything: it takes change wording — an explicit phrase, or a topic
 * slot's own marker — that also reaches a word the old fact used, or a strict refinement that keeps
 * every word the old statement had. Anything less certain is reported, not applied, and two
 * statements that share no word at all are never treated as the same fact.
 */
export function classifyRelationship(
  newContent: string,
  old: Pick<AssistantMemory, 'id' | 'content'>,
): ConflictAssessment {
  const base = { oldMemoryId: old.id }
  const a = newContent.trim().toLowerCase()
  const b = old.content.trim().toLowerCase()
  if (a === b) return { ...base, relationship: 'duplicate', confidence: 1, reason: 'same' }

  const newTokens = memoryTokens(newContent)
  const oldTokens = memoryTokens(old.content)
  const shared = [...oldTokens].filter((token) => newTokens.has(token))
  const explicitChange = EXPLICIT_CHANGE.test(newContent)

  // The new statement names what the old one was about *and* says it changed. The shared words have
  // to cover at least half of the old statement, or "I sold my car" would retire "I like driving".
  if (explicitChange && shared.length > 0 && shared.length * 2 >= oldTokens.size) {
    return { ...base, relationship: 'supersedes', confidence: 0.95, reason: 'names_change' }
  }

  const slot = SLOTS.find((entry) => entry.about.test(newContent) && entry.about.test(old.content))
  if (slot) {
    // The change has to reach the old statement's own subject. "I sold my car" and "I like driving"
    // are both about cars and neither word of the second is in the first, so the car sale is reported
    // rather than used to retire a preference nobody retracted.
    if (shared.length > 0 && slot.change.test(newContent) && !slot.change.test(old.content)) {
      return { ...base, relationship: 'supersedes', confidence: 0.85, reason: `slot:${slot.name}` }
    }
    if (oldTokens.size > 0 && shared.length === oldTokens.size && newTokens.size > oldTokens.size) {
      return { ...base, relationship: 'refines', confidence: 0.9, reason: 'adds_detail' }
    }
    return {
      ...base,
      relationship: slot.change.test(newContent) ? 'possible_update' : 'contradicts',
      confidence: 0.6,
      reason: `both_about:${slot.name}`,
    }
  }

  if (oldTokens.size >= 2 && shared.length === oldTokens.size && newTokens.size > oldTokens.size) {
    return { ...base, relationship: 'refines', confidence: 0.9, reason: 'adds_detail' }
  }
  if (shared.length > 0) return { ...base, relationship: 'complements', confidence: 0.5, reason: 'related' }
  return { ...base, relationship: 'unrelated', confidence: 0.9, reason: 'no_overlap' }
}

/** What to do with an assessment. Automatic changes are always reversible: history is kept. */
export function decide(assessment: ConflictAssessment): 'supersede' | 'review' | 'none' {
  if ((assessment.relationship === 'supersedes' || assessment.relationship === 'refines') && assessment.confidence >= AUTO_SUPERSEDE_CONFIDENCE) {
    return 'supersede'
  }
  if (assessment.relationship === 'contradicts' || assessment.relationship === 'possible_update') return 'review'
  return 'none'
}

/** Reading a question about the past: yi qian, guoqu, yuanlai, cengjing, congqian, lishi, wangshi… */
const PAST_INTENT = new RegExp(
  `\\b(?:before|previously?|used to|formerly|former|earlier|in the past|past|history|historical|originally|back then|ago|anymore|did i (?:use|have|drive|own|live|work)|what did i|where did i|was i|were my|had i|old (?:car|job|address|home|apartment|phone))\\b|${phrases([
    '\u4ee5\u524d', // yiqian — before
    '\u4e4b\u524d', // zhiqian — earlier
    '\u8fc7\u53bb', // guoqu — past
    '\u539f\u6765', // yuanlai — originally
    '\u66fe\u7ecf', // cengjing — once
    '\u4ece\u524d', // congqian — in the past
    '\u5f80\u4e8b', // wangshi — past events
    '\u5386\u53f2', // lishi — history
    '\u5f53\u5e74', // dangnian — back then
    '\u65e9\u5e74', // zaonian — early years
  ])}`, 'i')

/** True when the question asks how things *were* — the only time past facts are recalled. */
export function hasHistoricalIntent(query: string): boolean {
  return PAST_INTENT.test(query)
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * The start date a statement says out loud ("since 2024", "2024-06-01", a Han year-month leading the
 * same way), or null.
 *
 * Only explicit statements count: an invented date would be shown back to the reader as if they had
 * written it. The Han year, month and day markers are matched as escapes for the same reason as the
 * markers above.
 */
export function extractStatedDate(text: string): string | null {
  const iso = text.match(/\b(?:since|from|as of|starting|on|in)\s+((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/i)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const month = text.match(new RegExp(`\\b(?:since|from|as of|starting|in)\\s+(${MONTHS.join('|')})\\s+((?:19|20)\\d{2})\\b`, 'i'))
  if (month) return `${month[2]}-${String(MONTHS.indexOf(month[1]!.toLowerCase()) + 1).padStart(2, '0')}`
  const full = text.match(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/)
  if (full) return `${full[1]}-${full[2]}-${full[3]}`
  const hanDate = text.match(/((?:19|20)\d{2})\u5e74\s*(0?[1-9]|1[0-2])\u6708\s*(0?[1-9]|[12]\d|3[01])\u65e5?/)
  if (hanDate) return `${hanDate[1]}-${hanDate[2]!.padStart(2, '0')}-${hanDate[3]!.padStart(2, '0')}`
  const hanMonth = text.match(/((?:19|20)\d{2})\u5e74\s*(0?[1-9]|1[0-2])\u6708/)
  if (hanMonth) return `${hanMonth[1]}-${hanMonth[2]!.padStart(2, '0')}`
  const sinceMonth = text.match(/\b(?:since|from|as of|starting|in)\s+((?:19|20)\d{2})-(0[1-9]|1[0-2])\b/i)
  if (sinceMonth) return `${sinceMonth[1]}-${sinceMonth[2]}`
  const bareMonth = text.match(/^\s*((?:19|20)\d{2})-(0[1-9]|1[0-2])\b/)
  if (bareMonth) return `${bareMonth[1]}-${bareMonth[2]}`
  const year = text.match(/\b(?:since|from|as of|starting|in)\s+((?:19|20)\d{2})\b/i)
  if (year) return year[1]!
  const hanYear = text.match(/((?:19|20)\d{2})\u5e74/)
  return hanYear ? hanYear[1]! : null
}

/** A memory as the model sees it: labelled current / unsure / past, with the dates it may use. */
export interface PromptMemory {
  content: string
  category: string
  status: 'active' | 'historical' | 'uncertain'
  note?: string
}

export function toPromptMemory(
  memory: AssistantMemory,
  lookup: (id: string) => AssistantMemory | null,
): PromptMemory {
  const notes: string[] = []
  if (memory.validFrom) notes.push(`since ${memory.validFrom}`)
  if (memory.status === 'historical') {
    if (memory.validUntil) notes.push(`until ${memory.validUntil}`)
    const successor = memory.supersededBy ? lookup(memory.supersededBy) : null
    if (successor) notes.push(`replaced by ${JSON.stringify(successor.content.slice(0, 120))}`)
  }
  return {
    content: memory.content,
    category: memory.category,
    status: memory.status,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  }
}

/**
 * Fits selected memories into a token budget, keeping the order recall chose them in.
 *
 * Skipping rather than stopping matters: one long memory must not push out three short ones the same
 * question matched more closely.
 */
export function fitMemoryBudget(
  memories: PromptMemory[],
  maxTokens: number,
  cost: (memory: PromptMemory) => number,
): PromptMemory[] {
  const out: PromptMemory[] = []
  let used = 0
  for (const memory of memories) {
    const needed = cost(memory) + 8
    if (used + needed > maxTokens) continue
    used += needed
    out.push(memory)
  }
  return out
}

/** A fifth of the context window, capped, so memories never crowd out instructions or history. */
export function memoryTokenBudget(maxContextTokens: number): number {
  return Math.min(1500, Math.floor(maxContextTokens * 0.2))
}
