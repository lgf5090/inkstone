import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const CMD = {
  digit0: 130, digit1: 131, digit2: 132, digit3: 133, digit4: 134,
  digit5: 135, digit6: 136, digit7: 137, digit8: 138, digit9: 139,
  a: 140, b: 141, c: 142, d: 143, e: 144, f: 145,
  clear: 81, clearEntry: 82, back: 83, decimal: 84, sign: 80, equals: 121, percent: 118,
  add: 93, subtract: 94, multiply: 92, divide: 91, mod: 95, power: 97, root: 96,
  sqrt: 110, square: 111, cube: 112, cubeRoot: 116, reciprocal: 114, factorial: 113,
  sin: 102, cos: 103, tan: 104, ln: 108, log: 109, tenPower: 117, exp: 127, powE: 205,
  pi: 120, euler: 601, dms: 115, abs: 413, floor: 414, ceil: 415,
  openParen: 128, closeParen: 129, deg: 321, rad: 322, grad: 323, fe: 119,
  hex: 313, dec: 314, oct: 315, bin: 316, qword: 317, dword: 318, word: 319, byte: 320,
  and: 86, or: 87, xor: 88, not: 101, lsh: 89, rsh: 90, rol: 99, ror: 100,
  nand: 501, nor: 502, bitFlipStart: 700,
}

const digits = (text) => [...text].map((ch) => CMD.digit0 + Number(ch))
const cases = []
const add = (name, mode, commands) => cases.push({ name, mode, commands })

add('standard-add', 'standard', [...digits('1'), CMD.add, ...digits('2'), CMD.equals])
add('standard-decimal-multiply', 'standard', [...digits('12'), CMD.decimal, ...digits('5'), CMD.multiply, ...digits('4'), CMD.equals])
add('standard-divide', 'standard', [...digits('100'), CMD.divide, ...digits('8'), CMD.equals])
add('standard-third', 'standard', [...digits('1'), CMD.divide, ...digits('3'), CMD.equals])
add('standard-immediate-chain', 'standard', [...digits('5'), CMD.add, ...digits('3'), CMD.multiply, ...digits('2'), CMD.equals])
add('standard-repeated-equals', 'standard', [...digits('2'), CMD.add, ...digits('3'), CMD.equals, CMD.equals])
add('standard-percent-add', 'standard', [...digits('50'), CMD.add, ...digits('10'), CMD.percent, CMD.equals])
add('standard-percent-subtract', 'standard', [...digits('50'), CMD.subtract, ...digits('10'), CMD.percent, CMD.equals])
add('standard-percent-multiply', 'standard', [...digits('50'), CMD.multiply, ...digits('10'), CMD.percent, CMD.equals])
add('standard-percent-divide', 'standard', [...digits('50'), CMD.divide, ...digits('10'), CMD.percent, CMD.equals])
add('standard-sqrt', 'standard', [...digits('9'), CMD.sqrt, CMD.equals])
add('standard-square', 'standard', [...digits('9'), CMD.square, CMD.equals])
add('standard-reciprocal', 'standard', [...digits('4'), CMD.reciprocal, CMD.equals])
add('standard-divide-zero', 'standard', [...digits('1'), CMD.divide, ...digits('0'), CMD.equals])
add('standard-decimal-sum', 'standard', [CMD.digit0, CMD.decimal, CMD.digit1, CMD.add, CMD.digit0, CMD.decimal, CMD.digit2, CMD.equals])
add('standard-negative-entry', 'standard', [...digits('7'), CMD.sign, CMD.add, ...digits('2'), CMD.equals])
add('standard-backspace', 'standard', [...digits('123'), CMD.back, CMD.equals])
add('standard-clear-entry', 'standard', [...digits('12'), CMD.clearEntry, ...digits('3'), CMD.equals])
add('standard-clear', 'standard', [...digits('12'), CMD.add, ...digits('3'), CMD.clear, ...digits('4'), CMD.equals])
add('standard-multiple-operators', 'standard', [...digits('7'), CMD.add, CMD.add, ...digits('3'), CMD.equals])
add('standard-long-sum', 'standard', [...digits('1234567'), CMD.add, ...digits('7654321'), CMD.equals])
add('standard-max-digits', 'standard', [...digits('1234567890123456'), CMD.digit7])

add('scientific-precedence', 'scientific', [...digits('2'), CMD.add, ...digits('3'), CMD.multiply, ...digits('4'), CMD.equals])
add('scientific-parentheses', 'scientific', [CMD.openParen, ...digits('2'), CMD.add, ...digits('3'), CMD.closeParen, CMD.multiply, ...digits('4'), CMD.equals])
add('scientific-power', 'scientific', [...digits('2'), CMD.power, ...digits('10'), CMD.equals])
add('scientific-square-root', 'scientific', [...digits('9'), CMD.sqrt, CMD.equals])
add('scientific-cube-root', 'scientific', [...digits('27'), CMD.cubeRoot, CMD.equals])
add('scientific-factorial', 'scientific', [...digits('5'), CMD.factorial, CMD.equals])
add('scientific-sin-deg', 'scientific', [...digits('30'), CMD.sin, CMD.equals])
add('scientific-cos-deg', 'scientific', [...digits('60'), CMD.cos, CMD.equals])
add('scientific-tan-deg', 'scientific', [...digits('45'), CMD.tan, CMD.equals])
add('scientific-log100', 'scientific', [...digits('100'), CMD.log, CMD.equals])
add('scientific-ln-e', 'scientific', [CMD.euler, CMD.ln, CMD.equals])
add('scientific-ten-power', 'scientific', [...digits('3'), CMD.tenPower, CMD.equals])
add('scientific-e-power', 'scientific', [...digits('2'), CMD.powE, CMD.equals])
add('scientific-exp-entry', 'scientific', [CMD.digit1, CMD.exp, CMD.digit3, CMD.equals])
add('scientific-mod', 'scientific', [...digits('10'), CMD.mod, ...digits('3'), CMD.equals])
add('scientific-abs', 'scientific', [...digits('7'), CMD.sign, CMD.abs, CMD.equals])
add('scientific-floor', 'scientific', [...digits('2'), CMD.decimal, ...digits('7'), CMD.floor, CMD.equals])
add('scientific-ceil', 'scientific', [...digits('2'), CMD.decimal, ...digits('1'), CMD.ceil, CMD.equals])
add('scientific-dms', 'scientific', [CMD.digit1, CMD.decimal, CMD.digit5, CMD.dms, CMD.equals])

add('programmer-hex-add', 'programmer', [CMD.hex, CMD.a, CMD.add, CMD.digit1, CMD.equals])
add('programmer-dec-add', 'programmer', [CMD.dec, ...digits('10'), CMD.add, ...digits('10'), CMD.equals])
add('programmer-oct-add', 'programmer', [CMD.oct, CMD.digit7, CMD.add, CMD.digit1, CMD.equals])
add('programmer-bin-add', 'programmer', [CMD.bin, CMD.digit1, CMD.add, CMD.digit1, CMD.equals])
add('programmer-byte-overflow', 'programmer', [CMD.byte, CMD.dec, ...digits('255'), CMD.add, CMD.digit1, CMD.equals])
add('programmer-word-overflow', 'programmer', [CMD.word, CMD.dec, ...digits('65535'), CMD.add, CMD.digit1, CMD.equals])
add('programmer-bit-flip', 'programmer', [CMD.hex, CMD.bitFlipStart])
add('programmer-and', 'programmer', [CMD.hex, CMD.digit3, CMD.and, CMD.digit1, CMD.equals])
add('programmer-or', 'programmer', [CMD.hex, CMD.digit3, CMD.or, CMD.digit1, CMD.equals])
add('programmer-xor', 'programmer', [CMD.hex, CMD.digit3, CMD.xor, CMD.digit1, CMD.equals])
add('programmer-not', 'programmer', [CMD.byte, CMD.hex, CMD.digit0, CMD.not, CMD.equals])
add('programmer-lsh', 'programmer', [CMD.hex, CMD.digit1, CMD.lsh, CMD.digit4, CMD.equals])
add('programmer-rsh', 'programmer', [CMD.hex, CMD.digit8, CMD.rsh, CMD.digit1, CMD.equals])
add('programmer-rol', 'programmer', [CMD.byte, CMD.hex, CMD.digit1, CMD.rol, CMD.digit1, CMD.equals])
add('programmer-ror', 'programmer', [CMD.byte, CMD.hex, CMD.digit2, CMD.ror, CMD.digit1, CMD.equals])
add('programmer-negative', 'programmer', [CMD.dec, ...digits('5'), CMD.sign, CMD.equals])
add('programmer-hex-add-two', 'programmer', [CMD.hex, CMD.a, CMD.add, CMD.b, CMD.equals])
add('programmer-hex-ff', 'programmer', [CMD.hex, CMD.f, CMD.add, CMD.f, CMD.equals])
add('programmer-dec-negative-add', 'programmer', [CMD.dec, ...digits('5'), CMD.sign, CMD.add, ...digits('2'), CMD.equals])
add('programmer-oct-add-two', 'programmer', [CMD.oct, CMD.digit1, CMD.digit0, CMD.add, CMD.digit1, CMD.equals])
add('programmer-bin-add-two', 'programmer', [CMD.bin, CMD.digit1, CMD.digit0, CMD.digit1, CMD.add, CMD.digit1, CMD.equals])
add('programmer-hex-and-two', 'programmer', [CMD.hex, CMD.f, CMD.and, CMD.digit3, CMD.equals])
add('programmer-hex-or-two', 'programmer', [CMD.hex, CMD.c, CMD.or, CMD.digit3, CMD.equals])
add('programmer-hex-xor-two', 'programmer', [CMD.hex, CMD.f, CMD.xor, CMD.digit3, CMD.equals])
add('programmer-hex-not-byte', 'programmer', [CMD.byte, CMD.hex, CMD.digit3, CMD.not, CMD.equals])
add('programmer-hex-lsh-two', 'programmer', [CMD.hex, CMD.digit3, CMD.lsh, CMD.digit2, CMD.equals])
add('programmer-hex-rsh-two', 'programmer', [CMD.hex, CMD.digit8, CMD.rsh, CMD.digit2, CMD.equals])
add('programmer-hex-rol-two', 'programmer', [CMD.byte, CMD.hex, CMD.digit3, CMD.rol, CMD.digit2, CMD.equals])
add('programmer-hex-ror-two', 'programmer', [CMD.byte, CMD.hex, CMD.digit3, CMD.ror, CMD.digit2, CMD.equals])
add('programmer-bit-flip-2', 'programmer', [CMD.hex, CMD.bitFlipStart + 1, CMD.hex])
add('programmer-bit-flip-8', 'programmer', [CMD.hex, CMD.bitFlipStart + 8, CMD.hex])
add('programmer-word-overflow-signed', 'programmer', [CMD.word, CMD.dec, ...digits('32767'), CMD.add, CMD.digit1, CMD.equals])
add('programmer-dword-overflow', 'programmer', [CMD.dword, CMD.dec, ...digits('4294967295'), CMD.add, CMD.digit1, CMD.equals])
add('programmer-qword-max', 'programmer', [CMD.qword, CMD.dec, ...digits('9223372036854775807'), CMD.add, CMD.digit1, CMD.equals])

let seed = 0x5eed1234
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x100000000
}
const pick = (pool) => pool[Math.floor(random() * pool.length)]
const integer = (max) => Math.floor(random() * max)
const digit = () => CMD.digit0 + integer(10)
const numberText = (allowSign = true) => {
  const length = 1 + integer(4)
  const commands = Array.from({ length }, () => digit())
  if (random() < 0.3) {
    commands.push(CMD.decimal)
    const fraction = 1 + integer(2)
    for (let index = 0; index < fraction; index++) commands.push(digit())
  }
  if (allowSign && random() < 0.12) commands.push(CMD.sign)
  return commands
}
const smallPowerOperand = () => [CMD.digit1 + integer(9), ...(random() < 0.4 ? [CMD.digit0 + integer(10)] : [])]
const standardOperators = [CMD.add, CMD.subtract, CMD.multiply, CMD.divide]
for (let index = 0; index < 100; index++) {
  const commands = [...numberText()]
  const terms = 1 + integer(5)
  for (let step = 0; step < terms; step++) {
    commands.push(pick(standardOperators), ...numberText())
  }
  if (random() < 0.3) commands.push(CMD.equals, CMD.equals)
  else commands.push(CMD.equals)
  add(`random-standard-${index}`, 'standard', commands)
}
const scientificFunctions = [CMD.sin, CMD.cos, CMD.tan, CMD.sqrt, CMD.square, CMD.abs, CMD.floor, CMD.ceil]
const scientificOperators = [CMD.add, CMD.subtract, CMD.multiply, CMD.divide, CMD.power]
for (let index = 0; index < 100; index++) {
  let commands = [...numberText(false)]
  if (random() < 0.3) commands.push(pick(scientificFunctions))
  if (random() < 0.25) commands = [CMD.openParen, ...commands, CMD.closeParen]
  const terms = 1 + integer(3)
  for (let step = 0; step < terms; step++) {
    const operator = pick(scientificOperators)
    commands.push(operator, ...(operator === CMD.power ? smallPowerOperand() : numberText(false)))
    if (random() < 0.2) commands.push(pick(scientificFunctions))
  }
  commands.push(CMD.equals)
  add(`random-scientific-${index}`, 'scientific', commands)
}
const casesPath = '/tmp/calculator-golden-cases.tsv'
fs.writeFileSync(casesPath, cases.map((item) => `${item.name}\t${item.mode}\t${item.commands.join(',')}`).join('\n') + '\n')
const output = execFileSync(path.resolve('tools/calculator-oracle/build/calculator-oracle'), [casesPath], { encoding: 'utf8' })
const rows = output.trim().split('\n')
const fixtures = []
for (const row of rows) {
  const fields = row.split('\t')
  const [name, primary, error, expression, tokenDump, maxDigits, binaryOperators, historyCount] = fields
  const { mode, commands } = cases.find((item) => item.name === name)
  const history = []
  let cursor = 8
  for (let index = 0; index < Number(historyCount); index++) {
    history.push({ expression: fields[cursor], result: fields[cursor + 1] })
    cursor += 2
  }
  const isError = error === '1'
  if (name.startsWith('random-') && isError) continue
  fixtures.push({
    name,
    mode,
    commands,
    expect: {
      primary,
      isError,
      expression: tokenDump === '' ? [] : tokenDump.split('|').map((token) => token.slice(1, -1)),
      expressionText: expression,
      maxDigits: Number(maxDigits),
      binaryOperators: Number(binaryOperators),
      history,
    },
  })
}
fs.writeFileSync('tests/fixtures/calculator/golden.json', JSON.stringify(fixtures, null, 2) + '\n')
console.log(`generated ${fixtures.length} fixtures (${rows.length} oracle rows)`)
