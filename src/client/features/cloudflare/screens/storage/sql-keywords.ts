/**
 * SQL vocabulary the D1 editor prints as syntax, not as interface copy.
 *
 * `NOT NULL` is the column constraint's own spelling; translating it would produce SQL that does not
 * run. Keeping it here means the i18n gate still sees a rule it can check while the screens stay
 * honest about what is a keyword and what is a sentence.
 */
export const SQL_NOT_NULL = 'NOT NULL'
