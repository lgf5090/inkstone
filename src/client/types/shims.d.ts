


declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'
  const plugin: (md: MarkdownIt, options?: Record<string, unknown>) => void
  export default plugin
}

declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it'
  const plugin: (md: MarkdownIt) => void
  export default plugin
}

declare module 'markdown-it-mark' {
  import type MarkdownIt from 'markdown-it'
  const plugin: (md: MarkdownIt) => void
  export default plugin
}

/** A file's own text, imported through Vite's raw loader. */
declare module '*.md?raw' {
  const text: string
  export default text
}

declare module 'katex/dist/katex.min.css'

declare module 'mind-elixir/style.css'

declare module 'prismjs/components/prism-core' {
  import Prism from 'prismjs'
  export default Prism
}

declare module 'prismjs/components/*'

declare module 'moment-parseformat' {
  /** Moment's format-detection: the pattern string a piece of text was written with. */
  const parseFormat: (text: string) => string
  export default parseFormat
}

declare module 'dagre-d3-es/src/dagre/index.js' {
  export function layout(graph: any): void;
}

declare module 'dagre-d3-es/src/graphlib/index.js' {
  export class Graph {
    constructor(options?: any);
    setGraph(opt: any): this;
    setDefaultEdgeLabel(callback: () => any): this;
    setNode(name: string, label: any): this;
    setEdge(v: string, w: string, name?: string): this;
    nodes(): string[];
    edges(): Array<{ v: string; w: string; name?: string }>;
    node(name: string): any;
    edge(v: string, w: string, name?: string): any;
  }
}
