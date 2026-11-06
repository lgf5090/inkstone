import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '../../../../components/overlay'
import { Button } from '../../../../components/primitives'
import { Input } from '../../../../components/form'
import { t } from '../../../../lib/i18n'
import { useUiStore } from '../../../../lib/ui-store'
import type { ShortLink } from '@shared/tools/shortlinks/types'
import { useShortlinksStore } from '../store'
import { shortlinksApi } from '../api'

/** One page of the account's links; 50 keeps a 150-link account inside D1's bound-parameter limit. */
const PAGE_SIZE = 50
/** The add endpoint binds every id in one statement, so the modal hands it slices of the same size. */
const ADD_BATCH_SIZE = 50

export function ManageBundleLinksModal() {
  const open = useShortlinksStore((s) => s.manageBundleLinksModalOpen)
  const setOpen = useShortlinksStore((s) => s.setManageBundleLinksModalOpen)
  const activeBundleId = useShortlinksStore((s) => s.activeBundleId)
  const bundles = useShortlinksStore((s) => s.bundles)
  const activeBundleLinks = useShortlinksStore((s) => s.activeBundleLinks)
  const selectBundle = useShortlinksStore((s) => s.selectBundle)
  const fetchBundles = useShortlinksStore((s) => s.fetchBundles)

  const [allUserLinks, setAllUserLinks] = useState<ShortLink[]>([])
  const [total, setTotal] = useState(0)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [initialIds, setInitialIds] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [saving, setSaving] = useState(false)
  const initializedRef = useRef(false)
  // A search or bundle switch starts a new page-one fetch; a late answer from the old query must not
  // append rows to a list the user is already looking at.
  const requestSeqRef = useRef(0)

  const bundle = bundles.find((b) => b.id === activeBundleId)

  useEffect(() => {
    if (!open) {
      initializedRef.current = false
      requestSeqRef.current += 1
      return
    }
    if (!activeBundleId) return

    // The baseline is the bundle's membership at open time; the live list may still be loading, so
    // it can never be used to infer deletions.
    if (!initializedRef.current) {
      const ids = new Set(activeBundleLinks.map((l) => l.id))
      initializedRef.current = true
      setInitialIds(ids)
      setSelectedIds(new Set(ids))
      setSearch('')
    }

    const seq = ++requestSeqRef.current
    setLoading(true)
    shortlinksApi
      .getLinks({ limit: PAGE_SIZE, offset: 0, search: search.trim() || undefined })
      .then((res) => {
        if (seq !== requestSeqRef.current) return
        setAllUserLinks(res.items)
        setTotal(res.total)
      })
      .catch((err) => {
        if (seq === requestSeqRef.current) useUiStore.getState().toast((err as Error).message, 'error')
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false)
      })
  }, [open, activeBundleId, activeBundleLinks, search])

  const handleToggle = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleLoadMore = async () => {
    if (!activeBundleId || loading || loadingMore) return
    const seq = requestSeqRef.current
    setLoadingMore(true)
    try {
      const res = await shortlinksApi.getLinks({
        limit: PAGE_SIZE,
        offset: allUserLinks.length,
        search: search.trim() || undefined,
      })
      if (seq !== requestSeqRef.current) return
      setAllUserLinks((prev) => [...prev, ...res.items])
      setTotal(res.total)
    } catch (err) {
      if (seq === requestSeqRef.current) useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  const handleSave = async () => {
    if (!activeBundleId) return
    setSaving(true)
    try {
      const toAdd = Array.from(selectedIds).filter((id) => !initialIds.has(id))
      const toRemove = Array.from(initialIds).filter((id) => !selectedIds.has(id))

      for (let offset = 0; offset < toAdd.length; offset += ADD_BATCH_SIZE) {
        await shortlinksApi.addLinksToBundle(activeBundleId, toAdd.slice(offset, offset + ADD_BATCH_SIZE))
      }
      for (const id of toRemove) {
        await shortlinksApi.removeLinkFromBundle(activeBundleId, id)
      }

      useUiStore.getState().toast(t('tools.shortlinks.settings.save_success'), 'success')
      setOpen(false)
      void selectBundle(activeBundleId)
      void fetchBundles()
    } catch (err) {
      useUiStore.getState().toast((err as Error).message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      dismissible={!saving}
      onClose={() => setOpen(false)}
      title={`${t('tools.shortlinks.bundles.manage_links')}${bundle ? ` - ${bundle.name}` : ''}`}
      width={560}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('tools.shortlinks.bundles.selected_count', { count: selectedIds.size })}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving || loading}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="py-2 space-y-3">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tools.shortlinks.links.search_placeholder')}
            className="h-9 pl-8"
          />
        </div>
        {loading ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('common.loading')}
          </div>
        ) : (allUserLinks || []).length === 0 ? (
          <div className="py-8 text-center text-[var(--text-tertiary)] text-[length:var(--text-13)]">
            {t('tools.shortlinks.links.empty')}
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
            {allUserLinks.map((l) => {
              const isChecked = selectedIds.has(l.id)
              const primarySlug = l.slugs.find((s) => s.is_primary)?.slug || l.slugs[0]?.slug
              return (
                <label
                  key={l.id}
                  className="flex items-center gap-3 p-2 rounded-[var(--r-md)] hover:bg-[var(--bg-hover)] cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleToggle(l.id)}
                    className="size-4 rounded accent-[var(--accent)]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
                        /{primarySlug}
                      </span>
                      {l.label && (
                        <span className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">
                          {l.label}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-[length:var(--text-11)] text-[var(--text-tertiary)] font-mono">
                      {l.url}
                    </div>
                  </div>
                </label>
              )
            })}
          </div>
        )}
        {!loading && total > 0 && (
          <div className="flex items-center justify-between gap-2 px-1">
            <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              {t('tools.shortlinks.bundles.loaded_count', { loaded: allUserLinks.length, total })}
            </span>
            {allUserLinks.length < total && (
              <Button variant="ghost" size="sm" onClick={handleLoadMore} loading={loadingMore}>
                {t('tools.shortlinks.bundles.load_more')}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
