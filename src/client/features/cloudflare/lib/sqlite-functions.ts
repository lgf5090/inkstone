/**
 * The SQLite functions the D1 editor offers while typing.
 *
 * A trimmed copy of the official function list, with the signature shown beside the name. It is data
 * rather than copy: a function is called `json_extract` in every language, and the one-line note says
 * what the manual says in the shortest form that fits a completion row.
 */
export interface SqliteFunctionInfo {
  name: string
  args: string
  desc: string
}

export const SQLITE_FUNCTIONS: readonly SqliteFunctionInfo[] = [
  { name: 'abs', args: 'X', desc: 'Absolute value of X' },
  { name: 'avg', args: 'X', desc: 'Average of X across the group, NULLs ignored' },
  { name: 'char', args: 'X1, X2, ...', desc: 'String from Unicode code points' },
  { name: 'changes', args: '', desc: 'Rows changed by the most recent statement' },
  { name: 'coalesce', args: 'X, Y, ...', desc: 'First non-NULL argument' },
  { name: 'concat', args: 'X, Y, ...', desc: 'Concatenate arguments, NULL as empty' },
  { name: 'concat_ws', args: 'SEP, X, ...', desc: 'Concatenate with a separator' },
  { name: 'count', args: '* | X', desc: 'Row count; count(*) includes NULLs' },
  { name: 'date', args: 'timestr, modifier...', desc: 'Date as YYYY-MM-DD' },
  { name: 'datetime', args: 'timestr, modifier...', desc: 'Timestamp as YYYY-MM-DD HH:MM:SS' },
  { name: 'format', args: 'FMT, X...', desc: 'printf-style formatting' },
  { name: 'glob', args: 'X, Y', desc: 'Whether X matches glob Y (case sensitive)' },
  { name: 'group_concat', args: 'X [, SEP]', desc: 'Concatenate the group, comma by default' },
  { name: 'hex', args: 'X', desc: 'Hexadecimal rendering of X' },
  { name: 'ifnull', args: 'X, Y', desc: 'Y when X is NULL' },
  { name: 'iif', args: 'cond, A, B', desc: 'A when cond holds, otherwise B' },
  { name: 'instr', args: 'X, Y', desc: 'First 1-based position of Y in X' },
  { name: 'json', args: 'X', desc: 'Parse X and return canonical JSON text' },
  { name: 'json_array', args: 'X...', desc: 'Build a JSON array' },
  { name: 'json_array_length', args: 'X [, path]', desc: 'Length of a JSON array' },
  { name: 'json_extract', args: 'X, path...', desc: 'Value at a JSON path' },
  { name: 'json_object', args: 'label, value...', desc: 'Build a JSON object' },
  { name: 'json_quote', args: 'X', desc: 'SQL value as JSON text' },
  { name: 'json_set', args: 'X, path, value...', desc: 'Set a JSON path, overwriting' },
  { name: 'json_insert', args: 'X, path, value...', desc: 'Insert a JSON path, keeping existing' },
  { name: 'json_remove', args: 'X, path...', desc: 'Remove a JSON path' },
  { name: 'json_type', args: 'X [, path]', desc: 'JSON value type' },
  { name: 'json_valid', args: 'X', desc: 'Whether X is valid JSON' },
  { name: 'last_insert_rowid', args: '', desc: 'rowid of the most recent insert' },
  { name: 'length', args: 'X', desc: 'Characters in a string, bytes in a BLOB' },
  { name: 'like', args: 'X, Y [, ESC]', desc: 'Whether X matches LIKE Y (case insensitive)' },
  { name: 'lower', args: 'X', desc: 'Lower-case (ASCII)' },
  { name: 'ltrim', args: 'X [, Y]', desc: 'Trim leading blanks or characters from Y' },
  { name: 'max', args: 'X, Y... | X', desc: 'Scalar maximum, or group maximum' },
  { name: 'min', args: 'X, Y... | X', desc: 'Scalar minimum, or group minimum' },
  { name: 'nullif', args: 'X, Y', desc: 'NULL when X equals Y, otherwise X' },
  { name: 'printf', args: 'FMT, X...', desc: 'printf-style formatting, same as format' },
  { name: 'quote', args: 'X', desc: 'SQL literal for X' },
  { name: 'random', args: '', desc: 'Random 64-bit integer' },
  { name: 'randomblob', args: 'N', desc: 'N random bytes as a BLOB' },
  { name: 'replace', args: 'X, Y, Z', desc: 'Replace every Y in X with Z' },
  { name: 'round', args: 'X [, N]', desc: 'Round to N decimal places' },
  { name: 'rtrim', args: 'X [, Y]', desc: 'Trim trailing blanks or characters from Y' },
  { name: 'sign', args: 'X', desc: 'Returns -1, 0 or 1' },
  { name: 'sqlite_version', args: '', desc: 'SQLite version string' },
  { name: 'strftime', args: 'FMT, timestr...', desc: 'Format a time with a pattern' },
  { name: 'substr', args: 'X, Y [, Z]', desc: 'Z characters from position Y' },
  { name: 'sum', args: 'X', desc: 'Group sum, NULLs ignored' },
  { name: 'total', args: 'X', desc: 'Group sum, NULL counted as 0.0' },
  { name: 'trim', args: 'X [, Y]', desc: 'Trim both ends of blanks or characters from Y' },
  { name: 'typeof', args: 'X', desc: 'Storage class of the value' },
  { name: 'unicode', args: 'X', desc: 'Code point of the first character' },
  { name: 'unixepoch', args: 'timestr...', desc: 'Unix timestamp in seconds' },
  { name: 'upper', args: 'X', desc: 'Upper-case (ASCII)' },
  { name: 'zeroblob', args: 'N', desc: 'N zero bytes as a BLOB' },
]

export function functionCompletionLabel(fn: SqliteFunctionInfo): string {
  return `${fn.name}(${fn.args})`
}
