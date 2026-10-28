/** Turns a built-in or saved template into the page content a new page starts from. */
import type { InknotePageContent, InknoteTemplate, InknoteTextBox } from '@shared/inknote/types'
import { emptyPageContent } from '@shared/inknote/parse'
import { randomLocalId } from '../random-id'

const BASE_TEXT: Omit<InknoteTextBox, 'id' | 'text' | 'fontSize'> = {
  x: 0.08,
  y: 0.06,
  w: 0.84,
  h: 0.08,
  color: '#1e293b',
  align: 'left',
  bold: false,
  italic: false,
  underline: false,
  hl: null,
  lh: 1.3,
  list: null,
}

export function templateContent(template: InknoteTemplate, translate: (key: string) => string, size: { width: number, height: number }): InknotePageContent {
  const content = emptyPageContent()
  if (template.builtIn) {
    content.texts = [
      { ...BASE_TEXT, id: randomLocalId(), y: 0.06, h: 0.09, text: translate(template.title), fontSize: template.titleSize, bold: true },
      { ...BASE_TEXT, id: randomLocalId(), y: 0.16, h: 0.06, text: translate(template.sub), fontSize: template.subSize },
    ]
  } else {
    content.texts = template.texts.map((item) => ({ ...item, id: randomLocalId() }))
  }
  if (template.bgAssetId && template.bgUrl) {
    content.bg = { kind: 'image', assetId: template.bgAssetId, url: template.bgUrl, width: size.width, height: size.height, alpha: 1 }
  }
  return content
}

/** The name a template draws in a picker: built-ins carry an i18n key, saved ones a literal name. */
export function templateName(template: InknoteTemplate, translate: (key: string) => string): string {
  return template.builtIn ? translate(template.name) : template.name
}

export function templateTitle(template: InknoteTemplate, translate: (key: string) => string): string {
  return template.builtIn && template.title ? translate(template.title) : template.name
}
