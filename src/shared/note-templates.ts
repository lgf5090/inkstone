/**
 * Built-in template library catalog.
 *
 * The gallery is seeded per user from this catalog on first run. Names,
 * descriptions and Markdown bodies live in the locale resources (one entry per
 * language), so the catalog only references message keys. Bump
 * `TEMPLATE_SEED_VERSION` when adding or changing built-in entries: hydration
 * merges the missing/updated entries into existing user libraries without
 * touching user-created templates or user edits.
 */
import type { MessageKey } from './locales/en-US'
import type { NoteTemplate, NoteTemplateCategory } from './types'


interface BuiltinTemplateCategoryDef {
  id: string
  nameKey: MessageKey
  position: number
}

/**
 * Cross-cutting labels (not categories) used to tag built-in templates. Each
 * key maps to a localized label; user templates keep arbitrary free-form tags.
 */

type BuiltinTemplateTagKey =
  | 'checklist'
  | 'table'
  | 'daily'
  | 'weekly'
  | 'goal'
  | 'review'
  | 'study'
  | 'work'
  | 'life'
  | 'writing'
  | 'tech'
  | 'finance'
  | 'health'
  | 'travel'
  | 'decision'
  | 'meeting'
  | 'planning'

export const BUILTIN_TEMPLATE_TAG_LABELS: Record<BuiltinTemplateTagKey, MessageKey> = {
  checklist: 'template.tag.checklist',
  table: 'template.tag.table',
  daily: 'template.tag.daily',
  weekly: 'template.tag.weekly',
  goal: 'template.tag.goal',
  review: 'template.tag.review',
  study: 'template.tag.study',
  work: 'template.tag.work',
  life: 'template.tag.life',
  writing: 'template.tag.writing',
  tech: 'template.tag.tech',
  finance: 'template.tag.finance',
  health: 'template.tag.health',
  travel: 'template.tag.travel',
  decision: 'template.tag.decision',
  meeting: 'template.tag.meeting',
  planning: 'template.tag.planning',
}

export interface BuiltinTemplateDef {
  id: string
  categoryId: string
  nameKey: MessageKey
  descriptionKey: MessageKey
  contentKey: MessageKey
  tags: BuiltinTemplateTagKey[]
}

/**
 * Increment when the built-in catalog changes so already-seeded libraries pick
 * up new or updated entries. User edits to an entry that shares a built-in id
 * are never overwritten by a re-seed.
 */
export const TEMPLATE_SEED_VERSION = 2

export const BUILTIN_TEMPLATE_CATEGORIES: BuiltinTemplateCategoryDef[] = [
  { id: 'productivity', nameKey: 'template.category.productivity', position: 0 },
  { id: 'tasks', nameKey: 'template.category.tasks', position: 1 },
  { id: 'learning', nameKey: 'template.category.learning', position: 2 },
  { id: 'work', nameKey: 'template.category.work', position: 3 },
  { id: 'life', nameKey: 'template.category.life', position: 4 },
  { id: 'health', nameKey: 'template.category.health', position: 5 },
  { id: 'writing', nameKey: 'template.category.writing', position: 6 },
  { id: 'industry', nameKey: 'template.category.industry', position: 7 },
]

export const BUILTIN_TEMPLATE_DEFS: BuiltinTemplateDef[] = [
  {
    id: 'bullet-journal',
    categoryId: 'productivity',
    nameKey: 'template.bullet_journal.name',
    descriptionKey: 'template.bullet_journal.description',
    contentKey: 'template.bullet_journal.content',
    tags: ['daily', 'checklist'],
  },
  {
    id: 'cornell',
    categoryId: 'productivity',
    nameKey: 'template.cornell.name',
    descriptionKey: 'template.cornell.description',
    contentKey: 'template.cornell.content',
    tags: ['study', 'table'],
  },
  {
    id: 'four-quadrant',
    categoryId: 'productivity',
    nameKey: 'template.four_quadrant.name',
    descriptionKey: 'template.four_quadrant.description',
    contentKey: 'template.four_quadrant.content',
    tags: ['goal', 'checklist'],
  },
  {
    id: 'pdca',
    categoryId: 'productivity',
    nameKey: 'template.pdca.name',
    descriptionKey: 'template.pdca.description',
    contentKey: 'template.pdca.content',
    tags: ['review', 'work'],
  },
  {
    id: 'gtd',
    categoryId: 'productivity',
    nameKey: 'template.gtd.name',
    descriptionKey: 'template.gtd.description',
    contentKey: 'template.gtd.content',
    tags: ['checklist', 'goal'],
  },
  {
    id: 'pomodoro',
    categoryId: 'productivity',
    nameKey: 'template.pomodoro.name',
    descriptionKey: 'template.pomodoro.description',
    contentKey: 'template.pomodoro.content',
    tags: ['daily', 'work'],
  },
  {
    id: 'morning-pages',
    categoryId: 'productivity',
    nameKey: 'template.morning_pages.name',
    descriptionKey: 'template.morning_pages.description',
    contentKey: 'template.morning_pages.content',
    tags: ['daily', 'writing'],
  },
  {
    id: 'okr',
    categoryId: 'productivity',
    nameKey: 'template.okr.name',
    descriptionKey: 'template.okr.description',
    contentKey: 'template.okr.content',
    tags: ['goal', 'review', 'weekly'],
  },
  {
    id: 'todo-list',
    categoryId: 'tasks',
    nameKey: 'template.todo_list.name',
    descriptionKey: 'template.todo_list.description',
    contentKey: 'template.todo_list.content',
    tags: ['checklist', 'daily'],
  },
  {
    id: 'shopping-list',
    categoryId: 'tasks',
    nameKey: 'template.shopping_list.name',
    descriptionKey: 'template.shopping_list.description',
    contentKey: 'template.shopping_list.content',
    tags: ['checklist', 'life'],
  },
  {
    id: 'habit-tracker',
    categoryId: 'tasks',
    nameKey: 'template.habit_tracker.name',
    descriptionKey: 'template.habit_tracker.description',
    contentKey: 'template.habit_tracker.content',
    tags: ['daily', 'health', 'table'],
  },
  {
    id: 'weekly-plan',
    categoryId: 'tasks',
    nameKey: 'template.weekly_plan.name',
    descriptionKey: 'template.weekly_plan.description',
    contentKey: 'template.weekly_plan.content',
    tags: ['weekly', 'goal', 'checklist'],
  },
  {
    id: 'task-breakdown',
    categoryId: 'tasks',
    nameKey: 'template.task_breakdown.name',
    descriptionKey: 'template.task_breakdown.description',
    contentKey: 'template.task_breakdown.content',
    tags: ['checklist', 'goal'],
  },
  {
    id: 'book-notes',
    categoryId: 'learning',
    nameKey: 'template.book_notes.name',
    descriptionKey: 'template.book_notes.description',
    contentKey: 'template.book_notes.content',
    tags: ['study', 'writing'],
  },
  {
    id: 'class-notes',
    categoryId: 'learning',
    nameKey: 'template.class_notes.name',
    descriptionKey: 'template.class_notes.description',
    contentKey: 'template.class_notes.content',
    tags: ['study'],
  },
  {
    id: 'feynman',
    categoryId: 'learning',
    nameKey: 'template.feynman.name',
    descriptionKey: 'template.feynman.description',
    contentKey: 'template.feynman.content',
    tags: ['study'],
  },
  {
    id: 'mistake-notebook',
    categoryId: 'learning',
    nameKey: 'template.mistake_notebook.name',
    descriptionKey: 'template.mistake_notebook.description',
    contentKey: 'template.mistake_notebook.content',
    tags: ['study', 'review'],
  },
  {
    id: 'knowledge-cards',
    categoryId: 'learning',
    nameKey: 'template.knowledge_cards.name',
    descriptionKey: 'template.knowledge_cards.description',
    contentKey: 'template.knowledge_cards.content',
    tags: ['study', 'table'],
  },
  {
    id: 'meeting-minutes',
    categoryId: 'work',
    nameKey: 'template.meeting_minutes.name',
    descriptionKey: 'template.meeting_minutes.description',
    contentKey: 'template.meeting_minutes.content',
    tags: ['work', 'review'],
  },
  {
    id: 'weekly-report',
    categoryId: 'work',
    nameKey: 'template.weekly_report.name',
    descriptionKey: 'template.weekly_report.description',
    contentKey: 'template.weekly_report.content',
    tags: ['weekly', 'work'],
  },
  {
    id: 'project-review',
    categoryId: 'work',
    nameKey: 'template.project_review.name',
    descriptionKey: 'template.project_review.description',
    contentKey: 'template.project_review.content',
    tags: ['review', 'work'],
  },
  {
    id: 'brainstorm',
    categoryId: 'work',
    nameKey: 'template.brainstorm.name',
    descriptionKey: 'template.brainstorm.description',
    contentKey: 'template.brainstorm.content',
    tags: ['writing', 'work'],
  },
  {
    id: 'swot',
    categoryId: 'work',
    nameKey: 'template.swot.name',
    descriptionKey: 'template.swot.description',
    contentKey: 'template.swot.content',
    tags: ['work', 'table'],
  },
  {
    id: 'travel-guide',
    categoryId: 'life',
    nameKey: 'template.travel_guide.name',
    descriptionKey: 'template.travel_guide.description',
    contentKey: 'template.travel_guide.content',
    tags: ['travel', 'life', 'checklist'],
  },
  {
    id: 'recipe',
    categoryId: 'life',
    nameKey: 'template.recipe.name',
    descriptionKey: 'template.recipe.description',
    contentKey: 'template.recipe.content',
    tags: ['life', 'table'],
  },
  {
    id: 'movie-log',
    categoryId: 'life',
    nameKey: 'template.movie_log.name',
    descriptionKey: 'template.movie_log.description',
    contentKey: 'template.movie_log.content',
    tags: ['life'],
  },
  {
    id: 'expense-log',
    categoryId: 'life',
    nameKey: 'template.expense_log.name',
    descriptionKey: 'template.expense_log.description',
    contentKey: 'template.expense_log.content',
    tags: ['finance', 'life', 'table'],
  },
  {
    id: 'diary',
    categoryId: 'life',
    nameKey: 'template.diary.name',
    descriptionKey: 'template.diary.description',
    contentKey: 'template.diary.content',
    tags: ['daily', 'life'],
  },
  {
    id: 'workout-plan',
    categoryId: 'health',
    nameKey: 'template.workout_plan.name',
    descriptionKey: 'template.workout_plan.description',
    contentKey: 'template.workout_plan.content',
    tags: ['health', 'daily', 'weekly'],
  },
  {
    id: 'meal-log',
    categoryId: 'health',
    nameKey: 'template.meal_log.name',
    descriptionKey: 'template.meal_log.description',
    contentKey: 'template.meal_log.content',
    tags: ['health', 'daily', 'table'],
  },
  {
    id: 'sleep-diary',
    categoryId: 'health',
    nameKey: 'template.sleep_diary.name',
    descriptionKey: 'template.sleep_diary.description',
    contentKey: 'template.sleep_diary.content',
    tags: ['health', 'daily'],
  },
  {
    id: 'article-outline',
    categoryId: 'writing',
    nameKey: 'template.article_outline.name',
    descriptionKey: 'template.article_outline.description',
    contentKey: 'template.article_outline.content',
    tags: ['writing'],
  },
  {
    id: 'speech-draft',
    categoryId: 'writing',
    nameKey: 'template.speech_draft.name',
    descriptionKey: 'template.speech_draft.description',
    contentKey: 'template.speech_draft.content',
    tags: ['writing'],
  },
  {
    id: 'story-setting',
    categoryId: 'writing',
    nameKey: 'template.story_setting.name',
    descriptionKey: 'template.story_setting.description',
    contentKey: 'template.story_setting.content',
    tags: ['writing'],
  },
  {
    id: 'dev-daily',
    categoryId: 'industry',
    nameKey: 'template.dev_daily.name',
    descriptionKey: 'template.dev_daily.description',
    contentKey: 'template.dev_daily.content',
    tags: ['tech', 'daily'],
  },
  {
    id: 'bug-tracker',
    categoryId: 'industry',
    nameKey: 'template.bug_tracker.name',
    descriptionKey: 'template.bug_tracker.description',
    contentKey: 'template.bug_tracker.content',
    tags: ['tech', 'review'],
  },
  {
    id: 'prd',
    categoryId: 'industry',
    nameKey: 'template.prd.name',
    descriptionKey: 'template.prd.description',
    contentKey: 'template.prd.content',
    tags: ['tech', 'work'],
  },
  {
    id: 'marketing-plan',
    categoryId: 'industry',
    nameKey: 'template.marketing_plan.name',
    descriptionKey: 'template.marketing_plan.description',
    contentKey: 'template.marketing_plan.content',
    tags: ['work', 'weekly'],
  },
  {
    id: 'kanban_sprint_board',
    categoryId: 'work',
    nameKey: 'template.kanban_sprint_board.name',
    descriptionKey: 'template.kanban_sprint_board.description',
    contentKey: 'template.kanban_sprint_board.content',
    tags: ['work', 'checklist'],
  },
  {
    id: 'mindmap_reading_map',
    categoryId: 'learning',
    nameKey: 'template.mindmap_reading_map.name',
    descriptionKey: 'template.mindmap_reading_map.description',
    contentKey: 'template.mindmap_reading_map.content',
    tags: ['study'],
  },
  {
    id: 'chart_weekly_dashboard',
    categoryId: 'productivity',
    nameKey: 'template.chart_weekly_dashboard.name',
    descriptionKey: 'template.chart_weekly_dashboard.description',
    contentKey: 'template.chart_weekly_dashboard.content',
    tags: ['weekly', 'table'],
  },
  {
    id: 'timeline_milestones',
    categoryId: 'work',
    nameKey: 'template.timeline_milestones.name',
    descriptionKey: 'template.timeline_milestones.description',
    contentKey: 'template.timeline_milestones.content',
    tags: ['work', 'review'],
  },
  {
    id: 'columns_comparison',
    categoryId: 'work',
    nameKey: 'template.columns_comparison.name',
    descriptionKey: 'template.columns_comparison.description',
    contentKey: 'template.columns_comparison.content',
    tags: ['decision', 'table'],
  },
  {
    id: 'tabs_alternatives',
    categoryId: 'productivity',
    nameKey: 'template.tabs_alternatives.name',
    descriptionKey: 'template.tabs_alternatives.description',
    contentKey: 'template.tabs_alternatives.content',
    tags: ['planning'],
  },
  {
    id: 'details_faq',
    categoryId: 'writing',
    nameKey: 'template.details_faq.name',
    descriptionKey: 'template.details_faq.description',
    contentKey: 'template.details_faq.content',
    tags: ['writing'],
  },
  {
    id: 'callout_annotations',
    categoryId: 'writing',
    nameKey: 'template.callout_annotations.name',
    descriptionKey: 'template.callout_annotations.description',
    contentKey: 'template.callout_annotations.content',
    tags: ['writing', 'checklist'],
  },
  {
    id: 'blank',
    categoryId: 'productivity',
    nameKey: 'template.blank.name',
    descriptionKey: 'template.blank.description',
    contentKey: 'template.blank.content',
    tags: ['daily'],
  },
  {
    id: 'front_matter_only',
    categoryId: 'productivity',
    nameKey: 'template.front_matter_only.name',
    descriptionKey: 'template.front_matter_only.description',
    contentKey: 'template.front_matter_only.content',
    tags: ['table'],
  },
  {
    id: 'daily_note',
    categoryId: 'productivity',
    nameKey: 'template.daily_note.name',
    descriptionKey: 'template.daily_note.description',
    contentKey: 'template.daily_note.content',
    tags: ['daily'],
  },
  {
    id: 'weekly_review',
    categoryId: 'productivity',
    nameKey: 'template.weekly_review.name',
    descriptionKey: 'template.weekly_review.description',
    contentKey: 'template.weekly_review.content',
    tags: ['weekly', 'review'],
  },
  {
    id: 'monthly_review',
    categoryId: 'productivity',
    nameKey: 'template.monthly_review.name',
    descriptionKey: 'template.monthly_review.description',
    contentKey: 'template.monthly_review.content',
    tags: ['review', 'goal'],
  },
  {
    id: 'annual_review',
    categoryId: 'productivity',
    nameKey: 'template.annual_review.name',
    descriptionKey: 'template.annual_review.description',
    contentKey: 'template.annual_review.content',
    tags: ['review', 'goal'],
  },
  {
    id: 'one_on_one',
    categoryId: 'work',
    nameKey: 'template.one_on_one.name',
    descriptionKey: 'template.one_on_one.description',
    contentKey: 'template.one_on_one.content',
    tags: ['work', 'meeting'],
  },
  {
    id: 'rfc',
    categoryId: 'work',
    nameKey: 'template.rfc.name',
    descriptionKey: 'template.rfc.description',
    contentKey: 'template.rfc.content',
    tags: ['tech', 'decision'],
  },
  {
    id: 'incident_postmortem',
    categoryId: 'work',
    nameKey: 'template.incident_postmortem.name',
    descriptionKey: 'template.incident_postmortem.description',
    contentKey: 'template.incident_postmortem.content',
    tags: ['tech', 'review'],
  },
  {
    id: 'sop',
    categoryId: 'work',
    nameKey: 'template.sop.name',
    descriptionKey: 'template.sop.description',
    contentKey: 'template.sop.content',
    tags: ['checklist', 'work'],
  },
  {
    id: 'zettelkasten_permanent',
    categoryId: 'learning',
    nameKey: 'template.zettelkasten_permanent.name',
    descriptionKey: 'template.zettelkasten_permanent.description',
    contentKey: 'template.zettelkasten_permanent.content',
    tags: ['study', 'writing'],
  },
  {
    id: 'fleeting_note',
    categoryId: 'learning',
    nameKey: 'template.fleeting_note.name',
    descriptionKey: 'template.fleeting_note.description',
    contentKey: 'template.fleeting_note.content',
    tags: ['daily'],
  },
  {
    id: 'literature_note',
    categoryId: 'learning',
    nameKey: 'template.literature_note.name',
    descriptionKey: 'template.literature_note.description',
    contentKey: 'template.literature_note.content',
    tags: ['study', 'writing'],
  },
  {
    id: 'map_of_content',
    categoryId: 'learning',
    nameKey: 'template.map_of_content.name',
    descriptionKey: 'template.map_of_content.description',
    contentKey: 'template.map_of_content.content',
    tags: ['study', 'tech'],
  },
  {
    id: 'sq3r_reading',
    categoryId: 'learning',
    nameKey: 'template.sq3r_reading.name',
    descriptionKey: 'template.sq3r_reading.description',
    contentKey: 'template.sq3r_reading.content',
    tags: ['study', 'checklist'],
  },
  {
    id: 'glossary',
    categoryId: 'learning',
    nameKey: 'template.glossary.name',
    descriptionKey: 'template.glossary.description',
    contentKey: 'template.glossary.content',
    tags: ['study', 'table'],
  },
  {
    id: 'interview_notes',
    categoryId: 'learning',
    nameKey: 'template.interview_notes.name',
    descriptionKey: 'template.interview_notes.description',
    contentKey: 'template.interview_notes.content',
    tags: ['work', 'meeting'],
  },
  {
    id: 'backlog',
    categoryId: 'tasks',
    nameKey: 'template.backlog.name',
    descriptionKey: 'template.backlog.description',
    contentKey: 'template.backlog.content',
    tags: ['work', 'checklist'],
  },
  {
    id: 'competitive_analysis',
    categoryId: 'work',
    nameKey: 'template.competitive_analysis.name',
    descriptionKey: 'template.competitive_analysis.description',
    contentKey: 'template.competitive_analysis.content',
    tags: ['tech', 'table'],
  },
  {
    id: 'decision_log',
    categoryId: 'work',
    nameKey: 'template.decision_log.name',
    descriptionKey: 'template.decision_log.description',
    contentKey: 'template.decision_log.content',
    tags: ['decision', 'review'],
  },
  {
    id: 'onboarding_checklist',
    categoryId: 'work',
    nameKey: 'template.onboarding_checklist.name',
    descriptionKey: 'template.onboarding_checklist.description',
    contentKey: 'template.onboarding_checklist.content',
    tags: ['checklist', 'work'],
  },
  {
    id: 'handover_doc',
    categoryId: 'work',
    nameKey: 'template.handover_doc.name',
    descriptionKey: 'template.handover_doc.description',
    contentKey: 'template.handover_doc.content',
    tags: ['work', 'checklist'],
  },
  {
    id: 'ab_experiment',
    categoryId: 'work',
    nameKey: 'template.ab_experiment.name',
    descriptionKey: 'template.ab_experiment.description',
    contentKey: 'template.ab_experiment.content',
    tags: ['tech', 'table'],
  },
  {
    id: 'character_card',
    categoryId: 'writing',
    nameKey: 'template.character_card.name',
    descriptionKey: 'template.character_card.description',
    contentKey: 'template.character_card.content',
    tags: ['writing'],
  },
  {
    id: 'worldbuilding',
    categoryId: 'writing',
    nameKey: 'template.worldbuilding.name',
    descriptionKey: 'template.worldbuilding.description',
    contentKey: 'template.worldbuilding.content',
    tags: ['writing'],
  },
  {
    id: 'book_review',
    categoryId: 'writing',
    nameKey: 'template.book_review.name',
    descriptionKey: 'template.book_review.description',
    contentKey: 'template.book_review.content',
    tags: ['study', 'writing'],
  },
  {
    id: 'film_review',
    categoryId: 'writing',
    nameKey: 'template.film_review.name',
    descriptionKey: 'template.film_review.description',
    contentKey: 'template.film_review.content',
    tags: ['writing', 'review'],
  },
  {
    id: 'scqa_pyramid',
    categoryId: 'writing',
    nameKey: 'template.scqa_pyramid.name',
    descriptionKey: 'template.scqa_pyramid.description',
    contentKey: 'template.scqa_pyramid.content',
    tags: ['writing', 'work'],
  },
  {
    id: 'longform_article',
    categoryId: 'writing',
    nameKey: 'template.longform_article.name',
    descriptionKey: 'template.longform_article.description',
    contentKey: 'template.longform_article.content',
    tags: ['writing'],
  },
  {
    id: 'medication_log',
    categoryId: 'health',
    nameKey: 'template.medication_log.name',
    descriptionKey: 'template.medication_log.description',
    contentKey: 'template.medication_log.content',
    tags: ['health', 'table'],
  },
  {
    id: 'therapy_prep',
    categoryId: 'health',
    nameKey: 'template.therapy_prep.name',
    descriptionKey: 'template.therapy_prep.description',
    contentKey: 'template.therapy_prep.content',
    tags: ['health', 'review'],
  },
  {
    id: 'health_metrics',
    categoryId: 'health',
    nameKey: 'template.health_metrics.name',
    descriptionKey: 'template.health_metrics.description',
    contentKey: 'template.health_metrics.content',
    tags: ['health', 'table'],
  },
  {
    id: 'quit_tracker',
    categoryId: 'health',
    nameKey: 'template.quit_tracker.name',
    descriptionKey: 'template.quit_tracker.description',
    contentKey: 'template.quit_tracker.content',
    tags: ['health', 'goal', 'checklist'],
  },
  {
    id: 'mood_checkin',
    categoryId: 'health',
    nameKey: 'template.mood_checkin.name',
    descriptionKey: 'template.mood_checkin.description',
    contentKey: 'template.mood_checkin.content',
    tags: ['health', 'daily'],
  },
  {
    id: 'lesson_plan',
    categoryId: 'industry',
    nameKey: 'template.lesson_plan.name',
    descriptionKey: 'template.lesson_plan.description',
    contentKey: 'template.lesson_plan.content',
    tags: ['study', 'planning'],
  },
  {
    id: 'lab_notebook',
    categoryId: 'industry',
    nameKey: 'template.lab_notebook.name',
    descriptionKey: 'template.lab_notebook.description',
    contentKey: 'template.lab_notebook.content',
    tags: ['tech', 'table'],
  },
  {
    id: 'client_profile',
    categoryId: 'industry',
    nameKey: 'template.client_profile.name',
    descriptionKey: 'template.client_profile.description',
    contentKey: 'template.client_profile.content',
    tags: ['work', 'meeting'],
  },
  {
    id: 'sales_call',
    categoryId: 'industry',
    nameKey: 'template.sales_call.name',
    descriptionKey: 'template.sales_call.description',
    contentKey: 'template.sales_call.content',
    tags: ['work', 'checklist'],
  },
  {
    id: 'case_summary',
    categoryId: 'industry',
    nameKey: 'template.case_summary.name',
    descriptionKey: 'template.case_summary.description',
    contentKey: 'template.case_summary.content',
    tags: ['review', 'writing'],
  },
  {
    id: 'flat_comparison',
    categoryId: 'life',
    nameKey: 'template.flat_comparison.name',
    descriptionKey: 'template.flat_comparison.description',
    contentKey: 'template.flat_comparison.content',
    tags: ['finance', 'table'],
  },
]

/**
 * Portable format for exporting/importing a user's template library. Only
 * user-created templates and categories are exported; built-ins are re-seeded
 * by the app itself and stay out of the file.
 */
export interface TemplateLibraryExport {
  app: 'inkstone'
  kind: 'template-library'
  version: 1
  exportedAt: number
  categories: NoteTemplateCategory[]
  templates: NoteTemplate[]
}

/**
 * Bounds applied to an imported library. An export file is untrusted input of
 * arbitrary size, so every variable-length field is clamped here rather than
 * at each consumer, and the entry counts are capped so one paste cannot grow the
 * IndexedDB record past what the gallery can render.
 */
export const TEMPLATE_IMPORT_LIMITS = {
  maxTemplates: 2000,
  maxCategories: 200,
  maxNameLength: 120,
  maxDescriptionLength: 240,
  maxContentLength: 64 * 1024,
  maxTagLength: 30,
  maxTagsPerTemplate: 8,
  maxIdLength: 64,
  maxTextLength: 8 * 1024 * 1024,
  /**
   * Ceiling on the combined body size of one import. The per-entry cap alone
   * would let a file of 2000 full-size templates ask the browser to store 128 MB
   * under a single IndexedDB key.
   */
  maxTotalContentLength: 4 * 1024 * 1024,
} as const

export interface TemplateLibraryParseResult {
  data: TemplateLibraryExport | null
  /** Entries dropped for being malformed or over budget; reported so the UI can say so out loud. */
  dropped: number
  truncated: boolean
}

export function buildTemplateLibraryExport(
  categories: NoteTemplateCategory[],
  templates: NoteTemplate[],
): TemplateLibraryExport {
  return {
    app: 'inkstone',
    kind: 'template-library',
    version: 1,
    exportedAt: Date.now(),
    categories: categories.filter((category) => !category.builtin),
    templates: templates.filter((template) => !template.builtin),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/** A hand-edited export can claim any date; the gallery prints it, so it gets a sane range. */
const EXPORTED_AT_MIN = 0
const EXPORTED_AT_MAX = Date.UTC(2100, 0, 1)

function clampTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), EXPORTED_AT_MIN), EXPORTED_AT_MAX)
}

/**
 * The id character set the app itself generates (`tpl-`/`cat-` plus a base32 tail)
 * and nothing wider: an id becomes a `data-template-id` attribute, a CSS selector
 * and a map key, so a newline or a quote in an imported id is a bug waiting in the
 * gallery rather than data worth keeping.
 */
const EXPORT_ID_RE = /^[0-9a-z_-]{1,64}$/

function isExportId(value: unknown): value is string {
  return typeof value === 'string' && EXPORT_ID_RE.test(value)
}

/**
 * Parses and validates an exported template library. Returns a null `data` when
 * the payload is not a well-formed export; malformed entries are dropped
 * individually so a partially broken file can still be imported.
 */
export function parseTemplateLibraryExport(
  text: string,
  options: { keepFlags?: boolean } = {},
): TemplateLibraryParseResult {
  const empty: TemplateLibraryParseResult = { data: null, dropped: 0, truncated: false }
  if (text.length > TEMPLATE_IMPORT_LIMITS.maxTextLength) return empty
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return empty
  }
  if (!isRecord(value) || value.app !== 'inkstone' || value.kind !== 'template-library' || value.version !== 1)
    return empty
  let dropped = 0
  let truncated = false
  const rawCategories = Array.isArray(value.categories) ? value.categories : []
  const rawTemplates = Array.isArray(value.templates) ? value.templates : []
  if (rawCategories.length > TEMPLATE_IMPORT_LIMITS.maxCategories) {
    truncated = true
    dropped += rawCategories.length - TEMPLATE_IMPORT_LIMITS.maxCategories
  }
  if (rawTemplates.length > TEMPLATE_IMPORT_LIMITS.maxTemplates) {
    truncated = true
    dropped += rawTemplates.length - TEMPLATE_IMPORT_LIMITS.maxTemplates
  }
  const seenCategoryIds = new Set<string>()
  const categories: NoteTemplateCategory[] = []
  for (const candidate of rawCategories.slice(0, TEMPLATE_IMPORT_LIMITS.maxCategories)) {
    if (!isExportCategory(candidate)) {
      dropped++
      continue
    }
    const category = normalizeExportCategory(candidate)
    if (seenCategoryIds.has(category.id)) {
      dropped++
      continue
    }
    seenCategoryIds.add(category.id)
    categories.push(category)
  }
  const templates: NoteTemplate[] = []
  let contentBudget = TEMPLATE_IMPORT_LIMITS.maxTotalContentLength
  for (const candidate of rawTemplates.slice(0, TEMPLATE_IMPORT_LIMITS.maxTemplates)) {
    const template = normalizeExportTemplate(candidate, options.keepFlags === true)
    if (!template) {
      dropped++
      continue
    }
    if (template.content.length > contentBudget) {
      truncated = true
      dropped++
      continue
    }
    contentBudget -= template.content.length
    templates.push(template)
  }
  return {
    data: {
      app: 'inkstone',
      kind: 'template-library',
      version: 1,
      exportedAt: clampTimestamp(value.exportedAt, Date.now()),
      categories,
      templates,
    },
    dropped,
    truncated,
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isExportCategory(value: unknown): value is NoteTemplateCategory {
  if (!isRecord(value)) return false
  return isExportId(value.id) &&
    typeof value.name === 'string' &&
    value.builtin === false &&
    isFiniteNumber(value.position) &&
    isFiniteNumber(value.createdAt)
}

function normalizeExportCategory(value: NoteTemplateCategory): NoteTemplateCategory {
  return {
    ...value,
    id: clampText(value.id, TEMPLATE_IMPORT_LIMITS.maxIdLength),
    name: clampText(value.name, TEMPLATE_IMPORT_LIMITS.maxNameLength),
  }
}

/** Validates one entry and clamps its fields; returns null when it is unusable. */
function normalizeExportTemplate(value: unknown, keepFlags: boolean): NoteTemplate | null {
  if (!isRecord(value)) return null
  if (!isExportId(value.id) ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.content !== 'string' ||
    value.builtin !== false ||
    typeof value.isPinned !== 'boolean' ||
    typeof value.isStarred !== 'boolean' ||
    !Array.isArray(value.tags) ||
    !value.tags.every((tag) => typeof tag === 'string') ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt)) {
    return null
  }
  const template: NoteTemplate = {
    id: clampText(value.id, TEMPLATE_IMPORT_LIMITS.maxIdLength),
    categoryId: typeof value.categoryId === 'string' && isExportId(value.categoryId)
      ? value.categoryId
      : null,
    name: clampText(value.name, TEMPLATE_IMPORT_LIMITS.maxNameLength),
    description: clampText(value.description, TEMPLATE_IMPORT_LIMITS.maxDescriptionLength),
    content: clampText(value.content, TEMPLATE_IMPORT_LIMITS.maxContentLength),
    tags: value.tags
      .slice(0, TEMPLATE_IMPORT_LIMITS.maxTagsPerTemplate)
      .map((tag) => clampText(tag, TEMPLATE_IMPORT_LIMITS.maxTagLength)),
    builtin: false,
    // A file from another device must not pre-pin the gallery; the account's own
    // snapshot is the user's library, so it round-trips the marks unchanged.
    isPinned: keepFlags ? value.isPinned : false,
    isStarred: keepFlags ? value.isStarred : false,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
  return template.id && template.content ? template : null
}
