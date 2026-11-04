import type { MessageKey } from '@shared/locales/en-US'

export interface TextCalcTemplate {
  id: string
  labelKey: MessageKey
  body: string
}

export const TEXTCALC_TEMPLATES: readonly TextCalcTemplate[] = [
  {
    id: 'basics',
    labelKey: 'tools.calculator.textcalc.example.basics',
    body: [
      '# Arithmetic follows the usual precedence',
      '1 + 2 * 3',
      '(4 + 6) / 2',
      '2^10',
      '17 % 5',
    ].join('\n'),
  },
  {
    id: 'variables',
    labelKey: 'tools.calculator.textcalc.example.variables',
    body: [
      'a = 2',
      'b = a * 3',
      'c = (a + b) / 2',
      'c',
    ].join('\n'),
  },
  {
    id: 'functions',
    labelKey: 'tools.calculator.textcalc.example.functions',
    body: [
      'f(x) = x^2 + 1',
      'g(x) = sin(x)',
      'f(3)',
      'g(pi / 2)',
    ].join('\n'),
  },
  {
    id: 'units',
    labelKey: 'tools.calculator.textcalc.example.units',
    body: [
      '5 cm to inch',
      '2 kg + 500 g',
      '1 km / 2',
      '3 ft to m',
    ].join('\n'),
  },
  {
    id: 'bases',
    labelKey: 'tools.calculator.textcalc.example.bases',
    body: [
      '0b1010',
      '0o17',
      '0xFF',
      '100 + 10%',
      '100 * 20%',
    ].join('\n'),
  },
  {
    id: 'science',
    labelKey: 'tools.calculator.textcalc.example.science',
    body: [
      'sin(30 deg)',
      'cos(0)',
      'ln(e)',
      'log(1000)',
      'sqrt(2)',
      'abs(-7)',
      'round(2.6)',
    ].join('\n'),
  },
]
