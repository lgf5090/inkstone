declare module 'relationship.js' {
  interface RelationshipOptions {
    text?: string
    target?: string
    sex?: -1 | 0 | 1
    type?: 'default' | 'chain' | 'pair'
    reverse?: boolean
    mode?: string
    optimal?: boolean
  }

  interface Relationship {
    (options: RelationshipOptions): string[]
    (expression: string): string[]
    readonly dataCount: number
    setMode(name: string, data: Record<string, string[]>): void
  }

  const relationship: Relationship
  export default relationship
}
