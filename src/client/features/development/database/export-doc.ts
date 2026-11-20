import type { ParsedColumn, ParsedTable, SchemaModel } from '@shared/development/database/types'
import {
  constraintsFromTable,
  relationshipCardinality,
  schemaToDiagram,
  type DiagramDraft,
  type DiagramRelationship,
} from './diagram'

export interface DocumentLabels {
  summary: string
  databaseType: string
  tableStructure: string
  relationships: string
  views: string
  indexes: string
  uniqueConstraints: string
  name: string
  type: string
  settings: string
  references: string
  note: string
  primaryKey: string
  notNull: string
  nullable: string
  unique: string
  autoincrement: string
  defaultLabel: string
  diagram: string
  noTables: string
  viewDefinition: string
}

const DEFAULT_TITLE = 'Schema'
const DEFAULT_COLUMN_TYPE = 'TEXT'
const DATABASE_NAME = 'SQLite'
const COLUMNS_HEADER = 'Columns'
const UNIQUE_MARK = '✓'

const MERMAID_UNSAFE = /[^\p{L}\p{N}_-]/gu
const ANCHOR_UNSAFE = /[^\p{L}\p{N}\s-]/gu
const PIPE = /\|/g
const LINE_BREAK = /\r?\n/g
const SINGLE_WORD = /^[^\s,]+$/

function mermaidName(name: string): string {
  return name.replace(MERMAID_UNSAFE, '_')
}

function mermaidLabel(columns: string[]): string {
  const label = columns.map(mermaidName).join(', ')
  return SINGLE_WORD.test(label) ? label : `"${label}"`
}

function mermaidFromDraft(draft: DiagramDraft): string {
  if (draft.tables.length === 0) return 'erDiagram\n'

  const entities = draft.tables
    .map((table) => {
      const fields = table.columns.map(
        (column) => `\t\t${column.type.trim() || DEFAULT_COLUMN_TYPE} ${mermaidName(column.name)}`,
      )
      const body = fields.length > 0 ? `${fields.join('\n')}\n` : ''
      return `\t${mermaidName(table.name)} {\n${body}\t}`
    })
    .join('\n\n')

  const relations = draft.relationships
    .map((relationship) => {
      const cardinality = relationshipCardinality(draft, relationship) === '1:1' ? '||--||' : '}o--||'
      const start = mermaidName(relationship.startTableId)
      const end = mermaidName(relationship.endTableId)
      return `\t${start} ${cardinality} ${end} : ${mermaidLabel(relationship.startColumns)}`
    })
    .join('\n')

  return `erDiagram\n${relations ? `${relations}\n\n` : ''}${entities}`
}

export function schemaToMermaid(schema: SchemaModel): string {
  return mermaidFromDraft(schemaToDiagram(schema))
}

function codeSpan(text: string): string {
  return text.includes('`') ? `\`\`${text}\`\`` : `\`${text}\``
}

function cell(text: string): string {
  return text.replace(PIPE, '\\|').replace(LINE_BREAK, ' ')
}

function markdownTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`
  const separator = `| ${headers.map(() => '---').join(' | ')} |`
  return [line(headers), separator, ...rows.map(line)].join('\n')
}

function anchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(ANCHOR_UNSAFE, '')
    .replace(/\s+/g, '-')
}

function columnSettings(column: ParsedColumn, labels: DocumentLabels): string {
  const parts: string[] = []
  if (column.pk) parts.push(labels.primaryKey)
  if (column.notNull) parts.push(labels.notNull)
  if (column.unique) parts.push(labels.unique)
  if (column.autoIncrement) parts.push(labels.autoincrement)
  if (column.default !== null) parts.push(`${labels.defaultLabel}: ${column.default}`)
  return parts.join(', ')
}

function relationReference(relationship: DiagramRelationship): string {
  if (relationship.name) return relationship.name
  const local = `${relationship.startTableId}.${relationship.startColumns.join(', ')}`
  const remote = `${relationship.endTableId}.${relationship.endColumns.join(', ')}`
  return `${local} → ${remote}`
}

function columnReferences(
  table: ParsedTable,
  column: ParsedColumn,
  relationships: DiagramRelationship[],
): string {
  return relationships
    .filter(
      (relationship) =>
        relationship.startTableId === table.name
        && relationship.startColumns.includes(column.name),
    )
    .map(relationReference)
    .join(', ')
}

const COLUMN_HEADERS = (labels: DocumentLabels): string[] => [
  labels.name,
  labels.type,
  labels.settings,
  labels.references,
  labels.note,
]

function tableSection(
  schema: SchemaModel,
  table: ParsedTable,
  relationships: DiagramRelationship[],
  labels: DocumentLabels,
): string {
  const rows = table.columns.map((column) => [
    codeSpan(column.name),
    column.type,
    columnSettings(column, labels),
    columnReferences(table, column, relationships),
    '',
  ])
  const parts = [
    `### ${codeSpan(table.name)}`,
    markdownTable(COLUMN_HEADERS(labels), rows),
  ]

  const indexes = schema.indexes.filter((index) => index.table === table.name)
  if (indexes.length > 0) {
    const indexRows = indexes.map((index) => [
      codeSpan(index.name),
      index.unique ? UNIQUE_MARK : '',
      index.columns.map(codeSpan).join(', '),
    ])
    parts.push(
      `#### ${labels.indexes}\n\n${markdownTable([labels.name, labels.unique, COLUMNS_HEADER], indexRows)}`,
    )
  }

  const uniqueRows = constraintsFromTable(table)
    .filter((constraint) => constraint.kind === 'unique')
    .map((constraint) => [
      constraint.name ? codeSpan(constraint.name) : '',
      (constraint.uniqueColumns ?? []).map(codeSpan).join(', '),
    ])
  if (uniqueRows.length > 0) {
    parts.push(
      `#### ${labels.uniqueConstraints}\n\n${markdownTable([labels.name, COLUMNS_HEADER], uniqueRows)}`,
    )
  }

  return parts.join('\n\n')
}

function relationshipLine(draft: DiagramDraft, relationship: DiagramRelationship): string {
  const cardinality = relationshipCardinality(draft, relationship)
  const name = relationship.name ? `${codeSpan(relationship.name)}, ` : ''
  const local = relationship.startColumns.map(codeSpan).join(', ')
  const remote = relationship.endColumns.map(codeSpan).join(', ')
  const start = codeSpan(relationship.startTableId)
  const end = codeSpan(relationship.endTableId)
  return `- **${start} → ${end}** (${name}${cardinality}): ${local} → ${remote}`
}

function viewSection(view: SchemaModel['views'][number], labels: DocumentLabels): string {
  return (
    `### ${codeSpan(view.name)}\n\n#### ${labels.viewDefinition}\n\n`
    + `\`\`\`sql\n${view.sql}\n\`\`\``
  )
}

export function schemaToMarkdown(
  schema: SchemaModel,
  labels: DocumentLabels,
  options: { title?: string } = {},
): string {
  const heading = `# ${options.title ?? DEFAULT_TITLE} documentation`

  if (schema.tables.length === 0) return `${heading}\n\n${labels.noTables}`

  const draft = schemaToDiagram(schema)
  const relationships = draft.relationships
  const views = schema.views

  const summary = [
    `- [${labels.databaseType}](#${anchor(labels.databaseType)})`,
    `- [${labels.tableStructure}](#${anchor(labels.tableStructure)})`,
    ...schema.tables.map((table) => `  - [${codeSpan(table.name)}](#${anchor(table.name)})`),
    `- [${labels.relationships}](#${anchor(labels.relationships)})`,
    ...(views.length > 0 ? [`- [${labels.views}](#${anchor(labels.views)})`] : []),
    `- [${labels.diagram}](#${anchor(labels.diagram)})`,
  ].join('\n')

  const tables = schema.tables
    .map((table) => tableSection(schema, table, relationships, labels))
    .join('\n\n')

  const relationshipList = relationships
    .map((relationship) => relationshipLine(draft, relationship))
    .join('\n')

  const sections = [
    heading,
    `## ${labels.summary}\n\n${summary}`,
    `## ${labels.databaseType}\n\n- ${DATABASE_NAME}`,
    `## ${labels.tableStructure}\n\n${tables}`,
    `## ${labels.relationships}${relationshipList ? `\n\n${relationshipList}` : ''}`,
    ...(views.length > 0
      ? [`## ${labels.views}\n\n${views.map((view) => viewSection(view, labels)).join('\n\n')}`]
      : []),
    `## ${labels.diagram}\n\n\`\`\`mermaid\n${mermaidFromDraft(draft)}\n\`\`\``,
  ]

  return sections.join('\n\n')
}