/**
 * The project app's budgets, in one place so the server that enforces them and the client that
 * explains them cannot disagree about a number.
 *
 * The first three come from the reference's block model, where they were MySQL TEXT ceilings; D1 has
 * no such ceiling, but an archive exported there has to import here without truncation. The rest are
 * this port's own limits: the reference gated capacity behind a paid cloud plan, and a self-hosted
 * board needs a stated ceiling instead of an unbounded table.
 */
export const PROJECT_LIMITS = {
  /** The reference's MySQL TEXT ceiling divided by four: the most bytes one rune can cost. */
  titleRunes: 16383,
  fieldsRunes: 800000,
  commentBytes: 65535,
  boardMembers: 50,
  cardsPerBoard: 5000,
  viewsPerBoard: 50,
  propertiesPerBoard: 100,
  optionsPerProperty: 200,
  contentsPerCard: 500,
  undoDepth: 100,
  idLength: 27,
  batchOperations: 200,
  searchResults: 50,
} as const

/** The leading character of an id says what it names, the spelling the reference's archives use. */
export const PROJECT_ID_PREFIXES = {
  board: 'b',
  card: 'c',
  view: 'v',
  content: 'a',
  attachment: 'i',
  comment: 'a',
  category: 't',
  property: 'p',
  share: 'k',
  activity: 'e',
  unknown: '7',
} as const

export type ProjectIdKind = keyof typeof PROJECT_ID_PREFIXES

/**
 * Ids are 27 lowercase alphanumerics: one type character and 26 drawn from an alphabet without the
 * letters a reader mistakes for digits. The reference's zbase32 ids fit the same shape, which is what
 * lets an archive keep its own ids on import instead of remapping every cross-reference.
 */
export const PROJECT_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export const PROJECT_ID_PATTERN = /^[0-9a-z]{27}$/

/**
 * The reference's own built-in templates spell property and option ids as UUIDs, so an import has to
 * take both spellings. Neither admits a slash, a dot or a space, which is what keeps an id safe to
 * put in an object key.
 */
export const PROJECT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function newProjectId(kind: ProjectIdKind): string {
  const bytes = new Uint8Array(PROJECT_LIMITS.idLength - 1)
  crypto.getRandomValues(bytes)
  let id = PROJECT_ID_PREFIXES[kind]
  for (const byte of bytes) id += PROJECT_ID_ALPHABET[byte % PROJECT_ID_ALPHABET.length]
  return id
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && (PROJECT_ID_PATTERN.test(value) || PROJECT_UUID_PATTERN.test(value))
}