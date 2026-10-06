import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '@/lib/i18n'
import { renderMarkdown } from './renderer'
import { parseTimelineItem, splitTimelineInfo } from './timeline-options'

beforeAll(async () => {
  localStorage.clear()
  await initI18n()
})

function html(source: string): string {
  return renderMarkdown(source).html
}

function root(source: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(source).html
  return host
}

function one(source: string, selector: string): HTMLElement {
  const found = root(source).querySelector<HTMLElement>(selector)
  if (!found)
    throw new Error(`${selector} missing in ${html(source)}`)
  return found
}

function items(source: string): HTMLElement[] {
  return [...root(source).querySelectorAll<HTMLElement>('.markdown-timeline-item')]
}

describe('timeline nodes', () => {
  it('draws one list item per :: line', () => {
    const host = root('::: timeline\n:: 2024-01-01 first\n:: 2024-02-01 second\n:::')
    expect(host.querySelectorAll('ol.markdown-timeline')).toHaveLength(1)
    expect(host.querySelectorAll('ol.markdown-timeline > li.markdown-timeline-item')).toHaveLength(2)
    expect(host.innerHTML).not.toMatch(/^::/m)
  })

  it('keeps the space-free spelling the reference demo writes', () => {
    expect(one(':::timeline Cherry Markdown 发展历程\n:: [milestone] 2021-07 项目开源\n  正式开源\n:::', '.markdown-timeline-caption').textContent)
      .toBe('Cherry Markdown 发展历程')
    expect(items(':::timeline X\n:: [milestone] 2021-07 项目开源\n:::')).toHaveLength(1)
  })

  it('reads the status, the date and the title off the first line', () => {
    const source = '::: timeline\n:: [milestone] 2024-01-15 shipped\ndetails here\n:::'
    const item = one(source, '.markdown-timeline-item')
    expect(item.dataset.status).toBe('milestone')
    expect(one(source, '.markdown-timeline-time').textContent).toBe('2024-01-15')
    expect(one(source, '.markdown-timeline-time').dataset.datetime).toBe('2024-01-15')
    expect(one(source, '.markdown-timeline-title').textContent).toBe('shipped')
    expect(item.querySelector('.markdown-timeline-body p')?.textContent).toBe('details here')
  })

  it.each([
    ['[done]', 'done'],
    ['[x]', 'done'],
    ['[✓]', 'done'],
    ['[doing]', 'doing'],
    ['[~]', 'doing'],
    ['[…]', 'doing'],
    ['[wip]', 'doing'],
    ['[todo]', 'todo'],
    ['[ ]', 'todo'],
    ['[]', 'todo'],
    ['[milestone]', 'milestone'],
    ['[*]', 'milestone'],
    ['[★]', 'milestone'],
    ['[error]', 'error'],
    ['[err]', 'error'],
    ['[!]', 'error'],
    ['[×]', 'error'],
    ['[✗]', 'error'],
    ['[DONE]', 'done'],
  ])('maps %s onto the %s status', (marker, status) => {
    expect(items(`::: timeline\n:: ${marker} a node\n:::`)[0]?.dataset.status).toBe(status)
  })

  it('falls back to todo for a word it does not know', () => {
    expect(items('::: timeline\n:: [wat] later\n:::')[0]?.dataset.status).toBe('todo')
  })

  it('renders a bracket word that names an Object member', () => {
    const source = '::: timeline\n:: [constructor] a\n:::'
    expect(items(source)[0]?.dataset.status).toBe('todo')
    expect(one(source, '.markdown-timeline-title').textContent).toBe('[constructor] a')
  })

  it('labels every status in the reader language', () => {
    const labels = (['todo', 'doing', 'done', 'milestone', 'error'] as const)
        .map((status) => one(`::: timeline\n:: [${status}] a\n:::`, '.markdown-timeline-status').textContent)
    expect(labels).toEqual(['Todo', 'Doing', 'Done', 'Milestone', 'Error'])
  })

  it('leaves a first word that is not a date in the title', () => {
    const source = '::: timeline\n:: chapter one summary\n:::'
    expect(root(source).querySelector('.markdown-timeline-time')).toBeNull()
    expect(one(source, '.markdown-timeline-title').textContent).toBe('chapter one summary')
  })

  it('treats a version prefix as the date', () => {
    const source = '::: timeline\n:: v1.0 launch\n:::'
    expect(one(source, '.markdown-timeline-time').textContent).toBe('v1.0')
    expect(one(source, '.markdown-timeline-time').hasAttribute('data-datetime')).toBe(false)
    expect(one(source, '.markdown-timeline-title').textContent).toBe('launch')
  })

  it('only marks a real calendar date machine-readable', () => {
    expect(one('::: timeline\n:: 2024-05 a\n:::', '.markdown-timeline-time').dataset.datetime).toBe('2024-05')
    expect(one('::: timeline\n:: 2024 a\n:::', '.markdown-timeline-time').hasAttribute('data-datetime')).toBe(false)
  })

  it('carries inline syntax in the node title and the caption', () => {
    const title = one('::: timeline\n:: 2024-01-01 see [the docs](https://example.com)\n:::', '.markdown-timeline-title')
    expect(title.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
    expect(one('::: timeline see [the docs](https://example.com)\n:: [done] A\n:::', '.markdown-timeline-caption a')?.textContent).toBe('the docs')
  })

  it('renders a wikilink and math in a title against the document environment', () => {
    const result = renderMarkdown('::: timeline\n:: [done] **Bold** [[Note]] $x^2$\n:::')
    expect(result.html).toMatch(/<a class="wikilink"/)
    expect(result.html).toContain('data-math')
    expect(result.hasMath).toBe(true)
    const embedded = renderMarkdown('::: timeline\n:: [done] ![[Note]]\n:::')
    expect(embedded.html).toContain('data-embed-target')
    expect(embedded.hasEmbeds).toBe(true)
  })

  it('renders the caption against the document environment too', () => {
    const math = renderMarkdown('::: timeline Plan $x^2$\n:: [done] A\n:::')
    expect(math.html).toContain('data-math')
    expect(math.hasMath).toBe(true)
    const embedded = renderMarkdown('::: timeline see ![[Note]]\n:: [done] A\n:::')
    expect(embedded.html).toContain('data-embed-target')
    expect(embedded.hasEmbeds).toBe(true)
  })

  it('raises the node\'s own paragraph breaks without touching a list or a quote', () => {
    const paragraph = one('::: timeline\n:: [done] 2024-01-01 Ship\nfocus mode\nimage preview\n:::', '.markdown-timeline-body p')
    expect(paragraph.querySelectorAll('br')).toHaveLength(1)
    const listed = root('::: timeline\n:: [done] Ship\n- alpha\n- beta\n:::')
    expect(listed.querySelectorAll('.markdown-timeline-body ul li')).toHaveLength(2)
    expect(listed.querySelector('.markdown-timeline-body ul br')).toBeNull()
    const quoted = one('::: timeline\n:: [done] Ship\n> quoted one\n> quoted two\n:::', 'blockquote p')
    expect(quoted.querySelector('br')).toBeNull()
    expect(quoted.textContent).toBe('quoted one\nquoted two')
  })

  it('keeps an explicit backslash break as one break, not two', () => {
    const paragraph = one('::: timeline\n:: [done] Ship\nfirst\\\nsecond\n:::', '.markdown-timeline-body p')
    expect(paragraph.querySelectorAll('br')).toHaveLength(1)
    expect(paragraph.textContent).toBe('first\nsecond')
  })

  it('keeps a trailing double space as one break', () => {
    const paragraph = one('::: timeline\n:: [done] Ship\nfirst  \nsecond\n:::', '.markdown-timeline-body p')
    expect(paragraph.querySelectorAll('br')).toHaveLength(1)
  })
})

describe('timeline containers', () => {
  it('titles the block from whatever follows the keyword', () => {
    expect(one('::: timeline The long history\n:: [done] first\n:::', '.markdown-timeline-caption').textContent).toBe('The long history')
    expect(root('::: timeline\n:: [done] A\n:::').querySelector('.markdown-timeline-caption')).toBeNull()
  })

  it('keeps the text written before the first node instead of dropping it', () => {
    const host = root('::: timeline Intro\nread me first\n:: [done] A\n:::')
    expect(host.textContent).toContain('read me first')
    expect(host.querySelector('.markdown-timeline-intro p')?.textContent).toBe('read me first')
    expect(host.querySelectorAll('.markdown-timeline-item')).toHaveLength(1)
  })

  it('renders a container with no node as ordinary prose', () => {
    const host = root('::: timeline\njust prose\n:::')
    expect(host.textContent).toContain('just prose')
    expect(host.querySelector('.markdown-timeline')).toBeNull()
    expect(host.querySelector('.markdown-timeline-intro')).toBeNull()
  })

  it('does not read a three-colon line as a node', () => {
    const source = '::: timeline\n:: [done] A\n:::!!!\n:::'
    const host = root(source)
    expect(items(source)).toHaveLength(1)
    expect(host.textContent).toContain(':::!!!')
    expect(host.querySelectorAll('.markdown-timeline-title')).toHaveLength(1)
  })

  it('ignores a :: line inside a code fence', () => {
    const host = root('::: timeline\n:: [done] A\n```js\n:: not a node\n```\n:: [todo] B\n:::')
    expect(items('::: timeline\n:: [done] A\n```js\n:: not a node\n```\n:: [todo] B\n:::')).toHaveLength(2)
    expect(host.textContent).toContain(':: not a node')
  })

  it('ignores a :: line inside a nested container', () => {
    const source = [
      '::: timeline',
      ':: [done] A',
      '::: details Inner',
      ':: not a node',
      ':::',
      ':: [todo] B',
      ':::',
    ].join('\n')
    expect(items(source)).toHaveLength(2)
    expect(root(source).textContent).toContain(':: not a node')
  })

  it('nests inside a tab panel and a details block', () => {
    const tabs = root(':::: tabs\n::: tab-item A\n::: timeline\n:: [done] shipped\n:::\n:::\n::::')
    expect(tabs.querySelectorAll('.markdown-timeline-item')).toHaveLength(1)
    expect(tabs.innerHTML).not.toMatch(/:{3,}/)
    const details = root('::: details OUTER\n::: timeline\n:: [done] shipped\n:::\n:::')
    expect(details.querySelectorAll('.markdown-timeline-item')).toHaveLength(1)
    expect(details.innerHTML).not.toMatch(/<p>[^<]*:{3,}/)
  })

  it('lets an unclosed container claim the rest of its context', () => {
    const host = root('::: timeline\n:: [done] A\nbody keeps going')
    expect(host.querySelectorAll('.markdown-timeline-item')).toHaveLength(1)
    expect(host.textContent).toContain('body keeps going')
    expect(host.innerHTML).not.toMatch(/:{3,}/)
  })

  it('points the editor at the header line it was written on', () => {
    expect(one('::: timeline\n:: [done] A\n:::', '.markdown-timeline-block').dataset.line).toBe('0')
    expect(one('::: timeline\n:: [done] A\n:::', '.markdown-timeline-item').dataset.line).toBe('1')
    expect(one('para\n\n::: timeline\n:: [done] A\n:::', '.markdown-timeline-block').dataset.line).toBe('2')
  })
})

describe('timeline display options', () => {
  it('marks a dense block', () => {
    expect(one('::: timeline {dense}\n:: [done] A\n:::', '.markdown-timeline-block').dataset.timelineDense).toBe('true')
  })

  it('hides the status labels when asked', () => {
    expect(one('::: timeline History {status=off}\n:: [done] A\n:::', '.markdown-timeline-block').dataset.timelineStatus).toBe('off')
    expect(one('::: timeline History\n:: [done] A\n:::', '.markdown-timeline-block').hasAttribute('data-timeline-status')).toBe(false)
  })

  it('numbers the nodes when asked', () => {
    expect(one('::: timeline {marker=number}\n:: [done] A\n:::', '.markdown-timeline-block').dataset.timelineMarker).toBe('number')
    expect(one('::: timeline {marker=dot}\n:: [done] A\n:::', '.markdown-timeline-block').hasAttribute('data-timeline-marker')).toBe(false)
  })

  it('keeps the caption clear of the option group', () => {
    expect(one('::: timeline Cherry history {dense}\n:: [done] A\n:::', '.markdown-timeline-caption').textContent).toBe('Cherry history')
  })

  it('leaves a brace group it does not own inside the title', () => {
    expect(one('::: timeline see here{target=_blank}\n:: [done] A\n:::', '.markdown-timeline-caption').textContent).toBe('see here{target=_blank}')
    expect(one('::: timeline see here{target=_blank}\n:: [done] A\n:::', '.markdown-timeline-block').hasAttribute('data-timeline-dense')).toBe(false)
  })

  it('combines several options written in one group', () => {
    const block = one('::: timeline {dense marker=number status=off}\n:: [done] A\n:::', '.markdown-timeline-block')
    expect(block.dataset.timelineDense).toBe('true')
    expect(block.dataset.timelineMarker).toBe('number')
    expect(block.dataset.timelineStatus).toBe('off')
  })
})

describe('timeline markup survives sanitizing', () => {
  it('escapes authored text rather than trusting it', () => {
    const source = '::: timeline\n:: [done] a < b and [x] y\n:::'
    expect(one(source, '.markdown-timeline-title').textContent).toBe('a < b and [x] y')
  })

  it('leaves the sanitizer as the backstop for raw html in a title', () => {
    const item = items('::: timeline\n:: [done] <img src=x onerror=alert(1)>\n:::')[0]!
    expect(item.querySelector('img')?.hasAttribute('onerror')).toBe(false)
    expect(item.querySelector('img')?.getAttribute('src')).toBe('x')
    expect(renderMarkdown('::: timeline <script>alert(1)</script>\n:: [done] A\n:::').html).not.toContain('<script')
  })

  it('cannot be steered out of its status vocabulary', () => {
    const item = one('::: timeline\n:: [done" data-x="y] A\n:::', '.markdown-timeline-item')
    expect(item.dataset.status).toBe('todo')
    expect(item.hasAttribute('data-x')).toBe(false)
  })

  it('carries a date that cannot break out of its attribute', () => {
    const item = one('::: timeline\n:: [done] 2024" onload="alert(1) title\n:::', '.markdown-timeline-item')
    expect(item.querySelector('.markdown-timeline-time')?.getAttribute('onload')).toBeNull()
    expect(item.querySelector('.markdown-timeline-time')?.textContent).toBe('2024"')
  })
})

describe('timeline parsing', () => {
  it.each([
    ['[done] 2024-01-15 shipped', { status: 'done', time: '2024-01-15', title: 'shipped' }],
    ['2024-01-15 shipped', { status: 'todo', time: '2024-01-15', title: 'shipped' }],
    ['shipped', { status: 'todo', time: '', title: 'shipped' }],
    ['', { status: 'todo', time: '', title: '' }],
    ['   ', { status: 'todo', time: '', title: '' }],
    ['[nonsense] other', { status: 'todo', time: '', title: '[nonsense] other' }],
    ['[2024] annual report', { status: 'todo', time: '', title: '[2024] annual report' }],
    ['[done]', { status: 'done', time: '', title: '' }],
    ['[ ] 2024-05 plan', { status: 'todo', time: '2024-05', title: 'plan' }],
  ] as const)('reads %j as its status, date and title', (head, expected) => {
    expect(parseTimelineItem(head)).toEqual(expected)
  })

  it('survives a bracket word that names an Object member', () => {
    for (const head of ['[constructor] a', '[toString] a', '[prototype] a', '[hasOwnProperty] a']) {
      expect(parseTimelineItem(head).status).toBe('todo')
      expect(parseTimelineItem(head).title).toContain(' a')
    }
  })

  it.each([
    ['', { title: '', options: { dense: false, status: true, marker: 'dot' } }],
    ['History', { title: 'History', options: { dense: false, status: true, marker: 'dot' } }],
    ['{dense}', { title: '', options: { dense: true, status: true, marker: 'dot' } }],
    ['History {status=off}', { title: 'History', options: { dense: false, status: false, marker: 'dot' } }],
    ['History {marker=number}', { title: 'History', options: { dense: false, status: true, marker: 'number' } }],
    ['History {dense} {status=off}', { title: 'History {dense}', options: { dense: false, status: false, marker: 'dot' } }],
    ['History {nonsense}', { title: 'History {nonsense}', options: { dense: false, status: true, marker: 'dot' } }],
    ['History {status=sideways}', { title: 'History {status=sideways}', options: { dense: false, status: true, marker: 'dot' } }],
  ] as const)('splits the header %j', (info, expected) => {
    expect(splitTimelineInfo(info)).toEqual(expected)
  })
})

