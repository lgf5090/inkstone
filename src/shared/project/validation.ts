/**
 * The shapes a project request may take. The server runs every write through these before it touches
 * D1; the client runs the same schemas so a rejected field is reported at the control that typed it.
 *
 * Bounds come from `./limits` rather than being restated, so raising a ceiling is one edit.
 */
import { z } from 'zod'
import { isProjectId, PROJECT_LIMITS } from './limits'
import {
  PROJECT_BOARD_LAYOUTS,
  PROJECT_BOARD_TYPES,
  PROJECT_CALCULATIONS,
  PROJECT_CALENDAR_MODES,
  PROJECT_CARD_LINK_KINDS,
  PROJECT_CATEGORY_TYPES,
  PROJECT_CHART_TYPES,
  PROJECT_CONTENT_TYPES,
  PROJECT_FILTER_CONDITIONS,
  PROJECT_GALLERY_SIZES,
  PROJECT_PROPERTY_TYPES,
  PROJECT_ROLES,
  PROJECT_SCHEDULE_SCALES,
  PROJECT_SUBSCRIPTION_BLOCKS,
  PROJECT_VIEW_TYPES,
} from './model'

const projectId = z.string().refine(isProjectId, 'invalid id')
// zod's string max counts code points, not UTF-16 units, which is the unit the reference's ceiling is
// written in: a title of 16383 emoji is 32766 units but 16383 characters, and it has to be accepted.
const title = z.string().max(PROJECT_LIMITS.titleRunes)
const icon = z.string().max(64)
const position = z.number().finite()
const stamp = z.number().int().nonnegative()

export const ProjectRoleSchema = z.enum(PROJECT_ROLES)
export const ProjectMinimumRoleSchema = z.union([z.literal(''), ProjectRoleSchema])
export const ProjectPropertyTypeSchema = z.enum(PROJECT_PROPERTY_TYPES)
export const ProjectViewTypeSchema = z.enum(PROJECT_VIEW_TYPES)
export const ProjectCalculationSchema = z.enum(PROJECT_CALCULATIONS)
export const ProjectFilterConditionSchema = z.enum(PROJECT_FILTER_CONDITIONS)

export const ProjectPropertyOptionSchema = z.object({
  id: projectId,
  value: z.string().max(1024),
  color: z.string().max(64),
})

export const ProjectPropertySchema = z.object({
  id: projectId,
  name: z.string().max(1024),
  type: ProjectPropertyTypeSchema,
  options: z.array(ProjectPropertyOptionSchema).max(PROJECT_LIMITS.optionsPerProperty),
})

export const ProjectFilterClauseSchema = z.object({
  propertyId: z.string().min(1).max(64),
  condition: ProjectFilterConditionSchema,
  values: z.array(z.string().max(4096)).max(PROJECT_LIMITS.optionsPerProperty),
})

export type ProjectFilterGroupInput = {
  operation: 'and' | 'or'
  filters: (z.infer<typeof ProjectFilterClauseSchema> | ProjectFilterGroupInput)[]
}

/** Nested on purpose: a group holds clauses and further groups, which is what the reference stores. */
export const ProjectFilterGroupSchema: z.ZodType<ProjectFilterGroupInput> = z.lazy(() => z.object({
  operation: z.enum(['and', 'or']),
  filters: z.array(z.union([ProjectFilterClauseSchema, ProjectFilterGroupSchema])).max(100),
}))

export const ProjectSortOptionSchema = z.object({
  propertyId: z.string().min(1).max(64),
  reversed: z.boolean(),
})

export const ProjectKanbanCalculationSchema = z.object({
  calculation: ProjectCalculationSchema,
  propertyId: z.string().max(64),
})

const idList = z.array(z.string().min(1).max(64)).max(PROJECT_LIMITS.cardsPerBoard)
// The ungrouped bucket's key is the empty string, so a list that can name a column has to accept it.
const optionKeyList = z.array(z.string().max(64)).max(PROJECT_LIMITS.cardsPerBoard)

export const ProjectViewFieldsSchema = z.object({
  minimumRole: ProjectMinimumRoleSchema.optional(),
  groupById: z.string().max(64).optional(),
  dateDisplayPropertyId: z.string().max(64).optional(),
  cardSize: z.enum(['compact', 'comfortable', 'spacious']).optional(),
  swimlaneBy: z.string().max(64).optional(),
  wipLimits: z.record(z.string().max(64), z.number().int().min(0)).optional(),
  sortOptions: z.array(ProjectSortOptionSchema).max(PROJECT_LIMITS.propertiesPerBoard),
  visiblePropertyIds: idList,
  visibleOptionIds: optionKeyList,
  hiddenOptionIds: optionKeyList,
  collapsedOptionIds: z.array(z.string().max(64)).max(PROJECT_LIMITS.cardsPerBoard),
  filter: ProjectFilterGroupSchema,
  cardOrder: idList,
  columnWidths: z.record(z.string().max(64), z.number().int().min(0).max(4096)),
  columnCalculations: z.record(z.string().max(64), ProjectCalculationSchema),
  kanbanCalculations: z.record(z.string().max(64), ProjectKanbanCalculationSchema),
  defaultTemplateId: z.string().max(64),
  galleryShowTitle: z.boolean().optional(),
  galleryShowBadges: z.boolean().optional(),
  columnOrder: optionKeyList.optional(),
  galleryCardSize: z.enum(PROJECT_GALLERY_SIZES).optional(),
  boardLayout: z.enum(PROJECT_BOARD_LAYOUTS).optional(),
  calendarMode: z.enum(PROJECT_CALENDAR_MODES).optional(),
  scheduleScale: z.enum(PROJECT_SCHEDULE_SCALES).optional(),
  scheduleGroupById: z.string().max(64).optional(),
  scheduleShowToday: z.boolean().optional(),
  scheduleShowWeekends: z.boolean().optional(),
  scheduleShowDependencies: z.boolean().optional(),
  chartType: z.enum(PROJECT_CHART_TYPES).optional(),
  chartGroupById: z.string().max(64).optional(),
  chartPropertyId: z.string().max(64).optional(),
  chartCalculation: ProjectCalculationSchema.optional(),
})

export const ProjectBoardFromTemplateSchema = z.object({
  templateId: z.string().min(1).max(64),
  locale: z.string().max(16).optional(),
})

export const ProjectBoardCreateSchema = z.object({
  id: projectId.optional(),
  title: title.default(''),
  description: z.string().max(PROJECT_LIMITS.fieldsRunes).default(''),
  icon: icon.default(''),
  showDescription: z.boolean().default(false),
  type: z.enum(PROJECT_BOARD_TYPES).default('P'),
  minimumRole: ProjectMinimumRoleSchema.default(''),
  isTemplate: z.boolean().default(false),
  cardProperties: z.array(ProjectPropertySchema).max(PROJECT_LIMITS.propertiesPerBoard).default([]),
})
export type ProjectBoardCreateInput = z.infer<typeof ProjectBoardCreateSchema>

export const ProjectBoardPatchSchema = z.object({
  title: title.optional(),
  description: z.string().max(PROJECT_LIMITS.fieldsRunes).optional(),
  icon: icon.optional(),
  showDescription: z.boolean().optional(),
  archived: z.boolean().optional(),
  type: z.enum(PROJECT_BOARD_TYPES).optional(),
  minimumRole: ProjectMinimumRoleSchema.optional(),
  updatedCardProperties: z.array(ProjectPropertySchema).max(PROJECT_LIMITS.propertiesPerBoard).optional(),
  deletedCardProperties: z.array(projectId).max(PROJECT_LIMITS.propertiesPerBoard).optional(),
})
export type ProjectBoardPatchInput = z.infer<typeof ProjectBoardPatchSchema>

/** A property value is text on the wire; multi-valued types carry a JSON array, as the reference does. */
const propertyValue = z.string().max(PROJECT_LIMITS.fieldsRunes)
const valueMap = z.record(projectId, propertyValue)
  .refine((values) => Object.keys(values).length <= PROJECT_LIMITS.propertiesPerBoard, 'too many values')

export const ProjectRecurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(365).default(1),
  byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
})

export const ProjectCardCreateSchema = z.object({
  id: projectId.optional(),
  parentId: projectId.default(''),
  title: title.default(''),
  icon: icon.default(''),
  isTemplate: z.boolean().default(false),
  values: valueMap.default({}),
  recurrence: ProjectRecurrenceSchema.nullable().optional(),
})
export type ProjectCardCreateInput = z.infer<typeof ProjectCardCreateSchema>

export const ProjectCardPatchSchema = z.object({
  title: title.optional(),
  icon: icon.optional(),
  parentId: z.union([projectId, z.literal('')]).optional(),
  contentOrder: z.array(z.union([projectId, z.array(projectId).max(64)]))
    .max(PROJECT_LIMITS.contentsPerCard).optional(),
  values: z.record(projectId, z.union([propertyValue, z.null()])).optional(),
  recurrence: ProjectRecurrenceSchema.nullable().optional(),
})
export type ProjectCardPatchInput = z.infer<typeof ProjectCardPatchSchema>

export const ProjectCardMoveSchema = z.object({ targetBoardId: projectId })

export const ProjectViewCreateSchema = z.object({
  id: projectId.optional(),
  title: title.default(''),
  viewType: ProjectViewTypeSchema.default('board'),
  fields: ProjectViewFieldsSchema.partial().default({}),
  position: position.optional(),
})
export type ProjectViewCreateInput = z.infer<typeof ProjectViewCreateSchema>

export const ProjectViewPatchSchema = z.object({
  title: title.optional(),
  viewType: ProjectViewTypeSchema.optional(),
  fields: ProjectViewFieldsSchema.partial().optional(),
  position: position.optional(),
})
export type ProjectViewPatchInput = z.infer<typeof ProjectViewPatchSchema>

export const ProjectContentFieldsSchema = z.object({
  checked: z.boolean().optional(),
  attachmentId: projectId.optional(),
  language: z.string().max(64).optional(),
})

export const ProjectContentCreateSchema = z.object({
  id: projectId.optional(),
  type: z.enum(PROJECT_CONTENT_TYPES),
  title: z.string().max(PROJECT_LIMITS.fieldsRunes).default(''),
  fields: ProjectContentFieldsSchema.default({}),
  position: position.optional(),
})
export type ProjectContentCreateInput = z.infer<typeof ProjectContentCreateSchema>

export const ProjectContentPatchSchema = z.object({
  title: z.string().max(PROJECT_LIMITS.fieldsRunes).optional(),
  fields: ProjectContentFieldsSchema.optional(),
  position: position.optional(),
})
export type ProjectContentPatchInput = z.infer<typeof ProjectContentPatchSchema>

export const ProjectContentMoveSchema = z.object({
  where: z.enum(['before', 'after']),
  targetId: projectId,
})

export const ProjectCommentCreateSchema = z.object({
  id: projectId.optional(),
  body: z.string().min(1).refine(
    (value) => new TextEncoder().encode(value).length <= PROJECT_LIMITS.commentBytes,
    'comment too long',
  ),
})
export type ProjectCommentCreateInput = z.infer<typeof ProjectCommentCreateSchema>

export const ProjectCommentPatchSchema = ProjectCommentCreateSchema.omit({ id: true })

export const ProjectCategoryCreateSchema = z.object({
  id: projectId.optional(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(PROJECT_CATEGORY_TYPES).default('custom'),
})
export type ProjectCategoryCreateInput = z.infer<typeof ProjectCategoryCreateSchema>

export const ProjectCategoryPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  collapsed: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
})
export type ProjectCategoryPatchInput = z.infer<typeof ProjectCategoryPatchSchema>

export const ProjectCategoryOrderSchema = z.object({
  categoryIds: z.array(projectId).max(200),
})

export const ProjectCategoryBoardOrderSchema = z.object({
  boardIds: z.array(projectId).max(1000),
})

export const ProjectCategoryBoardHiddenSchema = z.object({ hidden: z.boolean() })

export const ProjectCardMarksSchema = z.object({
  starred: z.array(projectId).max(PROJECT_LIMITS.cardsPerBoard).default([]),
  pinned: z.array(projectId).max(PROJECT_LIMITS.cardsPerBoard).default([]),
})

export const ProjectMemberAddSchema = z.object({
  username: z.string().trim().min(1).max(64),
  role: ProjectRoleSchema,
})

export const ProjectMemberPatchSchema = z.object({ role: ProjectRoleSchema })

export const ProjectSubscriptionCreateSchema = z.object({
  blockType: z.enum(PROJECT_SUBSCRIPTION_BLOCKS),
  blockId: projectId,
})

export const ProjectSharePutSchema = z.object({
  password: z.string().min(4).max(128).nullable().optional(),
  expiresAt: stamp.nullable().optional(),
  showComments: z.boolean().optional(),
})

export const ProjectCardLinkSchema = z.object({
  toCardId: projectId,
  kind: z.enum(PROJECT_CARD_LINK_KINDS),
})

export const ProjectTodoLinkSchema = z.object({ todoId: z.string().min(1).max(64) })

/**
 * A batch is one D1 transaction, so its size is bounded rather than left to the caller: an unbounded
 * array would let one request hold the database for as long as it likes.
 */
export const ProjectBatchSchema = z.object({
  cards: z.array(z.object({ id: projectId, patch: ProjectCardPatchSchema }))
    .max(PROJECT_LIMITS.batchOperations).optional(),
  contents: z.array(z.object({ id: projectId, patch: ProjectContentPatchSchema }))
    .max(PROJECT_LIMITS.batchOperations).optional(),
  views: z.array(z.object({ id: projectId, patch: ProjectViewPatchSchema }))
    .max(PROJECT_LIMITS.batchOperations).optional(),
})

export const ProjectBatchDeleteSchema = z.object({
  cardIds: z.array(projectId).max(PROJECT_LIMITS.batchOperations).default([]),
  contentIds: z.array(projectId).max(PROJECT_LIMITS.batchOperations).default([]),
  viewIds: z.array(projectId).max(PROJECT_LIMITS.batchOperations).default([]),
})