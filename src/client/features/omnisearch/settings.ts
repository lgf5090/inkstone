/**
 * Turns the stored settings into what the engine and the indexer actually consume, and derives the
 * fingerprint that decides whether a cached index is still valid. Anything that changes the tokens
 * themselves belongs in the fingerprint; anything that only changes ranking does not.
 */
import type { SearchSettings } from '@shared/types'
import { pinyinIsLoaded } from '../../lib/pinyin'
import type { DocumentSettings } from './document'
import type { ResolvedEngineSettings } from './engine'

export function engineSettings(search: SearchSettings): ResolvedEngineSettings {
  return {
    weights: {
      title: search.weightTitle,
      folder: search.weightFolder,
      headings1: search.weightH1,
      headings2: search.weightH2,
      headings3: search.weightH3,
      tags: search.weightTags,
    },
    customPropertyWeights: search.weightCustomProperties,
    recency: { enabled: search.recencyBoost !== 'disabled', cutoff: search.recencyBoost },
    fuzziness: search.fuzziness,
    simpleSearch: search.simpleSearch,
    ignoreDiacritics: search.ignoreDiacritics,
    hideArchived: search.hideArchived,
    downrankedFolders: search.downrankedFolders,
    maxResults: search.maxResults,
    maxEmbeds: search.maxEmbeds,
    showExcerpt: search.showExcerpt,
    keepLineReturns: search.renderLineReturnInExcerpts,
    plainExcerpt: search.plainExcerpt,
  }
}

export function documentSettings(search: SearchSettings): DocumentSettings {
  return {
    displayTitle: search.displayTitleProperty,
    customPropertyNames: search.weightCustomProperties.map((item) => item.name),
    contentCap: search.maxContentChars,
  }
}

/**
 * Bumped whenever the tokenizer or the fold changes shape, because no setting can express that: a
 * cache written by the previous tokens would answer a query the reader can no longer satisfy.
 */
export const OMNISEARCH_TOKEN_REVISION = 2

/** Every setting that changes the tokens, so a stale cache can never answer with old ones. */
export function indexFingerprint(search: SearchSettings): string {
  const flags = [
    search.ignoreDiacritics,
    search.splitCamelCase,
    search.cjkBigrams,
    search.pinyinSearch && pinyinIsLoaded(),
  ].map((value) => (value ? '1' : '0')).join('')
  const properties = [...search.weightCustomProperties.map((item) => item.name)].sort().join(',')
  return [
    String(OMNISEARCH_TOKEN_REVISION),
    flags,
    search.displayTitleProperty,
    properties,
    search.maxContentChars,
    search.maxIndexedNotes,
  ].join('|')
}

export function bodyBudgetBytes(search: SearchSettings): number {
  return search.indexStorageMb * 1024 * 1024
}
