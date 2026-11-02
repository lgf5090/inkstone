import relationship from 'relationship.js'

export type KinshipRelation =
  | 'husband'
  | 'wife'
  | 'father'
  | 'mother'
  | 'older_brother'
  | 'younger_brother'
  | 'older_sister'
  | 'younger_sister'
  | 'son'
  | 'daughter'

export const KINSHIP_RELATIONS: readonly KinshipRelation[] = [
  'husband',
  'wife',
  'father',
  'mother',
  'older_brother',
  'younger_brother',
  'older_sister',
  'younger_sister',
  'son',
  'daughter',
]

const CHAIN_TERMS: Record<KinshipRelation, string> = {
  husband: '\u4e08\u592b',
  wife: '\u59bb\u5b50',
  father: '\u7238\u7238',
  mother: '\u5988\u5988',
  older_brother: '\u54e5\u54e5',
  younger_brother: '\u5f1f\u5f1f',
  older_sister: '\u59d0\u59d0',
  younger_sister: '\u59b9\u59b9',
  son: '\u513f\u5b50',
  daughter: '\u5973\u513f',
}

/** Longest chain we allow: the library stays under a frame or two at this depth. */
export const KINSHIP_MAX_CHAIN = 50

export interface KinshipLookup {
  forward: string[]
  reverse: string[]
}

export function kinshipChainText(relations: readonly KinshipRelation[]): string {
  return relations.map((relation) => CHAIN_TERMS[relation]).join('\u7684')
}

export function lookupKinship(relations: readonly KinshipRelation[]): KinshipLookup {
  const text = kinshipChainText(relations)
  if (!text) return { forward: [], reverse: [] }
  return { forward: lookup(text, false), reverse: lookup(text, true) }
}

function lookup(text: string, reverse: boolean): string[] {
  const titles = relationship({ text, sex: -1, reverse })
  return [...new Set(titles.filter((title) => typeof title === 'string' && title.trim().length > 0))]
}
