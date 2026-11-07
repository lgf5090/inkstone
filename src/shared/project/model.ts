/**
 * The project app's vocabulary: what a board, a card, a property and a view are, spelled once for the
 * server that stores them and the client that draws them.
 *
 * The shapes follow Focalboard's block model rather than inventing a new one, because an archive
 * exported there has to import here field for field. Where this port deliberately differs, the
 * reason is stated at the declaration.
 */

export const PROJECT_BOARD_TYPES = ['O', 'P'] as const
export type ProjectBoardType = (typeof PROJECT_BOARD_TYPES)[number]

/** Ordered weakest to strongest: a member's effective role is the stronger of two of these. */
export const PROJECT_ROLES = ['viewer', 'commenter', 'editor', 'admin'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]
export type ProjectMinimumRole = '' | ProjectRole

export const PROJECT_PROPERTY_TYPES = [
  'text', 'number', 'select', 'multiSelect', 'date', 'person', 'multiPerson', 'file',
  'checkbox', 'url', 'email', 'phone', 'createdTime', 'createdBy', 'updatedTime', 'updatedBy', 'unknown',
] as const
export type ProjectPropertyType = (typeof PROJECT_PROPERTY_TYPES)[number]

/** The two the reference declares but never registers: `file` has no editor, `unknown` is the fallback. */
export const PROJECT_UNREGISTERED_PROPERTY_TYPES = ['file', 'unknown'] as const

export const PROJECT_FILTER_VALUE_TYPES = ['none', 'options', 'boolean', 'text', 'date', 'person'] as const
export type ProjectFilterValueType = (typeof PROJECT_FILTER_VALUE_TYPES)[number]

export const PROJECT_FILTER_CONDITIONS = [
  'includes', 'notIncludes', 'isEmpty', 'isNotEmpty',
  'isSet', 'isNotSet', 'is',
  'contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith',
  'isBefore', 'isAfter',
] as const
export type ProjectFilterCondition = (typeof PROJECT_FILTER_CONDITIONS)[number]

/** Which conditions a value type offers, and the one a new clause starts on. */
export const PROJECT_CONDITIONS_BY_VALUE_TYPE: Readonly<Record<ProjectFilterValueType, {
  readonly conditions: readonly ProjectFilterCondition[]
  readonly default: ProjectFilterCondition
}>> = {
  none: { conditions: [], default: 'is' },
  options: { conditions: ['includes', 'notIncludes', 'isEmpty', 'isNotEmpty'], default: 'includes' },
  boolean: { conditions: ['isSet', 'isNotSet'], default: 'isSet' },
  person: { conditions: ['includes', 'notIncludes', 'isEmpty', 'isNotEmpty'], default: 'includes' },
  text: {
    conditions: ['is', 'contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith'],
    default: 'is',
  },
  date: { conditions: ['is', 'isBefore', 'isAfter', 'isSet', 'isNotSet'], default: 'is' },
}

export interface ProjectPropertyCapability {
  canFilter: boolean
  filterValueType: ProjectFilterValueType
  canGroup: boolean
  readOnly: boolean
}

const EDITABLE_TEXT: ProjectPropertyCapability = { canFilter: true, filterValueType: 'text', canGroup: false, readOnly: false }
const OPTION_SINGLE: ProjectPropertyCapability = { canFilter: true, filterValueType: 'options', canGroup: true, readOnly: false }
const OPTION_MULTI: ProjectPropertyCapability = { canFilter: true, filterValueType: 'options', canGroup: false, readOnly: false }
const PERSON_SINGLE: ProjectPropertyCapability = { canFilter: true, filterValueType: 'person', canGroup: true, readOnly: false }
const PERSON_MULTI: ProjectPropertyCapability = { canFilter: true, filterValueType: 'person', canGroup: false, readOnly: false }
const SERVER_STAMP: ProjectPropertyCapability = { canFilter: false, filterValueType: 'none', canGroup: false, readOnly: true }
const SERVER_AUTHOR: ProjectPropertyCapability = { canFilter: true, filterValueType: 'person', canGroup: true, readOnly: true }
const OPAQUE: ProjectPropertyCapability = { canFilter: false, filterValueType: 'none', canGroup: false, readOnly: false }

/**
 * What each property type can do, read off the reference's own registrations rather than assumed.
 * Two entries surprise a reader who guesses: `number` is not filterable there, and the two
 * server-written author fields are both filterable and groupable despite being read-only.
 */
export const PROJECT_PROPERTY_CAPABILITIES: Readonly<Record<ProjectPropertyType, ProjectPropertyCapability>> = {
  text: EDITABLE_TEXT,
  number: OPAQUE,
  select: OPTION_SINGLE,
  multiSelect: OPTION_MULTI,
  date: { canFilter: true, filterValueType: 'date', canGroup: false, readOnly: false },
  person: PERSON_SINGLE,
  multiPerson: PERSON_MULTI,
  file: OPAQUE,
  checkbox: { canFilter: true, filterValueType: 'boolean', canGroup: false, readOnly: false },
  url: EDITABLE_TEXT,
  email: EDITABLE_TEXT,
  phone: EDITABLE_TEXT,
  createdTime: SERVER_STAMP,
  createdBy: SERVER_AUTHOR,
  updatedTime: SERVER_STAMP,
  updatedBy: SERVER_AUTHOR,
  unknown: OPAQUE,
}

/** The 21 summaries a column or a kanban column header can show, in the reference's own order. */
export const PROJECT_CALCULATIONS = [
  'none', 'count', 'countEmpty', 'countNotEmpty', 'percentEmpty', 'percentNotEmpty',
  'countValue', 'countChecked', 'percentChecked', 'percentUnchecked', 'countUnchecked',
  'countUniqueValue', 'sum', 'average', 'median', 'min', 'max', 'range',
  'earliest', 'latest', 'dateRange',
] as const
export type ProjectCalculation = (typeof PROJECT_CALCULATIONS)[number]

/** Four the reference draws, then four this port adds; an imported archive only ever names the first four. */
export const PROJECT_VIEW_TYPES = ['board', 'table', 'gallery', 'calendar', 'list', 'timeline', 'gantt', 'chart'] as const
export type ProjectViewType = (typeof PROJECT_VIEW_TYPES)[number]
export const PROJECT_REFERENCE_VIEW_TYPES = ['board', 'table', 'gallery', 'calendar'] as const

export const PROJECT_CONTENT_TYPES = ['text', 'checkbox', 'divider', 'image', 'attachment'] as const
export type ProjectContentType = (typeof PROJECT_CONTENT_TYPES)[number]

export const PROJECT_CATEGORY_TYPES = ['system', 'custom'] as const
export type ProjectCategoryType = (typeof PROJECT_CATEGORY_TYPES)[number]

export const PROJECT_SUBSCRIPTION_BLOCKS = ['board', 'card'] as const
export type ProjectSubscriptionBlock = (typeof PROJECT_SUBSCRIPTION_BLOCKS)[number]

export const PROJECT_CARD_LINK_KINDS = ['blocks', 'parent'] as const
export type ProjectCardLinkKind = (typeof PROJECT_CARD_LINK_KINDS)[number]

export interface ProjectCardLink {
  fromCardId: string
  toCardId: string
  kind: ProjectCardLinkKind
}

export interface ProjectActivityEntry {
  id: string
  actorId: string
  type: string
  targetId: string
  summary: string
  createdAt: number
}

export const PROJECT_STORAGE_KINDS = ['r2', 'kv'] as const
export type ProjectStorageKind = (typeof PROJECT_STORAGE_KINDS)[number]

export const PROJECT_ATTACHMENT_CATEGORIES = [
  'images', 'pdf', 'txt', 'docx', 'sheets', 'slides', 'audio', 'video', 'archives', 'other',
] as const
export type ProjectAttachmentCategory = (typeof PROJECT_ATTACHMENT_CATEGORIES)[number]

/** The pseudo-property a view sorts on when it sorts by the card's own name rather than a property. */
export const PROJECT_TITLE_PROPERTY_ID = '__title'

export interface ProjectFilterClause {
  propertyId: string
  condition: ProjectFilterCondition
  values: string[]
}

export interface ProjectFilterGroup {
  operation: 'and' | 'or'
  filters: (ProjectFilterClause | ProjectFilterGroup)[]
}

export function isProjectFilterGroup(value: ProjectFilterClause | ProjectFilterGroup): value is ProjectFilterGroup {
  return 'operation' in value && 'filters' in value
}

/** An empty group matches everything, which is what a view with no filter stores. */
export function emptyProjectFilterGroup(): ProjectFilterGroup {
  return { operation: 'and', filters: [] }
}

/**
 * A date property's value. The reference also accepts a bare millisecond string for a single date,
 * so readers have to take both; writers here always produce the object.
 */
export interface ProjectDateValue {
  from?: number
  to?: number
  includeTime?: boolean
  timeZone?: string
}

export interface ProjectPropertyOption {
  id: string
  value: string
  color: string
}

export interface ProjectProperty {
  id: string
  name: string
  type: ProjectPropertyType
  options: ProjectPropertyOption[]
}

export interface ProjectSortOption {
  propertyId: string
  reversed: boolean
}

export interface ProjectKanbanCalculation {
  calculation: ProjectCalculation
  propertyId: string
}

/**
 * Everything a view remembers. Order is view-level on purpose: two views of one board can sort the
 * same cards differently, so `cardOrder` lives here and not on the card.
 */
export interface ProjectViewFields {
  groupById?: string
  dateDisplayPropertyId?: string
  sortOptions: ProjectSortOption[]
  visiblePropertyIds: string[]
  visibleOptionIds: string[]
  hiddenOptionIds: string[]
  collapsedOptionIds: string[]
  filter: ProjectFilterGroup
  cardOrder: string[]
  columnWidths: Record<string, number>
  columnCalculations: Record<string, ProjectCalculation>
  kanbanCalculations: Record<string, ProjectKanbanCalculation>
  defaultTemplateId: string
}

export function emptyProjectViewFields(): ProjectViewFields {
  return {
    sortOptions: [],
    visiblePropertyIds: [],
    visibleOptionIds: [],
    hiddenOptionIds: [],
    collapsedOptionIds: [],
    filter: emptyProjectFilterGroup(),
    cardOrder: [],
    columnWidths: {},
    columnCalculations: {},
    kanbanCalculations: {},
    defaultTemplateId: '',
  }
}

export interface ProjectBoard {
  id: string
  ownerId: string
  type: ProjectBoardType
  minimumRole: ProjectMinimumRole
  title: string
  description: string
  icon: string
  showDescription: boolean
  isTemplate: boolean
  templateVersion: number
  createdBy: string
  modifiedBy: string
  createAt: number
  updateAt: number
  deleteAt: number
}

/** A board as the caller sees it: the stored fields plus the role this caller actually holds. */
export interface ProjectBoardSummary extends ProjectBoard {
  role: ProjectRole
}

/** The counts the board list shows as a subtitle (reference BoardMetadata). */
export interface ProjectBoardMetadata {
  cardCount: number
  propertyCount: number
  viewCount: number
}

/**
 * A board edit. Absent means "leave alone"; the two property lists are whole-object replacements
 * matched by id, and a property id never seen before is appended rather than inserted.
 */
export interface ProjectBoardPatch {
  title?: string
  description?: string
  icon?: string
  showDescription?: boolean
  type?: ProjectBoardType
  minimumRole?: ProjectMinimumRole
  updatedCardProperties?: ProjectProperty[]
  deletedCardProperties?: string[]
}

export interface ProjectCard {
  id: string
  boardId: string
  parentId: string
  title: string
  icon: string
  isTemplate: boolean
  /** Content and comment ids in reading order; a nested array threads comments under one block. */
  contentOrder: (string | string[])[]
  values: Record<string, string>
  createdBy: string
  modifiedBy: string
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectCardPatch {
  title?: string
  icon?: string
  parentId?: string
  contentOrder?: (string | string[])[]
  values?: Record<string, string | null>
}

export interface ProjectView {
  id: string
  boardId: string
  title: string
  viewType: ProjectViewType
  fields: ProjectViewFields
  position: number
  createdBy: string
  modifiedBy: string
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectViewPatch {
  title?: string
  viewType?: ProjectViewType
  fields?: Partial<ProjectViewFields>
  position?: number
}

export interface ProjectContentFields {
  checked?: boolean
  attachmentId?: string
  language?: string
}

export interface ProjectContent {
  id: string
  cardId: string
  boardId: string
  type: ProjectContentType
  title: string
  fields: ProjectContentFields
  position: number
  createdBy: string
  modifiedBy: string
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectComment {
  id: string
  cardId: string
  boardId: string
  authorId: string
  body: string
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectBoardMember {
  boardId: string
  userId: string
  role: ProjectRole
  createdAt: number
  updatedAt: number
}

export interface ProjectCategory {
  id: string
  userId: string
  name: string
  type: ProjectCategoryType
  collapsed: boolean
  sortOrder: number
  createAt: number
  updateAt: number
  deleteAt: number
}

export interface ProjectCategoryBoard {
  categoryId: string
  boardId: string
  hidden: boolean
  position: number
}

export interface ProjectSubscription {
  blockType: ProjectSubscriptionBlock
  blockId: string
  subscriberId: string
  notifiedAt: number
  createAt: number
}

/** What a signed-in member sees about a board's public link; the hash itself never leaves the server. */
export interface ProjectShare {
  slug: string
  boardId: string
  hasPassword: boolean
  expiresAt: number | null
  views: number
  createdAt: number
}

export interface ProjectAttachment {
  id: string
  userId: string
  boardId: string
  cardId: string | null
  filename: string
  mime: string
  size: number
  storage: ProjectStorageKind
  objectKey: string
  width: number | null
  height: number | null
  thumbnailKey: string | null
  createdAt: number
  updatedAt: number
}

/**
 * One board, whole. The reference made the client fetch blocks page by page and assemble them; this
 * reads the board in one round trip because every screen that opens a board needs all of it anyway.
 */
export interface ProjectBoardBundle {
  board: ProjectBoard
  properties: ProjectProperty[]
  views: ProjectView[]
  cards: ProjectCard[]
  contents: ProjectContent[]
  comments: ProjectComment[]
  members: ProjectBoardMember[]
  /** The caller's effective role, already resolved against the board's minimum role. */
  role: ProjectRole
  cursor: number
}

const ROLE_RANK: Readonly<Record<ProjectMinimumRole, number>> = {
  '': 0, viewer: 1, commenter: 2, editor: 3, admin: 4,
}

export function projectRoleRank(role: ProjectMinimumRole): number {
  return ROLE_RANK[role]
}

/**
 * The role a request actually carries. An open board grants its minimum to every signed-in account,
 * a private one grants nothing beyond an explicit membership, and the owner is always an admin.
 * The server resolves this before every write; the client resolves it only to decide what to draw.
 */
export function effectiveProjectRole(input: {
  ownerId: string
  userId: string
  boardType: ProjectBoardType
  minimumRole: ProjectMinimumRole
  memberRole: ProjectRole | null
}): ProjectRole | null {
  if (input.ownerId === input.userId) return 'admin'
  const granted = input.boardType === 'O' ? input.minimumRole : ''
  const rank = Math.max(ROLE_RANK[granted], input.memberRole ? ROLE_RANK[input.memberRole] : 0)
  if (rank === 0) return null
  return PROJECT_ROLES[rank - 1]!
}

export function projectRoleAtLeast(role: ProjectRole | null, required: ProjectRole): boolean {
  return role !== null && ROLE_RANK[role] >= ROLE_RANK[required]
}
