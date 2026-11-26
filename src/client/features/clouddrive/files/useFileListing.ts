import { useCallback, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { CloudDriveListing, CloudDriveSortDirection, CloudDriveSortKey } from '@shared/clouddrive/model'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { CloudDriveApiError, clouddriveApi, cloudDriveErrorKey } from '../api'
import { useTransferStore } from '../transfers/useTransferStore'

const PAGE_SIZE = 200

function appendListing(current: CloudDriveListing, next: CloudDriveListing): CloudDriveListing {
  const seen = new Set([...current.folders, ...current.files].map((entry) => entry.id))
  return {
    ...next,
    folders: [...current.folders, ...next.folders.filter((entry) => !seen.has(entry.id))],
    files: [...current.files, ...next.files.filter((entry) => !seen.has(entry.id))],
  }
}

export interface FileListingOptions {
  mountId: string
  path: string
  external: boolean
  sortKey: CloudDriveSortKey
  sortDir: CloudDriveSortDirection
  refreshKey: number
}

export function useFileListing({ mountId, path, external, sortKey, sortDir, refreshKey }: FileListingOptions) {
  const [listing, setListing] = useState<CloudDriveListing | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle')
  const [searchScope, setSearchScope] = useState<'drive' | 'folder' | 'all'>('drive')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [lockPath, setLockPath] = useState<string | null>(null)
  const [lockPassword, setLockPassword] = useState('')
  const [lockBusy, setLockBusy] = useState(false)
  const listingRef = useRef<CloudDriveListing | null>(null)
  const requestRef = useRef(0)
  const cursorRef = useRef<string | null>(null)

  useEffect(() => { listingRef.current = listing }, [listing])
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim().slice(0, 100)), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const driveSearch = (searchScope === 'drive' || searchScope === 'all') && query.length > 0 && !external
  const fetchPage = useCallback(async (cursor: string | null): Promise<CloudDriveListing> => {
    if (driveSearch) {
      const result = await clouddriveApi.search({ q: query, mountId, scope: searchScope === 'all' ? 'all' : 'drive', cursor, limit: PAGE_SIZE })
      return {
        mountId,
        path,
        folders: [],
        files: result.files,
        cursor: result.cursor,
        total: result.total,
        foldersTruncated: false,
        note: result.skippedMounts?.length ? t('clouddrive.search.skipped_mounts' as MessageKey, { value0: result.skippedMounts.join(', ') }) : null,
        footer: null,
      }
    }
    return await clouddriveApi.list({ mountId, path, sort: sortKey, dir: sortDir, limit: PAGE_SIZE, cursor, q: query || undefined })
  }, [driveSearch, mountId, path, searchScope, sortKey, sortDir, query])

  const load = useCallback(async (mode: 'reset' | 'more' = 'reset') => {
    const sequence = ++requestRef.current
    if (mode === 'reset') {
      setStatus('loading')
      setError(null)
    } else {
      setMore('loading')
    }
    try {
      const result = await fetchPage(mode === 'more' ? cursorRef.current : null)
      if (sequence !== requestRef.current) return
      setListing((current) => (mode === 'more' && current ? appendListing(current, result) : result))
      cursorRef.current = result.cursor
      setNextCursor(result.cursor)
      setMore('idle')
      setStatus('ready')
    } catch (caught) {
      if (sequence !== requestRef.current) return
      if (mode === 'more') {
        setMore('error')
        useUi.getState().toast({ title: t('clouddrive.search.load_more_failed'), description: caught instanceof Error ? caught.message : String(caught), tone: 'danger' })
        return
      }
      cursorRef.current = null
      setNextCursor(null)
      if (caught instanceof CloudDriveApiError && caught.code === 'clouddrive_meta_locked') {
        setStatus('ready')
        setError(null)
        setLockPath(path)
        return
      }
      const message = t(cloudDriveErrorKey(caught) as MessageKey)
      if (listingRef.current) {
        setStatus('ready')
        useUi.getState().toast({ title: message, tone: 'danger' })
      } else {
        setError(message)
        setStatus('error')
      }
    }
  }, [fetchPage, path])

  useEffect(() => {
    setListing(null)
    listingRef.current = null
    cursorRef.current = null
    setNextCursor(null)
    setMore('idle')
    setSearch('')
    setQuery('')
    setLockPath(null)
    setLockPassword('')
  }, [mountId, path])
  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => useTransferStore.subscribe((state, previous) => {
    const previousStatus = new Map(previous.items.map((item) => [item.id, item.status]))
    const arrived = state.items.some((item) => item.kind === 'upload'
      && item.status === 'success'
      && item.mountId === mountId
      && item.parentPath === path
      && previousStatus.get(item.id) !== 'success')
    if (arrived) void load()
  }), [load, mountId, path])

  const unlockFolder = async () => {
    if (!lockPath) return
    setLockBusy(true)
    try {
      await clouddriveApi.metaUnlock({ mountId, path: lockPath, password: lockPassword })
      setLockPath(null)
      setLockPassword('')
      await load()
    } catch (error) {
      useUi.getState().toast({ title: t('clouddrive.meta.unlock'), description: error instanceof Error ? error.message : '', tone: 'danger' })
    } finally {
      setLockBusy(false)
    }
  }

  return {
    listing, setListing, status, error, nextCursor, more, searchScope, setSearchScope, search, setSearch, query, setQuery,
    load, lockPath, setLockPath, lockPassword, setLockPassword, lockBusy, unlockFolder, driveSearch,
  }
}
