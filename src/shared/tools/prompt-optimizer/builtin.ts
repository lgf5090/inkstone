/**
 * Lookup helpers over the ported builtin template table.
 *
 * Ids repeat across languages on purpose (the reference writes the Chinese and English editions under
 * one id), so every lookup takes a language and answers with one edition.
 */

import { BUILTIN_TEMPLATES } from './builtin-templates'
import type { PromptTemplate, TemplateType } from './types'

export function findBuiltinTemplate(id: string, language: 'zh' | 'en'): PromptTemplate | null {
  return (
    BUILTIN_TEMPLATES.find((template) => template.id === id && template.metadata.language === language) ??
    BUILTIN_TEMPLATES.find((template) => template.id === id) ??
    null
  )
}

export function builtinTemplatesOfType(type: TemplateType, language: 'zh' | 'en'): PromptTemplate[] {
  const ofType = BUILTIN_TEMPLATES.filter((template) => template.metadata.templateType === type)
  const localized = ofType.filter((template) => template.metadata.language === language)
  return localized.length ? localized : ofType
}

export function firstBuiltinTemplate(type: TemplateType, language: 'zh' | 'en'): PromptTemplate | null {
  return builtinTemplatesOfType(type, language)[0] ?? null
}

export function builtinTemplateSummaries(language: 'zh' | 'en', type?: TemplateType): PromptTemplate[] {
  const rows = type ? BUILTIN_TEMPLATES.filter((template) => template.metadata.templateType === type) : BUILTIN_TEMPLATES
  const localized = rows.filter((template) => template.metadata.language === language)
  return (localized.length ? localized : rows).map((template) => ({
    id: template.id,
    name: template.name,
    content: '',
    metadata: template.metadata,
    isBuiltin: true,
  }))
}
