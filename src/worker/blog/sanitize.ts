import sanitizeHtml from 'sanitize-html'

const SAFE_STYLE = /^[-a-zA-Z0-9#%.,()\s/]*$/

const ALLOWED_STYLES: sanitizeHtml.IOptions['allowedStyles'] = {
  '*': {
    color: [SAFE_STYLE],
    'background-color': [SAFE_STYLE],
    'text-align': [/^(left|right|center|justify|start|end)$/],
    width: [SAFE_STYLE],
    'max-width': [SAFE_STYLE],
    'min-width': [SAFE_STYLE],
    height: [SAFE_STYLE],
    border: [SAFE_STYLE],
    'border-radius': [SAFE_STYLE],
    display: [/^(block|inline|inline-block|flex|grid|none)$/],
    'grid-template-columns': [SAFE_STYLE],
    gap: [SAFE_STYLE],
    margin: [SAFE_STYLE],
    padding: [SAFE_STYLE],
    'vertical-align': [/^(top|middle|bottom|baseline)$/],
    'white-space': [/^(normal|pre|pre-wrap|nowrap)$/],
    'font-weight': [/^(normal|bold|[1-9]00)$/],
    'font-style': [/^(normal|italic)$/],
    'text-decoration': [SAFE_STYLE],
    'object-fit': [/^(contain|cover|fill|none|scale-down)$/],
    'aspect-ratio': [SAFE_STYLE],
    opacity: [/^(0|1|0?\.\d+)$/],
  },
}

const ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'span', 'div', 'section', 'figure', 'figcaption', 'details', 'summary', 'input',
  'del', 'mark', 'sup', 'sub', 'kbd', 'dl', 'dt', 'dd', 'abbr', 'cite', 'q', 's', 'time',
  'video', 'audio', 'source',
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'semantics',
  'annotation', 'mspace', 'mmultiscripts', 'mover', 'munder', 'mtable', 'mtr', 'mtd',
])

/**
 * The snapshot arrives from an authenticated browser, but the worker is still the trust boundary:
 * the owner API accepts a payload from any client that holds the session, so scripts, event handlers,
 * javascript: URLs and CSS that can fetch must not survive the write.
 */
export function sanitizeBlogHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['class', 'id', 'title', 'style', 'role', 'dir', 'lang', 'data-*', 'aria-*'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
      input: ['type', 'checked', 'disabled'],
      video: ['src', 'controls', 'poster', 'width', 'height', 'preload', 'muted', 'loop'],
      audio: ['src', 'controls', 'preload', 'loop'],
      source: ['src', 'type'],
      math: ['xmlns', 'display'],
      mi: ['mathvariant'],
      mo: ['stretchy', 'fence', 'separator'],
      mtext: ['mathvariant'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
    allowedStyles: ALLOWED_STYLES,
    transformTags: {
      a: (tagName, attribs) => {
        const next = { ...attribs }
        if (next.target === '_blank') next.rel = 'noopener noreferrer'
        return { tagName, attribs: next }
      },
    },
  })
}
