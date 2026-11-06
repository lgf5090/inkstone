/**
 * Variable syntax shared by the editor, the request builders and the server.
 *
 * A variable is `{{name}}`; the same spelling inside a template is a Mustache tag, so recognizing one
 * here and substituting one there cannot drift apart.
 */

import { PREDEFINED_VARIABLES } from './types'

export const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const VARIABLE_TOKEN = /\{\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\}?/g

export function variableNames(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(VARIABLE_TOKEN)) {
    if (match[1]) names.add(match[1])
  }
  return [...names]
}

export function isPredefinedVariable(name: string): boolean {
  return (PREDEFINED_VARIABLES as readonly string[]).includes(name)
}

export function missingVariables(text: string, available: Record<string, string>): string[] {
  return variableNames(text).filter((name) => {
    if (isPredefinedVariable(name)) return false
    return !(name in available)
  })
}

export function applyVariables(text: string, values: Record<string, string>): string {
  return text.replace(VARIABLE_TOKEN, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : value
  })
}

export function validateVariableName(name: string): string | null {
  if (!VARIABLE_NAME_PATTERN.test(name)) return 'Use letters, digits and underscores, starting with a letter'
  if (isPredefinedVariable(name)) return 'This name is reserved by the template engine'
  return null
}

export function predefinedVariableValues(input: {
  originalPrompt: string
  lastOptimizedPrompt?: string
  iterateInput?: string
  currentPrompt?: string
  userQuestion?: string
  conversationContext?: string
  toolsContext?: string
}): Record<string, string> {
  const values: Record<string, string> = {}
  for (const name of PREDEFINED_VARIABLES) {
    const value = input[name as keyof typeof input]
    if (value !== undefined) values[name] = value
  }
  return values
}
