import { LIMITS } from './constants'
import { truncateText } from './text-utils'
import type { GraphEdge, GraphNode } from './types'

export const GRAPH_TAG_NODE_LIMIT = 60
export const GRAPH_TAG_EDGE_LIMIT = 2_000

export interface GraphTagNodeResult {
  added: number
  dropped: number
}

interface TagCluster {
  name: string
  color: string | null
  noteIds: string[]
}

function collectTagClusters(
  tagsByNote: Map<string, Array<{ name: string; color?: string | null }>>,
): Map<string, TagCluster> {
  const clusters = new Map<string, TagCluster>()
  for (const [noteId, tags] of tagsByNote) {
    for (const tag of tags) {
      const key = tag.name.toLowerCase()
      const current = clusters.get(key)
      if (current) current.noteIds.push(noteId)
      else clusters.set(key, { name: tag.name, color: tag.color ?? null, noteIds: [noteId] })
    }
  }
  return clusters
}

export function tagNodeId(name: string): string {
  return `tag:${name}`
}

export function applyTagNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  tagsByNote: Map<string, Array<{ name: string; color?: string | null }>>,
): GraphTagNodeResult {
  const ordered = [...collectTagClusters(tagsByNote).values()]
    .sort((a, b) => b.noteIds.length - a.noteIds.length || a.name.localeCompare(b.name))
  const kept = ordered.slice(0, GRAPH_TAG_NODE_LIMIT)
  let members = 0
  let added = 0
  for (const cluster of kept) {
    if (members + cluster.noteIds.length > GRAPH_TAG_EDGE_LIMIT) continue
    members += cluster.noteIds.length
    added++
    const name = truncateText(cluster.name, LIMITS.tagNameMaxLength)
    const id = tagNodeId(name)
    nodes.push({
      id,
      title: name,
      kind: 'tag',
      degree: cluster.noteIds.length,
      inDegree: cluster.noteIds.length,
      outDegree: 0,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [{ name, color: cluster.color }],
    })
    for (const noteId of cluster.noteIds) edges.push({ source: noteId, target: id })
  }
  return { added, dropped: ordered.length - added }
}
