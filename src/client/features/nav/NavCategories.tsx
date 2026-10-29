import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, FolderPlus, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { isEmojiIcon, normalizeCategoryName, normalizeIconName, type NavCategory, type NavPasswordMode } from '@shared/nav/model'
import { NAV_ICON_NAMES } from '@shared/nav/icon-catalog'
import { Modal, confirm } from '../../components/overlay'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Segmented, Select } from '../../components/form'
import { useUi } from '../../store/ui'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { EMOJI_ICON_ENTRIES } from '../../lib/emoji-catalog-data'
import { searchEmojiIn } from '../../lib/emoji-catalog-core'
import { usePinyinVersion } from '../../lib/pinyin'
import { categoryOptions } from './api'
import { NavIcon } from './nav-icons'
import { useNavStore } from './nav-store'

const CATEGORY_NAME_LIMIT = 60
const PASSWORD_MIN_LENGTH = 8

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : t('nav.error.generic')
}

type IconTab = 'emoji' | 'lucide'

/**
 * The category icon picker: the curated Lucide set and the emoji catalogue, with one search box
 * narrowing whichever tab is showing. Every tile is a button that names itself, and the current
 * value stays visible above the grid so a pick is confirmed without leaving the form.
 */
export function IconPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [tab, setTab] = useState<IconTab>(() => (isEmojiIcon(value) ? 'emoji' : 'lucide'))
  const [query, setQuery] = useState('')
  const pinyinVersion = usePinyinVersion()
  const normalized = normalizeIconName(value)
  const emojiEntries = useMemo(
    () => (query.trim() ? searchEmojiIn(EMOJI_ICON_ENTRIES, query) : EMOJI_ICON_ENTRIES),
    [query, pinyinVersion],
  )
  const lucideNames = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? NAV_ICON_NAMES.filter((name) => name.includes(needle)) : NAV_ICON_NAMES
  }, [query])
  const total = tab === 'emoji' ? emojiEntries.length : lucideNames.length
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<IconTab>
          label={t('nav.category.icon')}
          size="sm" className="size-9 md:size-6"
          value={tab}
          options={[
            { value: 'emoji', label: t('nav.icon.emoji') },
            { value: 'lucide', label: t('nav.icon.lucide') },
          ]}
          onChange={setTab}
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('nav.icon.search')}
          placeholder={t('nav.icon.search')}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
        />
      </div>
      <div className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 py-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-surface)]">
          <NavIcon name={value} size={15} />
        </span>
        <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('nav.icon.current')}</span>
        <span className="min-w-0 flex-1 truncate text-right text-[length:var(--text-12)] text-[var(--text-secondary)]">
          {isEmojiIcon(value) ? value : normalized}
        </span>
      </div>
      {total === 0 ? (
        <p className="rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-6 text-center text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
          {t('nav.empty_search.title')}
        </p>
      ) : (
        <div
          role="group"
          aria-label={tab === 'emoji' ? t('nav.icon.emoji') : t('nav.icon.lucide')}
          className="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] content-start gap-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-1.5"
        >
          {tab === 'emoji'
            ? emojiEntries.map((entry) => {
                const active = value === entry.char
                return (
                  <button
                    key={entry.char}
                    type="button"
                    aria-label={entry.char}
                    aria-pressed={active}
                    title={entry.keys}
                    onClick={() => onChange(entry.char)}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-15)] leading-none transition-colors',
                      active
                        ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent-ring)]'
                        : 'hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span aria-hidden="true">{entry.char}</span>
                  </button>
                )
              })
            : lucideNames.map((name) => {
                const active = normalized === name
                return (
                  <button
                    key={name}
                    type="button"
                    aria-label={name}
                    aria-pressed={active}
                    title={name}
                    onClick={() => onChange(name)}
                    className={cn(
                      'flex size-9 items-center justify-center rounded-[var(--r-sm)] transition-colors',
                      active
                        ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)] ring-1 ring-[var(--accent-ring)]'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    <NavIcon name={name} size={17} />
                  </button>
                )
              })}
        </div>
      )}
    </div>
  )
}

interface CategoryRowProps {
  category: NavCategory
  count: number
  first: boolean
  last: boolean
  disabled: boolean
  onEdit: () => void
  onAddChild?: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onDelete: () => void
}

function CategoryRow({ category, count, first, last, disabled, onEdit, onAddChild, onMoveUp, onMoveDown, onDelete }: CategoryRowProps) {
  return (
    <div
      data-nav-category-id={category.id}
      className="flex items-center gap-2 rounded-[var(--r-sm)] px-1.5 py-1 hover:bg-[var(--bg-hover)]"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--bg-inset)] text-[var(--text-secondary)]">
        <NavIcon name={category.icon} size={15} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{category.name}</span>
      {category.hasPassword && (
        <Lock size={12} aria-label={t('nav.locked')} role="img" className="shrink-0 text-[var(--text-quaternary)]" />
      )}
      <span aria-hidden="true" className="shrink-0 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
        {count}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={`${t('nav.move_up')} ${category.name}`} size="sm" className="size-9 md:size-6" disabled={disabled || first} onClick={onMoveUp}>
          <ChevronUp size={13} />
        </IconButton>
        <IconButton label={`${t('nav.move_down')} ${category.name}`} size="sm" className="size-9 md:size-6" disabled={disabled || last} onClick={onMoveDown}>
          <ChevronDown size={13} />
        </IconButton>
        <IconButton label={`${t('nav.edit')} ${category.name}`} size="sm" className="size-9 md:size-6" disabled={disabled} onClick={onEdit}>
          <Pencil size={13} />
        </IconButton>
        {onAddChild && (
          <IconButton
            label={t('nav.category.add_child', { name: category.name })}
            size="sm" className="size-9 md:size-6"
            disabled={disabled}
            onClick={onAddChild}
          >
            <FolderPlus size={13} />
          </IconButton>
        )}
        <IconButton
          label={`${t('nav.delete')} ${category.name}`}
          size="sm"
          disabled={disabled}
          onClick={onDelete}
          className="size-9 text-[var(--danger)] md:size-6"
        >
          <Trash2 size={13} />
        </IconButton>
      </div>
    </div>
  )
}

interface EditorState {
  id: string | null
  parentId: string | null
  parentName: string | null
  name: string
  icon: string
  passwordMode: NavPasswordMode
  password: string
  /** Editing a category that already carries a custom password: a blank field means "keep it". */
  hasCustomPassword: boolean
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  parentId: null,
  parentName: null,
  name: '',
  icon: 'folder',
  passwordMode: 'none',
  password: '',
  hasCustomPassword: false,
}

interface DeleteState {
  target: NavCategory
  fallbackId: string | null
}

/**
 * Category management: roots with their direct children, each group reorderable with buttons that
 * work from a keyboard and a touch screen. The form edits one category at a time, and a delete asks
 * for the category that receives the orphaned links before the confirmation dialog opens.
 */
export function CategoryManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const categories = useNavStore((state) => state.categories)
  const links = useNavStore((state) => state.links)
  const createCategory = useNavStore((state) => state.createCategory)
  const updateCategory = useNavStore((state) => state.updateCategory)
  const deleteCategory = useNavStore((state) => state.deleteCategory)
  const reorderCategories = useNavStore((state) => state.reorderCategories)
  const toast = useUi((state) => state.toast)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleting, setDeleting] = useState<DeleteState | null>(null)
  const [busy, setBusy] = useState(false)

  const tree = useMemo(() => {
    const sorted = [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    const roots = sorted.filter((category) => !category.parentId)
    const children = new Map<string, NavCategory[]>()
    for (const category of sorted) {
      if (!category.parentId) continue
      const siblings = children.get(category.parentId) ?? []
      siblings.push(category)
      children.set(category.parentId, siblings)
    }
    return { roots, children }
  }, [categories])

  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const link of links) counts.set(link.categoryId, (counts.get(link.categoryId) ?? 0) + 1)
    return counts
  }, [links])

  useEffect(() => {
    if (open) return
    setEditor(null)
    setDeleting(null)
    setBusy(false)
  }, [open])

  const rowsLocked = busy || editor !== null || deleting !== null

  function fallbackChoices(target: NavCategory): { value: string; label: string }[] {
    const removed = new Set<string>([target.id])
    for (const child of tree.children.get(target.id) ?? []) removed.add(child.id)
    return categoryOptions(categories).filter((option) => !removed.has(option.value))
  }

  function startCreate(parent: NavCategory | null) {
    setDeleting(null)
    setEditor({
      ...EMPTY_EDITOR,
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
    })
  }

  function startEdit(category: NavCategory) {
    setDeleting(null)
    setEditor({
      id: category.id,
      parentId: category.parentId,
      parentName: category.parentId ? categories.find((item) => item.id === category.parentId)?.name ?? null : null,
      name: category.name,
      icon: category.icon || 'folder',
      passwordMode: category.passwordMode,
      password: '',
      hasCustomPassword: category.passwordMode === 'custom' && category.hasPassword,
    })
  }

  function startDelete(category: NavCategory) {
    setEditor(null)
    setDeleting({ target: category, fallbackId: fallbackChoices(category)[0]?.value ?? null })
  }

  const trimmedName = editor ? normalizeCategoryName(editor.name) : ''
  const nameValid = trimmedName.length > 0 && trimmedName.length <= CATEGORY_NAME_LIMIT
  const passwordValid = !editor || editor.passwordMode !== 'custom'
    || editor.password.length >= PASSWORD_MIN_LENGTH
    || (editor.hasCustomPassword && editor.password.length === 0)
  const canSave = Boolean(editor) && nameValid && passwordValid && !busy

  async function save() {
    if (!editor || !canSave) return
    const body: { name: string; icon: string; passwordMode: NavPasswordMode; password?: string } = {
      name: trimmedName,
      icon: editor.icon || 'folder',
      passwordMode: editor.passwordMode,
    }
    if (editor.passwordMode === 'custom' && editor.password) body.password = editor.password
    setBusy(true)
    try {
      if (editor.id) {
        await updateCategory(editor.id, body)
      } else {
        await createCategory({ ...body, parentId: editor.parentId, password: body.password })
      }
      setEditor(null)
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function move(category: NavCategory, siblings: NavCategory[], delta: -1 | 1, parentId: string | null) {
    if (busy) return
    const index = siblings.findIndex((item) => item.id === category.id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= siblings.length) return
    const ordered = siblings.map((item) => item.id)
    const [moved] = ordered.splice(index, 1)
    if (!moved) return
    ordered.splice(target, 0, moved)
    setBusy(true)
    try {
      await reorderCategories(parentId, ordered)
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeWithFallback() {
    if (!deleting?.fallbackId || busy) return
    const target = deleting.target
    const fallbackId = deleting.fallbackId
    const confirmed = await confirm({
      title: t('nav.category.delete_title'),
      description: `${target.name}: ${t('nav.category.delete_hint')}`,
      confirmLabel: t('nav.delete'),
      cancelLabel: t('nav.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      await deleteCategory(target.id, fallbackId)
      setDeleting(null)
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function removeWithNewFallback() {
    if (!deleting || busy) return
    const target = deleting.target
    const confirmed = await confirm({
      title: t('nav.category.delete_title'),
      description: `${target.name}: ${t('nav.category.delete_hint')}`,
      confirmLabel: t('nav.delete'),
      cancelLabel: t('nav.cancel'),
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const fallback = await createCategory({
        name: t('nav.category.create_fallback'),
        icon: 'folder',
        parentId: null,
        passwordMode: 'none',
        password: undefined,
      })
      await deleteCategory(target.id, fallback.id)
      setDeleting(null)
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const deleteChoices = deleting ? fallbackChoices(deleting.target) : []

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      title={t('nav.category_manager')}
      width={620}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('nav.close')}
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={13} />}
            disabled={rowsLocked}
            onClick={() => startCreate(null)}
          >
            {t('nav.category.add_root')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {editor && (
          <form
            className="rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
                {editor.id
                  ? t('nav.category.edit_title')
                  : editor.parentName
                    ? t('nav.category.add_child', { name: editor.parentName })
                    : t('nav.category.add_root')}
              </h3>
              <span className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                {editor.parentName
                  ? `${t('nav.category.parent')}: ${editor.parentName}`
                  : t('nav.category.no_parent')}
              </span>
            </div>
            <div className="flex flex-col gap-3">
              <Field label={t('nav.category.name')} required>
                <Input
                  value={editor.name}
                  onChange={(event) => setEditor((current) => (current ? { ...current, name: event.target.value } : current))}
                  maxLength={CATEGORY_NAME_LIMIT}
                  required
                  autoFocus
                />
              </Field>
              <div className="space-y-1.5">
                <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                  {t('nav.category.icon')}
                </span>
                <IconPicker
                  value={editor.icon}
                  onChange={(icon) => setEditor((current) => (current ? { ...current, icon } : current))}
                />
              </div>
              <div className="space-y-1.5">
                <span className="block text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
                  {t('nav.category.password')}
                </span>
                <Segmented<NavPasswordMode>
                  label={t('nav.category.password')}
                  value={editor.passwordMode}
                  options={[
                    { value: 'none', label: t('nav.category.password_none') },
                    { value: 'custom', label: t('nav.category.password_custom') },
                    { value: 'default', label: t('nav.category.password_default') },
                  ]}
                  onChange={(passwordMode) => setEditor((current) => (current ? { ...current, passwordMode } : current))}
                />
              </div>
              {editor.passwordMode === 'custom' && (
                <Field label={t('nav.unlock.password')} hint={t('nav.category.password_hint')}>
                  <Input
                    type="password"
                    value={editor.password}
                    onChange={(event) => setEditor((current) => (current ? { ...current, password: event.target.value } : current))}
                    autoComplete="new-password"
                  />
                </Field>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditor(null)} disabled={busy}>
                  {t('nav.cancel')}
                </Button>
                <Button type="submit" variant="primary" loading={busy} disabled={!canSave}>
                  {t('nav.save')}
                </Button>
              </div>
            </div>
          </form>
        )}

        {deleting && (
          <div className="rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-surface)] p-3">
            <h3 className="text-[length:var(--text-13)] font-semibold text-[var(--text-primary)]">
              {t('nav.category.delete_title')}: {deleting.target.name}
            </h3>
            <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">
              {t('nav.category.delete_hint')}
            </p>
            {deleteChoices.length > 0 ? (
              <Field label={t('nav.category.fallback')} className="mt-2">
                <Select
                  value={deleting.fallbackId ?? ''}
                  onChange={(event) => setDeleting((current) => (
                    current ? { ...current, fallbackId: event.target.value } : current
                  ))}
                >
                  {deleteChoices.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className="mt-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-quaternary)]">
                {t('nav.category.empty')}
              </p>
            )}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={busy}>
                {t('nav.cancel')}
              </Button>
              {deleteChoices.length > 0 ? (
                <Button variant="danger" loading={busy} onClick={() => void removeWithFallback()}>
                  {t('nav.delete')}
                </Button>
              ) : (
                <Button variant="danger" loading={busy} onClick={() => void removeWithNewFallback()}>
                  {t('nav.category.create_fallback')}
                </Button>
              )}
            </div>
          </div>
        )}

        {tree.roots.length === 0 ? (
          <p className="py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
            {t('nav.category.empty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tree.roots.map((root, index) => {
              const children = tree.children.get(root.id) ?? []
              return (
                <li key={root.id}>
                  <CategoryRow
                    category={root}
                    count={linkCounts.get(root.id) ?? 0}
                    first={index === 0}
                    last={index === tree.roots.length - 1}
                    disabled={rowsLocked}
                    onEdit={() => startEdit(root)}
                    onAddChild={() => startCreate(root)}
                    onMoveUp={() => void move(root, tree.roots, -1, null)}
                    onMoveDown={() => void move(root, tree.roots, 1, null)}
                    onDelete={() => startDelete(root)}
                  />
                  {children.length > 0 && (
                    <ul className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-[var(--border-subtle)] pl-2">
                      {children.map((child, childIndex) => (
                        <li key={child.id}>
                          <CategoryRow
                            category={child}
                            count={linkCounts.get(child.id) ?? 0}
                            first={childIndex === 0}
                            last={childIndex === children.length - 1}
                            disabled={rowsLocked}
                            onEdit={() => startEdit(child)}
                            onMoveUp={() => void move(child, children, -1, root.id)}
                            onMoveDown={() => void move(child, children, 1, root.id)}
                            onDelete={() => startDelete(child)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/**
 * Unlocks one protected category for the tab's session. The dialog owns the in-flight state so a
 * refused password leaves the field where the reader can correct it, and a success closes it.
 */
export function UnlockModal({ category, onClose }: { category: NavCategory | null; onClose: () => void }) {
  const unlock = useNavStore((state) => state.unlock)
  const toast = useUi((state) => state.toast)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const categoryId = category?.id ?? null

  useEffect(() => {
    setPassword('')
    setError(null)
    setBusy(false)
  }, [categoryId])

  if (!category) return null

  async function submit() {
    if (!category || !password || busy) return
    setBusy(true)
    setError(null)
    try {
      await unlock(category.id, password)
      toast({ title: t('nav.unlock.success'), tone: 'success' })
      onClose()
    } catch (failure) {
      const message = errorMessage(failure)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      title={t('nav.unlock.title', { name: category.name })}
      width={400}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('nav.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!password} onClick={() => void submit()}>
            {t('nav.unlock.action')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="flex flex-col gap-2 pt-1"
      >
        <Field label={t('nav.unlock.password')}>
          <Input
            data-autofocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            invalid={Boolean(error)}
            aria-invalid={Boolean(error)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
