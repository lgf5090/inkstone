import type { GraphNode } from './parser'
import type { TrigMode } from '../types'

export interface EvalContext {
  x?: number
  y?: number
  vars?: Record<string, number>
  trigMode: TrigMode
}

function toRadians(value: number, mode: TrigMode): number {
  if (mode === 'deg') return (value * Math.PI) / 180
  if (mode === 'grad') return (value * Math.PI) / 200
  return value
}

function fromRadians(value: number, mode: TrigMode): number {
  if (mode === 'deg') return (value * 180) / Math.PI
  if (mode === 'grad') return (value * 200) / Math.PI
  return value
}

function factorial(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 170) return NaN
  let result = 1
  for (let index = 2; index <= value; index++) result *= index
  return result
}

export function evaluateNode(node: GraphNode, context: EvalContext): number {
  switch (node.kind) {
    case 'number':
      return node.value
    case 'variable': {
      if (node.name === 'x') return context.x ?? NaN
      if (node.name === 'y') return context.y ?? NaN
      return context.vars?.[node.name] ?? NaN
    }
    case 'unary': {
      const value = evaluateNode(node.value, context)
      return node.op === '-' ? -value : value
    }
    case 'binary': {
      const left = evaluateNode(node.left, context)
      if (node.op === '^') {
        const right = evaluateNode(node.right, context)
        return left ** right
      }
      const right = evaluateNode(node.right, context)
      switch (node.op) {
        case '+':
          return left + right
        case '-':
          return left - right
        case '*':
          return left * right
        case '/':
          return left / right
        case '%':
          return left % right
        default:
          return NaN
      }
    }
    case 'call':
      return evaluateCall(node.name, node.args.map((arg) => evaluateNode(arg, context)), context)
    case 'relation': {
      const left = evaluateNode(node.left, context)
      const right = evaluateNode(node.right, context)
      switch (node.op) {
        case '=':
          return Math.abs(left - right) < 1e-12 ? 1 : 0
        case '<':
          return left < right ? 1 : 0
        case '<=':
          return left <= right ? 1 : 0
        case '>':
          return left > right ? 1 : 0
        case '>=':
          return left >= right ? 1 : 0
        default:
          return NaN
      }
    }
  }
}

function evaluateCall(name: string, args: number[], context: EvalContext): number {
  const first = args[0] ?? NaN
  switch (name) {
    case 'sin':
      return Math.sin(toRadians(first, context.trigMode))
    case 'cos':
      return Math.cos(toRadians(first, context.trigMode))
    case 'tan':
      return Math.tan(toRadians(first, context.trigMode))
    case 'sec':
      return 1 / Math.cos(toRadians(first, context.trigMode))
    case 'csc':
      return 1 / Math.sin(toRadians(first, context.trigMode))
    case 'cot':
      return 1 / Math.tan(toRadians(first, context.trigMode))
    case 'asin':
      return fromRadians(Math.asin(first), context.trigMode)
    case 'acos':
      return fromRadians(Math.acos(first), context.trigMode)
    case 'atan':
      return fromRadians(Math.atan(first), context.trigMode)
    case 'asec':
      return fromRadians(Math.acos(1 / first), context.trigMode)
    case 'acsc':
      return fromRadians(Math.asin(1 / first), context.trigMode)
    case 'acot':
      return fromRadians(Math.atan(1 / first), context.trigMode)
    case 'sinh':
      return Math.sinh(first)
    case 'cosh':
      return Math.cosh(first)
    case 'tanh':
      return Math.tanh(first)
    case 'sech':
      return 1 / Math.cosh(first)
    case 'csch':
      return 1 / Math.sinh(first)
    case 'coth':
      return 1 / Math.tanh(first)
    case 'asinh':
      return Math.asinh(first)
    case 'acosh':
      return Math.acosh(first)
    case 'atanh':
      return Math.atanh(first)
    case 'asech':
      return Math.acosh(1 / first)
    case 'acsch':
      return Math.asinh(1 / first)
    case 'acoth':
      return Math.atanh(1 / first)
    case 'sqrt':
      return Math.sqrt(first)
    case 'cbrt':
      return Math.cbrt(first)
    case 'abs':
      return Math.abs(first)
    case 'floor':
      return Math.floor(first)
    case 'ceil':
      return Math.ceil(first)
    case 'ln':
      return Math.log(first)
    case 'log':
    case 'log10':
      if (args.length > 1) return Math.log(first) / Math.log(args[1])
      return Math.log10(first)
    case 'exp':
      return Math.exp(first)
    case 'fact':
      return factorial(first)
    case 'mod':
      return first % (args[1] ?? NaN)
    case 'root':
      return args[1] ? Math.sign(first) * Math.abs(first) ** (1 / args[1]) : Math.sqrt(first)
    case 'pow':
      return first ** (args[1] ?? NaN)
    case 'min':
      return Math.min(...args)
    case 'max':
      return Math.max(...args)
    default:
      return NaN
  }
}

export function relationVisible(node: GraphNode, context: EvalContext): boolean {
  if (node.kind !== 'relation') return true
  const left = evaluateNode(node.left, context)
  const right = evaluateNode(node.right, context)
  switch (node.op) {
    case '=':
      return Math.abs(left - right) < 1e-9
    case '<':
      return left < right
    case '<=':
      return left <= right
    case '>':
      return left > right
    case '>=':
      return left >= right
    default:
      return false
  }
}
