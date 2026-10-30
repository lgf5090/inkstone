import { quoteIdent } from '@shared/development/database/sql-utils'

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export function listObjectsSql(excludeInternal = true): string {
  return `SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','view','trigger')${excludeInternal ? " AND name NOT LIKE 'sqlite_%'" : ''} ORDER BY type, name`
}

export function searchObjectsSql(excludeInternal = true): string {
  return `SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name LIKE ? ESCAPE '\\'${excludeInternal ? " AND name NOT LIKE 'sqlite_%'" : ''} ORDER BY type, name`
}

export function tableInfoSql(table: string): string {
  return `PRAGMA table_info(${quoteIdent(table)})`
}

export function tableDdlSql(): string {
  return "SELECT sql FROM sqlite_master WHERE type IN ('table','view','trigger') AND name = ? LIMIT 1"
}

export function indexListSql(table?: string): string {
  return table
    ? `PRAGMA index_list(${quoteIdent(table)})`
    : "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY tbl_name, name"
}

export function foreignKeysSql(table: string): string {
  return `PRAGMA foreign_key_list(${quoteIdent(table)})`
}

export function previewSql(table: string, limit = 50): string {
  const safe = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  return `SELECT * FROM ${quoteIdent(table)} LIMIT ${safe}`
}

export function rowCountSql(table: string): string {
  return `SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`
}

export function explainSql(sql: string): string {
  return `EXPLAIN QUERY PLAN ${sql}`
}