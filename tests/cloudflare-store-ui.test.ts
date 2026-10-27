// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CatalogTemplate, CatalogTemplateType, TemplateItem } from '../src/client/features/cloudflare/api/store'
import {
  autoResourceName,
  categoryCounts,
  collectTags,
  compareVersions,
  defaultDeployName,
  filterTemplates,
  resolveDeployType,
  sortTemplates,
  templateKey,
} from '../src/client/features/cloudflare/screens/store/helpers'

function item(
  id: string,
  type: CatalogTemplateType,
  version: string,
  extra: Partial<CatalogTemplate> = {},
  sourceId = 'source-a',
): TemplateItem {
  const template: CatalogTemplate = {
    id,
    name: id,
    version,
    type,
    ...extra,
  }
  return { template, sourceId, sourceName: sourceId, sourceCount: 1 }
}

const emptyFilter = {
  search: '',
  type: null,
  tags: [],
  favoriteIds: [],
  favoritesOnly: false,
} as const

describe('store catalogue helpers', () => {
  it('counts every template type plus the total', () => {
    const items = [
      item('worker-a', 'worker', '1.0.0'),
      item('worker-b', 'worker', '1.0.0'),
      item('pages-a', 'pages', '1.0.0'),
      item('hybrid-a', 'hybrid', '1.0.0'),
    ]
    expect(categoryCounts(items)).toEqual({ all: 4, worker: 2, pages: 1, hybrid: 1 })
  })

  it('collects distinct tags in alphabetical order', () => {
    const items = [
      item('a', 'worker', '1.0.0', { tags: ['storage', 'kv'] }),
      item('b', 'worker', '1.0.0', { tags: ['kv', 'ai'] }),
    ]
    expect(collectTags(items)).toEqual(['ai', 'kv', 'storage'])
  })

  it('matches the search in the name, description and tags', () => {
    const items = [
      item('alpha', 'worker', '1.0.0', { description: 'A cache proxy' }),
      item('beta', 'pages', '1.0.0', { tags: ['static-site'] }),
      item('gamma', 'hybrid', '1.0.0'),
    ]
    expect(filterTemplates(items, { ...emptyFilter, search: 'cache' }).map((entry) => entry.template.id)).toEqual(['alpha'])
    expect(filterTemplates(items, { ...emptyFilter, search: 'site' }).map((entry) => entry.template.id)).toEqual(['beta'])
    expect(filterTemplates(items, { ...emptyFilter, search: 'gamma' }).map((entry) => entry.template.id)).toEqual(['gamma'])
  })

  it('filters by type and by any selected tag', () => {
    const items = [
      item('worker', 'worker', '1.0.0', { tags: ['kv', 'cron'] }),
      item('pages', 'pages', '1.0.0', { tags: ['static'] }),
      item('hybrid', 'hybrid', '1.0.0', { tags: ['kv'] }),
    ]
    expect(filterTemplates(items, { ...emptyFilter, type: 'worker' }).map((entry) => entry.template.id)).toEqual(['worker'])
    expect(filterTemplates(items, { ...emptyFilter, tags: ['cron', 'static'] }).map((entry) => entry.template.id)).toEqual(['worker', 'pages'])
  })

  it('scopes favourites to the source that carries the template', () => {
    const items = [
      item('shared', 'worker', '1.0.0', {}, 'source-a'),
      item('shared', 'worker', '1.0.0', {}, 'source-b'),
    ]
    expect(templateKey(items[0]!)).toBe('source-a::shared')
    expect(filterTemplates(items, { ...emptyFilter, favoriteIds: ['source-b::shared'], favoritesOnly: true }))
      .toEqual([items[1]])
  })

  it('puts favourites first and orders each group by name, newest or version', () => {
    const items = [
      item('alpha', 'worker', '1.0.0'),
      item('beta', 'worker', '2.0.0'),
      item('gamma', 'worker', '1.10.0'),
    ]
    expect(sortTemplates(items, 'name', []).map((entry) => entry.template.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(sortTemplates(items, 'newest', []).map((entry) => entry.template.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(sortTemplates(items, 'version', []).map((entry) => entry.template.id)).toEqual(['beta', 'gamma', 'alpha'])
    expect(sortTemplates(items, 'name', ['source-a::beta']).map((entry) => entry.template.id)).toEqual(['beta', 'alpha', 'gamma'])
    expect(sortTemplates(items, 'version', ['source-a::beta']).map((entry) => entry.template.id)).toEqual(['beta', 'gamma', 'alpha'])
  })

  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0)
  })

  it('resolves a hybrid deployment to the chosen half and leaves fixed types to the server', () => {
    expect(resolveDeployType('hybrid', 'both')).toBeUndefined()
    expect(resolveDeployType('hybrid', 'worker')).toBe('worker')
    expect(resolveDeployType('hybrid', 'pages')).toBe('pages')
    expect(resolveDeployType('worker', 'both')).toBeUndefined()
    expect(resolveDeployType('pages', 'worker')).toBeUndefined()
  })

  it('sanitises deployment and resource names', () => {
    expect(defaultDeployName('Hello Store')).toBe('hello-store')
    expect(defaultDeployName('--Bad__Name--')).toBe('bad-name')
    expect(defaultDeployName('')).toBe('template')
    expect(autoResourceName('My Template', 'CACHE')).toBe('my-template-cache')
    expect(defaultDeployName('a'.repeat(80))).toHaveLength(63)
  })
})
