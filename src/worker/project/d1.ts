export const PROJECT_D1_PARAMETER_LIMIT = 100
export const PROJECT_D1_ID_CHUNK_SIZE = 90

export function projectIdChunks(ids: readonly string[]): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += PROJECT_D1_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(index, index + PROJECT_D1_ID_CHUNK_SIZE))
  }
  return chunks
}

export function projectPlaceholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `?${index + start}`).join(', ')
}
