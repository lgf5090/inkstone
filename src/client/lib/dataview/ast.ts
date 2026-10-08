/**
 * The two abstract syntax trees the query language is made of: expressions (`Field`) and the set of
 * notes an expression is evaluated over (`Source`).
 *
 * They live together because a `FROM` clause is a source expression and a `WHERE` clause is a field,
 * and both are read by the same evaluator. Names follow Dataview's own AST so a ported query reads the
 * same way in both projects.
 */

import type { Literal } from './value'

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '>' | '>=' | '<' | '<=' | '=' | '!=' | '&' | '|'

export type Field =
    | { type: 'literal'; value: Literal }
    | { type: 'variable'; name: string }
    | { type: 'negated'; child: Field }
    | { type: 'binaryop'; op: BinaryOp; left: Field; right: Field }
    | { type: 'list'; values: Field[] }
    | { type: 'object'; values: Record<string, Field> }
    | { type: 'index'; object: Field; index: Field }
    | { type: 'func'; callee: Field; args: Field[] }
    | { type: 'lambda'; params: string[]; body: Field }

export namespace Fields {
    export function literal(value: Literal): Field { return { type: 'literal', value } }
    export function variable(name: string): Field { return { type: 'variable', name } }
    export function negated(child: Field): Field { return { type: 'negated', child } }
    export function binaryOp(op: BinaryOp, left: Field, right: Field): Field { return { type: 'binaryop', op, left, right } }
    export function list(values: Field[]): Field { return { type: 'list', values } }
    export function object(values: Record<string, Field>): Field { return { type: 'object', values } }
    export function index(object: Field, index: Field): Field { return { type: 'index', object, index } }
    export function func(callee: Field, args: Field[]): Field { return { type: 'func', callee, args } }
    export function lambda(params: string[], body: Field): Field { return { type: 'lambda', params, body } }
}

/** The NULL literal is shared so an unset property and an explicit `null` compare equal. */
export const NULL_FIELD: Field = { type: 'literal', value: null }

export type Source =
    | { type: 'empty' }
    | { type: 'tag'; tag: string }
    | { type: 'csv'; path: string }
    | { type: 'folder'; folder: string }
    | { type: 'link'; file: string; direction: 'incoming' | 'outgoing' }
    | { type: 'negate'; child: Source }
    | { type: 'binaryop'; op: '&' | '|'; left: Source; right: Source }

export namespace Sources {
    export function tag(tag: string): Source { return { type: 'tag', tag } }
    export function csv(path: string): Source { return { type: 'csv', path } }
    export function folder(prefix: string): Source { return { type: 'folder', folder: prefix } }
    export function link(file: string, incoming: boolean): Source { return { type: 'link', file, direction: incoming ? 'incoming' : 'outgoing' } }
    export function negate(child: Source): Source { return { type: 'negate', child } }
    export function and(left: Source, right: Source): Source { return { type: 'binaryop', op: '&', left, right } }
    export function or(left: Source, right: Source): Source { return { type: 'binaryop', op: '|', left, right } }
    export function empty(): Source { return { type: 'empty' } }

    /** Every note in the vault — what a query with no `FROM` clause runs over. */
    export function everything(): Source { return folder('') }

    /**
     * Walk the tree and hand each leaf to `visit`, which is how the index decides which notes it must
     * read the bodies of before a query can answer.
     */
    export function leaves(source: Source, visit: (leaf: Source) => void): void {
        switch (source.type) {
            case 'binaryop':
                leaves(source.left, visit)
                leaves(source.right, visit)
                return
            case 'negate':
                leaves(source.child, visit)
                return
            default:
                visit(source)
        }
    }
}

/** Clauses in the order Dataview names them; `parse.ts` produces these and `engine.ts` runs them. */
export type QueryType = 'table' | 'list' | 'task' | 'calendar'

export interface NamedField {
    name: string
    field: Field
}

export interface QuerySortBy {
    field: Field
    direction: 'ascending' | 'descending'
}

export interface TableHeader {
    type: 'table'
    fields: NamedField[]
    showId: boolean
}

export interface ListHeader {
    type: 'list'
    format?: Field
    showId: boolean
}

export interface TaskHeader {
    type: 'task'
}

export interface CalendarHeader {
    type: 'calendar'
    field: NamedField
}

export type QueryHeader = TableHeader | ListHeader | TaskHeader | CalendarHeader

export type QueryOperation =
    | { type: 'where'; clause: Field }
    | { type: 'sort'; fields: QuerySortBy[] }
    | { type: 'limit'; amount: Field }
    | { type: 'flatten'; field: NamedField }
    | { type: 'group'; field: NamedField }

export interface Query {
    header: QueryHeader
    source: Source
    operations: QueryOperation[]
}
