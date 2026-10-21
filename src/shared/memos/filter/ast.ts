export interface MemoFilterError {
  message: string
  position: number
}

export type MemoFilterBinaryOperator =
  | '&&'
  | '||'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | '+'
  | '-'

export interface MemoFilterLiteralNode {
  kind: 'literal'
  value: string | number | boolean | null
  position: number
}

export interface MemoFilterListNode {
  kind: 'list'
  items: MemoFilterNode[]
  position: number
}

export interface MemoFilterFieldNode {
  kind: 'field'
  name: string
  position: number
}

export interface MemoFilterCallNode {
  kind: 'call'
  target: MemoFilterNode | null
  method: string
  args: MemoFilterNode[]
  position: number
}

export interface MemoFilterUnaryNode {
  kind: 'unary'
  operator: '!' | '-'
  operand: MemoFilterNode
  position: number
}

export interface MemoFilterBinaryNode {
  kind: 'binary'
  operator: MemoFilterBinaryOperator
  left: MemoFilterNode
  right: MemoFilterNode
  position: number
}

export type MemoFilterNode =
  | MemoFilterLiteralNode
  | MemoFilterListNode
  | MemoFilterFieldNode
  | MemoFilterCallNode
  | MemoFilterUnaryNode
  | MemoFilterBinaryNode
