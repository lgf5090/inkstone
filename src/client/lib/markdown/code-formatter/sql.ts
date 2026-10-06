export type SqlKeywordCase = 'upper' | 'lower' | 'keep';

const PH_HEAD = '__inkstone_sql_';
const PH_TAIL = '__';
const PH_PATTERN = /__inkstone_sql_(\d+)__/g;

const LITERAL = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|--[^\r\n]*|\/\*[\s\S]*?\*\/|[a-zA-Z0-9_$]+\.[a-zA-Z0-9_$]+)/g;

const KEYWORDS = [
  'INSERT INTO',
  'DELETE FROM',
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE INDEX',
  'DROP TABLE',
  'DROP VIEW',
  'DROP INDEX',
  'ALTER TABLE',
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'INNER JOIN',
  'NATURAL JOIN',
  'JOIN',
  'GROUP BY',
  'ORDER BY',
  'PARTITION BY',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'ON CONFLICT',
  'IS NOT NULL',
  'IS NULL',
  'NOT IN',
  'NOT NULL',
  'PRIMARY KEY',
  'FOREIGN KEY',
  'UNIQUE',
  'REFERENCES',
  'DEFAULT',
  'SELECT',
  'FROM',
  'WHERE',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'SET',
  'VALUES',
  'UPDATE',
  'DISTINCT',
  'BETWEEN',
  'LIKE',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'AS',
  'AND',
  'OR',
  'NOT',
  'IN',
  'ON',
  'BY',
  'ASC',
  'DESC',
  'WITH',
  'RETURNING',
  'USING',
  'EXISTS',
  'CAST',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'GRANT',
  'REVOKE',
];

const CLAUSES = [
  'INSERT INTO',
  'DELETE FROM',
  'LEFT OUTER JOIN',
  'RIGHT OUTER JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'INNER JOIN',
  'NATURAL JOIN',
  'GROUP BY',
  'ORDER BY',
  'PARTITION BY',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'ON CONFLICT',
  'SELECT',
  'FROM',
  'WHERE',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'SET',
  'VALUES',
  'UPDATE',
  'JOIN',
  'WITH',
  'RETURNING',
  'WINDOW',
  'FETCH',
];

function maskLiterals(sql: string): { masked: string, blocks: string[] } {
  const blocks: string[] = [];
  const masked = sql.replace(LITERAL, (match) => {
    blocks.push(match);
    return PH_HEAD + (blocks.length - 1) + PH_TAIL;
  });
  return { masked, blocks };
}

function restoreLiterals(text: string, blocks: string[]): string {
  return text.replace(PH_PATTERN, (match, index: string) => blocks[Number(index)] ?? match);
}

function keywordPattern(words: string[]): RegExp {
  const body = words.map((word) => word.replace(/\s+/g, '\\s+')).join('|');
  return new RegExp(`\\b(${body})\\b`, 'gi');
}

function clausePattern(words: string[]): RegExp {
  const body = words.map((word) => word.replace(/\s+/g, '\\s+')).join('|');
  return new RegExp(`\\s+(${body})\\b`, 'gi');
}

function applyCase(word: string, keywordCase: SqlKeywordCase): string {
  if (keywordCase === 'upper') return word.toUpperCase();
  if (keywordCase === 'lower') return word.toLowerCase();
  return word;
}

export function formatSql(sql: string, keywordCase: SqlKeywordCase = 'upper'): string {
  const { masked, blocks } = maskLiterals(sql);
  let text = masked.replace(/([a-zA-Z0-9_$])\s*(===|!==|!=|<>|<=|>=|=|<|>)\s*([a-zA-Z0-9_$'"`])/g, '$1 $2 $3');
  text = text.replace(/,\s*/g, ', ');
  text = text.replace(/\s+/g, ' ').trim();

  if (keywordCase !== 'keep') text = text.replace(keywordPattern(KEYWORDS), (word) => applyCase(word, keywordCase));
  text = text.replace(clausePattern(CLAUSES), (_match, word: string) => `\n${word}`);

  return restoreLiterals(text, blocks).trim();
}
