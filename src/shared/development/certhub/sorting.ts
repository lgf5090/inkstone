import { CERTHUB_ORDER_SORTS, type CerthubOrderSort } from './types'

export function parseOrderSort(raw: string | null | undefined): CerthubOrderSort | null {
  if (!raw) return 'updated'
  return (CERTHUB_ORDER_SORTS as readonly string[]).includes(raw) ? raw as CerthubOrderSort : null
}

export function orderSortFromSearch(search: string): CerthubOrderSort {
  try {
    return parseOrderSort(new URLSearchParams(search).get('sort')) ?? 'updated'
  } catch {
    return 'updated'
  }
}
