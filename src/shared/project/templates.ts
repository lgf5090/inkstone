/**
 * The built-in board templates, rewritten as starting points rather than copied verbatim: each carries
 * its property set, its views and a couple of sample cards so a new board is immediately usable. Ids
 * are stable 27-character slugs so re-instantiating a template never collides with a live board's ids
 * (the importer assigns fresh ids anyway).
 */
import type { ProjectProperty, ProjectPropertyType, ProjectViewType } from './model'
import { PROJECT_TEMPLATE_ZH } from '../locales/zh-CN-project'

const tid = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(27, '0').slice(0, 27)

function prop(name: string, type: ProjectPropertyType, options: string[] = []): ProjectProperty {
  return {
    id: tid(`p${name}`),
    name,
    type,
    options: options.map((value) => ({ id: tid(`o${name}${value}`), value, color: '' })),
  }
}

export interface ProjectTemplateCard {
  title: string
  values?: Record<string, string>
  contents?: { type: 'text' | 'checkbox' | 'divider', title: string, checked?: boolean }[]
}

export interface ProjectTemplate {
  id: string
  title: string
  icon: string
  description: string
  properties: ProjectProperty[]
  views: { title: string, viewType: ProjectViewType, groupById?: string }[]
  cards: ProjectTemplateCard[]
}

const status = prop('Status', 'select', ['Not started', 'In progress', 'Done'])
const priority = prop('Priority', 'select', ['Low', 'Medium', 'High'])

export const BUILT_IN_PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: tid('tplprojecttasks'),
    title: 'Project Tasks',
    icon: '🎯',
    description: 'Track work with status, priority and assignee.',
    properties: [status, priority, prop('Assignee', 'person'), prop('Due Date', 'date')],
    views: [
      { title: 'Board', viewType: 'board', groupById: status.id },
      { title: 'Table', viewType: 'table' },
    ],
    cards: [
      { title: 'Define the goal', values: { [status.id]: status.options[0]!.id }, contents: [{ type: 'text', title: 'What does done look like?' }] },
      { title: 'Break into tasks', values: { [status.id]: status.options[0]!.id } },
      { title: 'Ship it', values: { [status.id]: status.options[2]!.id } },
    ],
  },
  {
    id: tid('tplpersonaltasks'),
    title: 'Personal Tasks',
    icon: '✔️',
    description: 'A simple checklist for your own week.',
    properties: [prop('Occurrence', 'select', ['Once', 'Daily', 'Weekly']), prop('Completed', 'checkbox')],
    views: [{ title: 'Table', viewType: 'table' }, { title: 'Board', viewType: 'board', groupById: tid('pOccurrence') }],
    cards: [
      { title: 'Plan the week', contents: [{ type: 'checkbox', title: 'Review calendar', checked: false }] },
      { title: 'Inbox zero', contents: [{ type: 'checkbox', title: 'Clear inbox', checked: false }] },
    ],
  },
  {
    id: tid('tplmeetingagenda'),
    title: 'Meeting Agenda',
    icon: '🍩',
    description: 'Agenda, notes and action items for a meeting.',
    properties: [status, prop('Owner', 'person')],
    views: [{ title: 'Board', viewType: 'board', groupById: status.id }],
    cards: [
      { title: 'Review last actions', contents: [{ type: 'text', title: 'What changed since last time?' }] },
      { title: 'Decisions needed', contents: [{ type: 'divider', title: '' }] },
    ],
  },
  {
    id: tid('tplpersonalgoals'),
    title: 'Personal Goals',
    icon: '⛰️',
    description: 'Goals with category and target date.',
    properties: [status, prop('Category', 'select', ['Health', 'Career', 'Learning']), prop('Due Date', 'date')],
    views: [{ title: 'Board', viewType: 'board', groupById: status.id }, { title: 'Calendar', viewType: 'calendar' }],
    cards: [{ title: 'Read one book a month', values: { [status.id]: status.options[1]!.id } }],
  },
  {
    id: tid('tplcontentcalendar'),
    title: 'Content Calendar',
    icon: '📅',
    description: 'Plan posts by channel and publish date.',
    properties: [status, prop('Channel', 'multiSelect', ['Blog', 'Social', 'Video']), prop('Publish Date', 'date')],
    views: [{ title: 'Calendar', viewType: 'calendar' }, { title: 'Board', viewType: 'board', groupById: status.id }],
    cards: [{ title: 'Announce the release', values: { [status.id]: status.options[0]!.id } }],
  },
  {
    id: tid('tplroadmap'),
    title: 'Roadmap',
    icon: '🗺️',
    description: 'Quarters, themes and deliverables.',
    properties: [status, prop('Sprint', 'select', ['Q1', 'Q2', 'Q3', 'Q4']), priority],
    views: [{ title: 'Board', viewType: 'board', groupById: tid('pSprint') }, { title: 'Table', viewType: 'table' }],
    cards: [{ title: 'Theme: reliability', values: { [priority.id]: priority.options[2]!.id } }],
  },
  {
    id: tid('tplwelcome'),
    title: 'Welcome to Boards',
    icon: '👋',
    description: 'A tour of what a board can do.',
    properties: [status, priority, prop('Due Date', 'date')],
    views: [
      { title: 'Table', viewType: 'table' },
      { title: 'Board', viewType: 'board', groupById: status.id },
      { title: 'Gallery', viewType: 'gallery' },
      { title: 'Calendar', viewType: 'calendar' },
    ],
    cards: [
      { title: 'Open a card to edit it', contents: [{ type: 'text', title: 'Cards hold properties, content and comments.' }] },
      { title: 'Switch views above', contents: [{ type: 'text', title: 'The same cards, four ways.' }] },
      { title: 'Add your own cards', values: { [status.id]: status.options[0]!.id } },
    ],
  },
]

/** Resolve a built-in template's demo strings into the reader's locale; other locales keep the source. */
export function localizeProjectTemplate(template: ProjectTemplate, locale: string): ProjectTemplate {
  if (!locale.startsWith('zh')) return template
  const tr = (value: string): string => PROJECT_TEMPLATE_ZH[value] ?? value
  return {
    ...template,
    title: tr(template.title),
    description: tr(template.description),
    properties: template.properties.map((property) => ({
      ...property,
      name: tr(property.name),
      options: property.options.map((option) => ({ ...option, value: tr(option.value) })),
    })),
    views: template.views.map((view) => ({ ...view, title: tr(view.title) })),
    cards: template.cards.map((card) => ({
      ...card,
      title: tr(card.title),
      contents: card.contents?.map((content) => ({ ...content, title: tr(content.title) })),
    })),
  }
}