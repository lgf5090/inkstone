import { describe, expect, it } from 'vitest'
import { ORGANIZER_COLORS } from '@shared/organizer-colors'
import { buildSceneNodes, connectedClusters, nodeColor } from './scene'
import type { SceneResponse } from './types'

function response(): SceneResponse {
  return {
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      title: id,
      kind: 'note',
      degree: id === 'd' ? 0 : 1,
      inDegree: id === 'd' ? 0 : 1,
      outDegree: id === 'd' ? 0 : 1,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    })),
    edges: [{ source: 'a', target: 'b' }],
    meta: { mode: 'global', centerId: null, depth: 1, totalNodes: 4, totalEdges: 1, truncated: false, limit: 350 },
  }
}

describe('graph connected clusters', () => {
  it('groups linked nodes and leaves every orphan in its own cluster', () => {
    const clusters = connectedClusters(response())
    expect(clusters.get('a')).toBe(clusters.get('b'))
    expect(new Set([clusters.get('a'), clusters.get('c'), clusters.get('d')]).size).toBe(3)
  })

  it('stamps cluster colors only when cluster grouping is selected', () => {
    const nodes = buildSceneNodes(response(), { nodeScale: 1, groupBy: 'cluster', colorGroups: [] }, new Map(), [])
    expect(nodes[0]?.cluster).toBe(nodes[1]?.cluster)
    expect(nodeColor(nodes[0]!, 'cluster', '#000000')).toBe(ORGANIZER_COLORS[nodes[0]!.cluster! % ORGANIZER_COLORS.length])
    const plain = buildSceneNodes(response(), { nodeScale: 1, groupBy: 'none', colorGroups: [] }, new Map(), [])
    expect(plain[0]?.cluster).toBeUndefined()
  })
})
