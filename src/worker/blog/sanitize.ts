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
    position: [/^(relative|absolute|static)$/],
    top: [SAFE_STYLE],
    bottom: [SAFE_STYLE],
    left: [SAFE_STYLE],
    right: [SAFE_STYLE],
    'font-size': [SAFE_STYLE],
    'font-family': [SAFE_STYLE],
    'line-height': [SAFE_STYLE],
    'letter-spacing': [SAFE_STYLE],
    'margin-left': [SAFE_STYLE],
    'margin-right': [SAFE_STYLE],
    'margin-top': [SAFE_STYLE],
    'margin-bottom': [SAFE_STYLE],
    'padding-left': [SAFE_STYLE],
    'padding-right': [SAFE_STYLE],
    'padding-top': [SAFE_STYLE],
    'padding-bottom': [SAFE_STYLE],
    'border-bottom': [SAFE_STYLE],
    'min-height': [SAFE_STYLE],
    'max-height': [SAFE_STYLE],
    'overflow-x': [/^(auto|hidden|scroll|visible)$/],
    'overflow-y': [/^(auto|hidden|scroll|visible)$/],
    overflow: [/^(auto|hidden|scroll|visible)$/],
    transform: [SAFE_STYLE],
    clip: [SAFE_STYLE],
    'text-indent': [SAFE_STYLE],
  },
}

const ALLOWED_TAGS = sanitizeHtml.defaults.allowedTags.concat([
  'img', 'span', 'div', 'section', 'figure', 'figcaption', 'details', 'summary', 'input',
  'del', 'mark', 'sup', 'sub', 'kbd', 'dl', 'dt', 'dd', 'abbr', 'cite', 'q', 's', 'time',
  'video', 'audio', 'source',
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'semantics',
  'annotation', 'mspace', 'mmultiscripts', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd',
  'mstyle', 'mpadded', 'mphantom', 'mroot', 'menclose', 'mglyph', 'mlabeledtr',
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
      math: ['xmlns', 'display', 'displaystyle', 'scriptlevel'],
      mspace: ['width', 'height', 'depth'],
      mfrac: ['linethickness', 'bevelled'],
      mover: ['accent'],
      munder: ['accentunder'],
      munderover: ['accent', 'accentunder'],
      mtable: ['columnalign', 'rowspacing', 'columnspacing', 'displaystyle'],
      mtd: ['columnalign', 'rowspan', 'columnspan'],
      mstyle: ['displaystyle', 'scriptlevel', 'mathcolor', 'mathbackground'],
      mpadded: ['width', 'height', 'depth', 'lspace', 'voffset'],
      annotation: ['encoding'],
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
      // A task box on a published page has no note to write a tick back to. Leaving it enabled would
      // make the still show a state the article does not have the moment a reader clicks it.
      input: (tagName, attribs) => ({
        tagName,
        attribs: attribs.type === 'checkbox' ? { ...attribs, disabled: 'disabled' } : attribs,
      }),
    },
  })
}
