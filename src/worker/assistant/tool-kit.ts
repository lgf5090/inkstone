/** The small runtime pieces every tool module needs, kept out of `tools.ts` to avoid an import cycle. */
export function tool<T>(definition: T): T {
  return definition
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}