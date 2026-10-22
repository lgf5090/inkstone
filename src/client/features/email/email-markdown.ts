import DOMPurify from 'dompurify'
import { renderEmailMarkdown } from './markdown'
import { stripEmailHtmlToText } from '@shared/email/format'

const COLOR_ONLY_STYLE = /^(?:color|background(?:-color)?):\s*#[0-9a-fA-F]{3,8}$/i
const COLOR_STYLE_TAGS = new Set(['FONT', 'MARK', 'SPAN', 'U', 'SUP', 'SUB'])

const purify = DOMPurify(window)

purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'style' && COLOR_STYLE_TAGS.has(node.nodeName) && COLOR_ONLY_STYLE.test(data.attrValue)) {
    data.forceKeepAttr = true
  }
})

const EMAIL_PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'mark', 'span', 'div', 'font',
    'img', 'sup', 'sub', 'kbd', 'samp', 'var', 'small',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height', 'align',
    'style', 'color', 'colspan', 'rowspan',
  ],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option', 'link', 'base', 'meta', 'style'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onchange', 'oninput', 'onfocus', 'srcdoc', 'formaction', 'action'],
  ALLOW_DATA_ATTR: false,
}

export function sanitizeEmailHtml(html: string): string {
  return purify.sanitize(html, EMAIL_PURIFY_CONFIG)
}

export function emailMarkdownToHtml(markdown: string): string {
  return sanitizeEmailHtml(renderEmailMarkdown(markdown))
}

export function emailMarkdownToText(markdown: string): string {
  return stripEmailHtmlToText(renderEmailMarkdown(markdown))
}
