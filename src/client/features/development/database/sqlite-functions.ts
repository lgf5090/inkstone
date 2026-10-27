import type { MessageKey } from '../../../lib/i18n'

export interface SqliteFunctionInfo {
  name: string
  args: string
  descKey: MessageKey
}

function descKey(name: string): MessageKey {
  return `development.database.functions.${name}` as MessageKey
}

export const SQLITE_FUNCTIONS: SqliteFunctionInfo[] = [
  { name: 'abs', args: 'X', descKey: descKey('abs') },
  { name: 'avg', args: 'X', descKey: descKey('avg') },
  { name: 'char', args: 'X1, X2, ...', descKey: descKey('char') },
  { name: 'changes', args: '', descKey: descKey('changes') },
  { name: 'coalesce', args: 'X, Y, ...', descKey: descKey('coalesce') },
  { name: 'concat', args: 'X, Y, ...', descKey: descKey('concat') },
  { name: 'concat_ws', args: 'SEP, X, ...', descKey: descKey('concat_ws') },
  { name: 'count', args: '* | X', descKey: descKey('count') },
  { name: 'date', args: 'timestr, modifier...', descKey: descKey('date') },
  { name: 'datetime', args: 'timestr, modifier...', descKey: descKey('datetime') },
  { name: 'format', args: 'FMT, X...', descKey: descKey('format') },
  { name: 'glob', args: 'X, Y', descKey: descKey('glob') },
  { name: 'group_concat', args: 'X [, SEP]', descKey: descKey('group_concat') },
  { name: 'hex', args: 'X', descKey: descKey('hex') },
  { name: 'ifnull', args: 'X, Y', descKey: descKey('ifnull') },
  { name: 'iif', args: 'cond, A, B', descKey: descKey('iif') },
  { name: 'instr', args: 'X, Y', descKey: descKey('instr') },
  { name: 'json', args: 'X', descKey: descKey('json') },
  { name: 'json_array', args: 'X...', descKey: descKey('json_array') },
  { name: 'json_array_length', args: 'X [, path]', descKey: descKey('json_array_length') },
  { name: 'json_extract', args: 'X, path...', descKey: descKey('json_extract') },
  { name: 'json_object', args: 'label, value...', descKey: descKey('json_object') },
  { name: 'json_quote', args: 'X', descKey: descKey('json_quote') },
  { name: 'json_set', args: 'X, path, value...', descKey: descKey('json_set') },
  { name: 'json_insert', args: 'X, path, value...', descKey: descKey('json_insert') },
  { name: 'json_remove', args: 'X, path...', descKey: descKey('json_remove') },
  { name: 'json_type', args: 'X [, path]', descKey: descKey('json_type') },
  { name: 'json_valid', args: 'X', descKey: descKey('json_valid') },
  { name: 'last_insert_rowid', args: '', descKey: descKey('last_insert_rowid') },
  { name: 'length', args: 'X', descKey: descKey('length') },
  { name: 'like', args: 'X, Y [, ESC]', descKey: descKey('like') },
  { name: 'lower', args: 'X', descKey: descKey('lower') },
  { name: 'ltrim', args: 'X [, Y]', descKey: descKey('ltrim') },
  { name: 'max', args: 'X, Y... | X', descKey: descKey('max') },
  { name: 'min', args: 'X, Y... | X', descKey: descKey('min') },
  { name: 'nullif', args: 'X, Y', descKey: descKey('nullif') },
  { name: 'printf', args: 'FMT, X...', descKey: descKey('printf') },
  { name: 'quote', args: 'X', descKey: descKey('quote') },
  { name: 'random', args: '', descKey: descKey('random') },
  { name: 'randomblob', args: 'N', descKey: descKey('randomblob') },
  { name: 'replace', args: 'X, Y, Z', descKey: descKey('replace') },
  { name: 'round', args: 'X [, N]', descKey: descKey('round') },
  { name: 'rtrim', args: 'X [, Y]', descKey: descKey('rtrim') },
  { name: 'sign', args: 'X', descKey: descKey('sign') },
  { name: 'sqlite_version', args: '', descKey: descKey('sqlite_version') },
  { name: 'strftime', args: 'FMT, timestr...', descKey: descKey('strftime') },
  { name: 'substr', args: 'X, Y [, Z]', descKey: descKey('substr') },
  { name: 'sum', args: 'X', descKey: descKey('sum') },
  { name: 'total', args: 'X', descKey: descKey('total') },
  { name: 'trim', args: 'X [, Y]', descKey: descKey('trim') },
  { name: 'typeof', args: 'X', descKey: descKey('typeof') },
  { name: 'unicode', args: 'X', descKey: descKey('unicode') },
  { name: 'unixepoch', args: 'timestr...', descKey: descKey('unixepoch') },
  { name: 'upper', args: 'X', descKey: descKey('upper') },
  { name: 'zeroblob', args: 'N', descKey: descKey('zeroblob') },
]

export function functionCompletionLabel(fn: SqliteFunctionInfo): string {
  return `${fn.name}(${fn.args})`
}
