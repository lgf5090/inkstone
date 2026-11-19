import { t } from '../../../lib/i18n'
import type { DocumentLabels } from './export-doc'

export function documentLabels(): DocumentLabels {
  return {
    summary: t('development.database.doc.summary'),
    databaseType: t('development.database.doc.database_type'),
    tableStructure: t('development.database.doc.table_structure'),
    relationships: t('development.database.doc.relationships'),
    views: t('development.database.doc.views'),
    indexes: t('development.database.doc.indexes'),
    uniqueConstraints: t('development.database.doc.unique_constraints'),
    name: t('development.database.doc.name'),
    type: t('development.database.doc.type'),
    settings: t('development.database.doc.settings'),
    references: t('development.database.doc.references'),
    note: t('development.database.doc.note'),
    primaryKey: t('development.database.doc.primary_key'),
    notNull: t('development.database.doc.not_null'),
    nullable: t('development.database.doc.nullable'),
    unique: t('development.database.doc.unique'),
    autoincrement: t('development.database.doc.autoincrement'),
    defaultLabel: t('development.database.doc.default_label'),
    diagram: t('development.database.doc.diagram'),
    noTables: t('development.database.doc.no_tables'),
    viewDefinition: t('development.database.doc.view_definition'),
  }
}