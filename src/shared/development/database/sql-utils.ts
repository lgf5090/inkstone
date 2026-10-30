/**
 * The database Studio's SQL text helpers.
 *
 * The classifier and the splitter live in `shared/cloudflare/sql-utils.ts`, which understands
 * `CREATE TEMP TRIGGER`, `CASE ... END`, `WITH`-prefixed DML and the PRAGMA read allowlist. Keeping a
 * second copy here is what let `WITH ... DELETE` past every write guard, so this module only re-exports.
 */
export {
  findStatementRangeAt,
  isDestructiveSql,
  isSchemaChangeSql,
  isWriteSql,
  quoteIdent,
  splitSqlStatements,
} from '../../cloudflare/sql-utils'
