/**
 * One snippet's editor.
 *
 * The draft is local until Save: every file tab, the description, the tags and the folder are edited
 * here and written together, so a version is a version of the whole snippet rather than of whichever
 * text box happened to be focused. The right column holds the facts that are not code — source,
 * notes, publication, assets and history — and it is the same column on a phone, below the editor.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft, Copy, Download, FileCode2, Image as ImageIcon, MoreHorizontal, Paperclip, Pin, Plus,
  Save, Star, Trash2, Upload, Wand2,
} from 'lucide-react'
import type { ScriptFolder, ScriptSnippetDetail, ScriptTag } from '@shared/scriptshub/types'
import { publicationUrlPath } from '@shared/scriptshub/path'
import {
  SCRIPT_LANGUAGES, defaultFileNames, languageFor, languageFromFileName, type ScriptLanguageId,
} from '@shared/scriptshub/languages'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/hooks'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { copyText } from '../../lib/clipboard'
import { Badge, Button, IconButton, Spinner } from '../../components/primitives'
import { Input, Switch, Textarea, commitOnEnter } from '../../components/form'
import { Empty } from '../../components/feedback'
import { Menu, Modal, Tooltip, confirm, hasOpenLayer, useContextMenu, type MenuItem } from '../../components/overlay'
import { SelectMenu } from '../../components/select-menu'
import { FolderPicker } from '../folders/FolderPicker'
import { useUi } from '../../store/ui'
import { useScriptsHub, folderPathOf } from './store'
import { asNotebookFolders } from './sidebar'
import { LanguageIcon } from './language-icon'
import { TagPickerDialog } from './tag-picker'
import { ScriptCodeEditor } from './script-code-editor'
import { PublishPanel } from './publish-panel'
import { RevisionsPanel } from './revisions-panel'
import { scriptshubApi, assetUrl } from './api'
import type { ScriptAsset } from '@shared/scriptshub/types'

interface DraftFile {
  key: string
  id?: string
  name: string
  language: ScriptLanguageId
  content: string
}

interface Draft {
  title: string
  description: string
  folderId: string | null
  sourceUrl: string
  notes: string
  tags: string[]
  files: DraftFile[]
}

function draftFromDetail(detail: ScriptSnippetDetail): Draft {
  return {
    title: detail.title,
    description: detail.description,
    folderId: detail.folderId,
    sourceUrl: detail.sourceUrl,
    notes: detail.notes,
    tags: detail.tags.map((tag) => tag.id),
    files: detail.files.map((file) => ({
      key: file.id,
      id: file.id,
      name: file.name,
      language: file.language,
      content: file.content,
    })),
  }
}

function localFileKey(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function fileNameFor(language: ScriptLanguageId, existing: readonly DraftFile[]): string {
  let name = defaultFileNames(language)[0]!
  if (!existing.some((file) => file.name.toLowerCase() === name.toLowerCase())) return name
  for (let index = 2; index < 100; index++) {
    const candidate = `part-${index}.${languageFor(language).defaultExtension}`
    if (!existing.some((file) => file.name.toLowerCase() === candidate.toLowerCase())) return candidate
  }
  return `${Date.now()}.${languageFor(language).defaultExtension}`
}

function lineCount(text: string): number {
  return text ? text.split('\n').length : 1
}

export function SnippetEditor({ detail, folders, tags, mobile, openPanel, onPanelHandled, onBack }: {
  detail: ScriptSnippetDetail
  folders: readonly ScriptFolder[]
  tags: readonly ScriptTag[]
  mobile: boolean
  openPanel?: 'history' | 'publish' | null
  onPanelHandled?: () => void
  onBack: () => void
}) {
  const wide = useMediaQuery('(min-width: 1280px)')
  const toast = useUi((state) => state.toast)
  const save = useScriptsHub((state) => state.save)
  const remove = useScriptsHub((state) => state.remove)
  const patch = useScriptsHub((state) => state.patchSnippet)
  const createTag = useScriptsHub((state) => state.createTag)
  const [draft, setDraft] = useState<Draft>(() => draftFromDetail(detail))
  const [activeKey, setActiveKey] = useState(detail.files[0]?.id ?? '')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [tagOpen, setTagOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [fileDialog, setFileDialog] = useState<{ mode: 'add' | 'rename'; key?: string; name: string; language: ScriptLanguageId } | null>(null)
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [fileDraft, setFileDraft] = useState('')
  const fileMenu = useContextMenu()
  const [fileMenuKey, setFileMenuKey] = useState<string | null>(null)
  const publishRef = useRef<HTMLDivElement>(null)
  const [assets, setAssets] = useState<ScriptAsset[]>([])
  const [assetBusy, setAssetBusy] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreAnchor = useRef<HTMLButtonElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const saveRef = useRef<() => void>(() => {})
  const folderInputs = useMemo(() => asNotebookFolders(folders), [folders])
  const activeFile = draft.files.find((file) => file.key === activeKey) ?? draft.files[0]

  useEffect(() => {
    const next = draftFromDetail(detail)
    setDraft(next)
    setActiveKey((current) => (next.files.some((file) => file.key === current) ? current : next.files[0]?.key ?? ''))
    setDirty(false)
  }, [detail.id, detail.revisionCount])

  // A row's "version history" or "publication" menu item selects the snippet and asks the editor to
  // open that surface; it is handled once and then cleared so a later selection starts on the code.
  useEffect(() => {
    if (!openPanel) return
    if (openPanel === 'history') setHistoryOpen(true)
    if (openPanel === 'publish') {
      publishRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    onPanelHandled?.()
  }, [onPanelHandled, openPanel])

  useEffect(() => {
    let alive = true
    void scriptshubApi.assets(detail.id).then((response) => {
      if (alive) setAssets(response.assets)
    }).catch(() => {
      // Attachments are supplementary: a refused list leaves the panel empty instead of taking the
      // editor down, and the upload button still reports its own failure.
      if (alive) setAssets([])
    })
    return () => {
      alive = false
    }
  }, [detail.id])

  const modify = (change: (current: Draft) => Draft) => {
    setDraft((current) => change(current))
    setDirty(true)
  }

  const updateFile = (key: string, patchFile: Partial<DraftFile>) => {
    modify((current) => ({
      ...current,
      files: current.files.map((file) => (file.key === key ? { ...file, ...patchFile } : file)),
    }))
  }

  const doSave = async () => {
    if (saving) return
    const first = draft.files[0]
    if (!first) return
    setSaving(true)
    try {
      await save(detail.id, {
        title: draft.title,
        description: draft.description,
        folderId: draft.folderId,
        language: first.language,
        sourceUrl: draft.sourceUrl,
        notes: draft.notes,
        tags: draft.tags,
        files: draft.files.map((file) => ({
          ...(file.id ? { id: file.id } : {}),
          name: file.name,
          language: file.language,
          content: file.content,
        })),
      })
      setDirty(false)
      toast({ title: t('scriptshub.editor.saved'), tone: 'success' })
    } catch (error) {
      toast({
        title: t('scriptshub.editor.save_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }
  saveRef.current = () => void doSave()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      if (hasOpenLayer()) return
      event.preventDefault()
      saveRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const deleteSnippet = async () => {
    const agreed = await confirm({
      title: t('scriptshub.confirm.delete_snippet_title', { title: draft.title }),
      description: t('scriptshub.confirm.delete_snippet_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    await remove(detail.id)
    onBack()
  }

  const copyActive = async () => {
    if (!activeFile) return
    const ok = await copyText(activeFile.content)
    toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
    if (ok) {
      void scriptshubApi.recordCopy(detail.id, activeFile.id ?? null).catch((error: unknown) => {
        console.warn('[inkstone] scriptshub copy count failed:', error instanceof Error ? error.message : error)
      })
    }
  }

  const downloadActive = () => {
    if (!activeFile) return
    const url = URL.createObjectURL(new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = activeFile.name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const openAddFile = () => {
    const language = activeFile?.language ?? detail.language
    setFileDialog({ mode: 'add', language, name: fileNameFor(language, draft.files) })
  }

  const applyFileDialog = () => {
    if (!fileDialog) return
    const name = fileDialog.name.trim()
    if (!name) return
    const language = languageFromFileName(name).id === 'text' ? fileDialog.language : languageFromFileName(name).id
    if (fileDialog.mode === 'add') {
      const key = localFileKey()
      modify((current) => ({ ...current, files: [...current.files, { key, name, language, content: '' }] }))
      setActiveKey(key)
    } else if (fileDialog.key) {
      updateFile(fileDialog.key, { name, language })
    }
    setFileDialog(null)
  }

  const deleteFile = async (key: string) => {
    if (draft.files.length <= 1) {
      toast({ title: t('scriptshub.editor.keep_one_file'), tone: 'warning' })
      return
    }
    const target = draft.files.find((file) => file.key === key)
    if (!target) return
    const agreed = await confirm({
      title: t('scriptshub.editor.delete_file_title', { name: target.name }),
      description: t('scriptshub.editor.delete_file_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    modify((current) => ({ ...current, files: current.files.filter((file) => file.key !== key) }))
    if (activeKey === key) setActiveKey(draft.files[0]?.key ?? '')
  }

  const startFileRename = (file: DraftFile) => {
    setFileMenuKey(file.key)
    setRenamingFile(file.key)
    setFileDraft(file.name)
  }

  const commitFileRename = (key: string) => {
    const name = fileDraft.trim()
    setRenamingFile(null)
    if (!name) return
    const clash = draft.files.some((file) => file.key !== key && file.name.toLowerCase() === name.toLowerCase())
    if (clash) {
      toast({ title: t('scriptshub.toast.file_name_taken'), tone: 'warning' })
      return
    }
    const language = languageFromFileName(name).id === 'text'
      ? draft.files.find((file) => file.key === key)?.language ?? 'text'
      : languageFromFileName(name).id
    updateFile(key, { name, language })
  }

  const copyFile = async (file: DraftFile) => {
    const ok = await copyText(file.content)
    toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
    if (ok && file.id) {
      void scriptshubApi.recordCopy(detail.id, file.id).catch((error: unknown) => {
        console.warn('[inkstone] scriptshub copy count failed:', error instanceof Error ? error.message : error)
      })
    }
  }

  const downloadFile = (file: DraftFile) => {
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const copyPublished = async (text: string) => {
    const ok = await copyText(text)
    toast({ title: ok ? t('scriptshub.publish.command_copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
  }

  const fileActions = (file: DraftFile): MenuItem[] => {
    const publication = detail.publications.find((entry) => entry.fileId === file.id) ?? null
    return [
      { id: 'new-file', label: t('scriptshub.editor.add_file'), icon: <Plus size={13} aria-hidden="true" />, onSelect: openAddFile },
      { id: 'copy-all-files', label: t('scriptshub.menu.copy_all_files'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => {
        void copyText(draft.files.map((entry) => `# ${entry.name}\n${entry.content}`).join('\n\n')).then((ok) => {
          toast({ title: ok ? t('scriptshub.editor.copied') : t('scriptshub.common.copy_failed'), tone: ok ? 'success' : 'danger' })
        })
      } },
      { id: 'rename-file', label: t('scriptshub.menu.rename_file'), separatorBefore: true, onSelect: () => startFileRename(file) },
      { id: 'copy-file', label: t('scriptshub.menu.copy_file'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => void copyFile(file) },
      { id: 'download-file', label: t('scriptshub.menu.download_file'), icon: <Download size={13} aria-hidden="true" />, onSelect: () => downloadFile(file) },
      { id: 'publish-file', label: t('scriptshub.menu.publish'), icon: <Upload size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => publishRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }) },
      { id: 'copy-path', label: t('scriptshub.menu.copy_path'), icon: <FileCode2 size={13} aria-hidden="true" />, disabled: !publication, reason: publication ? undefined : t('scriptshub.menu.reason_no_publication'), onSelect: () => {
        if (publication) void copyPublished(`${window.location.origin}${publicationUrlPath(publication.path)}`)
      } },
      { id: 'copy-curl', label: t('scriptshub.menu.copy_curl'), icon: <Download size={13} aria-hidden="true" />, disabled: !publication, reason: publication ? undefined : t('scriptshub.menu.reason_no_publication'), onSelect: () => {
        if (!publication) return
        const url = `${window.location.origin}${publicationUrlPath(publication.path)}`
        void copyPublished(file.language === 'shell' ? `curl -fsSL ${url} | bash` : `curl -fsSL ${url} -o ${file.name}`)
      } },
      { id: 'delete-file', label: t('scriptshub.common.delete'), icon: <Trash2 size={13} aria-hidden="true" />, tone: 'danger', separatorBefore: true, onSelect: () => void deleteFile(file.key) },
    ]
  }

  const uploadAsset = async (file: File | undefined) => {
    if (!file) return
    setAssetBusy(true)
    try {
      const result = await scriptshubApi.uploadAsset(detail.id, file)
      setAssets((current) => [result.asset, ...current])
      toast({ title: t('scriptshub.assets.uploaded'), tone: 'success' })
    } catch (error) {
      toast({ title: t('scriptshub.assets.upload_failed'), description: error instanceof Error ? error.message : String(error), tone: 'danger' })
    } finally {
      setAssetBusy(false)
      if (uploadRef.current) uploadRef.current.value = ''
    }
  }

  const removeAsset = async (asset: ScriptAsset) => {
    const agreed = await confirm({
      title: t('scriptshub.assets.delete_title', { name: asset.fileName }),
      description: t('scriptshub.assets.delete_body'),
      confirmLabel: t('scriptshub.common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    await scriptshubApi.deleteAsset(asset.id)
    setAssets((current) => current.filter((entry) => entry.id !== asset.id))
  }

  const folderLabel = folderPathOf(folders, draft.folderId).map((folder) => folder.name).join(' / ') || t('scriptshub.sidebar.unfiled')
  const tagList = draft.tags.map((id) => tags.find((tag) => tag.id === id)).filter((tag): tag is ScriptTag => Boolean(tag))
  const menuItems: MenuItem[] = [
    { id: 'copy', label: t('scriptshub.editor.copy'), icon: <Copy size={13} aria-hidden="true" />, onSelect: () => void copyActive() },
    { id: 'download', label: t('scriptshub.editor.download'), icon: <Download size={13} aria-hidden="true" />, onSelect: downloadActive },
    { id: 'history', label: t('scriptshub.revisions.title'), icon: <Wand2 size={13} aria-hidden="true" />, onSelect: () => setHistoryOpen(true) },
    { id: 'delete', label: t('scriptshub.editor.delete_snippet'), icon: <Trash2 size={13} aria-hidden="true" />, separatorBefore: true, onSelect: () => void deleteSnippet() },
  ]

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-[var(--bg-base)]">
        <header className="flex items-start gap-2 border-b border-[var(--border-subtle)] px-3 py-2.5 md:px-4">
          {mobile && (
            <IconButton label={t('scriptshub.common.back')} onClick={onBack} className="mt-0.5">
              <ArrowLeft size={16} aria-hidden="true" />
            </IconButton>
          )}
          <LanguageIcon id={activeFile?.language ?? detail.language} size={22} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <Input
              value={draft.title}
              aria-label={t('scriptshub.editor.title')}
              onChange={(event) => modify((current) => ({ ...current, title: event.target.value }))}
              className="h-8 border-transparent bg-transparent px-1 text-[length:var(--text-16)] font-semibold md:h-8"
            />
            <div className="flex flex-wrap items-center gap-1.5 px-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
              <span>{t('scriptshub.editor.updated', { time: relativeTime(detail.updatedAt) })}</span>
              <span>·</span>
              <span>{t('scriptshub.editor.files_meta', { count: draft.files.length, revisions: detail.revisionCount })}</span>
              <span>·</span>
              <span>{t('scriptshub.editor.usage', { copies: detail.copyCount, downloads: detail.downloadCount })}</span>
              {dirty && <span className="text-[var(--warning)]">{t('scriptshub.editor.unsaved')}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {!mobile && (
              <>
                <IconButton
                  label={detail.isFavorite ? t('scriptshub.editor.unfavorite') : t('scriptshub.editor.favorite')}
                  active={detail.isFavorite}
                  onClick={() => void patch(detail.id, { isFavorite: !detail.isFavorite })}
                >
                  <Star size={15} aria-hidden="true" />
                </IconButton>
                <IconButton
                  label={detail.isPinned ? t('scriptshub.editor.unpin') : t('scriptshub.editor.pin')}
                  active={detail.isPinned}
                  onClick={() => void patch(detail.id, { isPinned: !detail.isPinned })}
                >
                  <Pin size={15} aria-hidden="true" />
                </IconButton>
                <IconButton label={t('scriptshub.editor.copy')} onClick={() => void copyActive()}>
                  <Copy size={15} aria-hidden="true" />
                </IconButton>
              </>
            )}
            <Button variant="primary" size="sm" loading={saving} disabled={!dirty} icon={<Save size={12} aria-hidden="true" />} onClick={() => void doSave()}>
              {t('scriptshub.common.save')}
            </Button>
            <IconButton ref={moreAnchor} label={t('scriptshub.common.more')} onClick={() => setMoreOpen(true)}>
              <MoreHorizontal size={16} aria-hidden="true" />
            </IconButton>
          </div>
          <Menu anchor={moreAnchor} open={moreOpen} onClose={() => setMoreOpen(false)} items={menuItems} align="end" width={210} />
        </header>

        {historyOpen ? (
          <RevisionsPanel
            detail={detail}
            activeFileId={activeFile?.id ?? null}
            onClose={() => setHistoryOpen(false)}
          />
        ) : (
        <div className="min-h-0 flex-1 overflow-y-auto xl:flex xl:overflow-hidden">
          <main className="flex min-w-0 flex-col p-3 md:p-4 xl:min-h-0 xl:flex-1 xl:overflow-hidden">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => setFolderOpen(true)} className="max-w-full">
                <span className="truncate">{folderLabel}</span>
              </Button>
              {tagList.map((tag) => (
                <span key={tag.id} className="inline-flex max-w-[160px] items-center gap-1 rounded-[var(--r-full)] border border-[var(--border-subtle)] px-2 py-0.5 text-[length:var(--text-11)] text-[var(--text-secondary)]">
                  {tag.color && <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />}
                  <span className="truncate">#{tag.name}</span>
                  <button
                    type="button"
                    aria-label={t('scriptshub.editor.remove_tag', { name: tag.name })}
                    onClick={() => modify((current) => ({ ...current, tags: current.tags.filter((id) => id !== tag.id) }))}
                    className="text-[var(--text-quaternary)] hover:text-[var(--danger)]"
                  >
                    ×
                  </button>
                </span>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus size={11} aria-hidden="true" />} onClick={() => setTagOpen(true)}>
                {t('scriptshub.editor.add_tag')}
              </Button>
            </div>

            <div className="mt-2.5 flex min-h-0 flex-1 flex-col">
              <div role="tablist" aria-label={t('scriptshub.editor.files')} className="flex items-center gap-0.5 overflow-x-auto border-b border-[var(--border-subtle)] pb-1">
                {draft.files.map((file) => {
                  const publication = detail.publications.find((entry) => entry.fileId === file.id) ?? null
                  return (
                  <div
                    key={file.key}
                    className={cn('group flex items-center rounded-[var(--r-sm)]', activeKey === file.key ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]')}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setActiveKey(file.key)
                      fileMenu.close()
                      fileMenu.onContextMenu(event)
                      setFileMenuKey(file.key)
                    }}
                  >
                    {renamingFile === file.key ? (
                      <Input
                        autoFocus
                        aria-label={t('scriptshub.menu.rename_file')}
                        value={fileDraft}
                        onChange={(event) => setFileDraft(event.target.value)}
                        onBlur={() => commitFileRename(file.key)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault()
                            commitFileRename(file.key)
                          }
                          if (event.key === 'Escape') {
                            setRenamingFile(null)
                            setFileDraft(file.name)
                          }
                        }}
                        className="w-[160px]"
                      />
                    ) : (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeKey === file.key}
                        onClick={() => setActiveKey(file.key)}
                        onDoubleClick={() => startFileRename(file)}
                        className={cn(
                          'flex h-8 max-w-[200px] items-center gap-1.5 px-2 text-[length:var(--text-11-5)]',
                          activeKey === file.key ? 'text-[var(--accent-on-soft)]' : 'text-[var(--text-tertiary)]',
                        )}
                      >
                        <LanguageIcon id={file.language} size={13} />
                        <span className="truncate">{file.name}</span>
                      </button>
                    )}
                    {publication && (
                      <Tooltip label={t('scriptshub.publish.tab_published', { path: publication.path })} side="bottom">
                        <span className="mx-0.5 size-1.5 shrink-0 rounded-full bg-[var(--success)]" aria-hidden="true" />
                      </Tooltip>
                    )}
                    <IconButton
                      label={t('scriptshub.editor.remove_file', { name: file.name })}
                      size="xs"
                      onClick={() => void deleteFile(file.key)}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Trash2 size={10} aria-hidden="true" />
                    </IconButton>
                  </div>
                  )
                })}
                <IconButton label={t('scriptshub.editor.add_file')} size="sm" onClick={openAddFile} className="ml-1">
                  <Plus size={13} aria-hidden="true" />
                </IconButton>
              </div>

              {fileMenu.point && fileMenuKey && (
                <Menu
                  anchor={fileMenu.point}
                  open
                  onClose={() => {
                    fileMenu.close()
                    setFileMenuKey(null)
                  }}
                  items={fileActions(draft.files.find((file) => file.key === fileMenuKey) ?? activeFile ?? draft.files[0]!)}
                />
              )}

              {activeFile && (
                <>
                  <ScriptCodeEditor
                    value={activeFile.content}
                    language={activeFile.language}
                    fileName={activeFile.name}
                    ariaLabel={t('scriptshub.editor.code_label', { name: activeFile.name })}
                    onChange={(content) => updateFile(activeFile.key, { content })}
                    minHeight={mobile ? 300 : 420}
                    fill={wide}
                    wrap={wrap}
                    scrollKey={`${detail.id}:${activeFile.key}`}
                    className="mt-2"
                  />
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                    <span>{t('scriptshub.editor.lines_chars', { lines: lineCount(activeFile.content), chars: activeFile.content.length })}</span>
                    <span>·</span>
                    <button
                      type="button"
                      aria-pressed={wrap}
                      onClick={() => setWrap((on) => !on)}
                      className="rounded-[var(--r-xs)] px-1 text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
                    >
                      {wrap ? t('scriptshub.editor.wrap_on') : t('scriptshub.editor.wrap_off')}
                    </button>
                    <div className="ml-auto flex items-center gap-1.5">
                      <SelectMenu
                        size="sm"
                        label={t('scriptshub.editor.file_language')}
                        value={activeFile.language}
                        options={SCRIPT_LANGUAGES.map((language) => ({
                          value: language.id,
                          label: t(language.labelKey),
                          icon: <LanguageIcon id={language.icon} size={13} />,
                        }))}
                        onChange={(value) => {
                          const old = activeFile.language
                          const inferred = languageFromFileName(activeFile.name).id
                          const dot = activeFile.name.lastIndexOf('.')
                          const nextName = inferred === old && dot > 0
                            ? `${activeFile.name.slice(0, dot)}.${languageFor(value).defaultExtension}`
                            : activeFile.name
                          updateFile(activeFile.key, { language: value, name: nextName })
                        }}
                        width={200}
                        className="w-[140px]"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </main>

          <aside className="w-full space-y-3 border-t border-[var(--border-subtle)] p-3 md:p-4 xl:w-[310px] xl:shrink-0 xl:overflow-y-auto xl:border-t-0 xl:border-l">
            <section className="space-y-2.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
              <label className="block space-y-1.5">
                <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.editor.description')}</span>
                <Textarea
                  rows={2}
                  value={draft.description}
                  placeholder={t('scriptshub.editor.description_placeholder')}
                  onChange={(event) => modify((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.editor.source_url')}</span>
                <Input
                  type="url"
                  value={draft.sourceUrl}
                  placeholder="https://"
                  onChange={(event) => modify((current) => ({ ...current, sourceUrl: event.target.value }))}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.editor.notes')}</span>
                <Textarea
                  rows={4}
                  value={draft.notes}
                  placeholder={t('scriptshub.editor.notes_placeholder')}
                  onChange={(event) => modify((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
              <label className="flex items-center gap-2.5">
                <Switch
                  checked={detail.isDeprecated}
                  label={t('scriptshub.editor.deprecated')}
                  onChange={(next) => void patch(detail.id, { isDeprecated: next })}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.editor.deprecated')}</span>
                  <span className="block text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.editor.deprecated_hint')}</span>
                </span>
                {detail.isDeprecated && <Badge tone="warning">{t('scriptshub.list.deprecated')}</Badge>}
              </label>
            </section>

            <div ref={publishRef}>
              <PublishPanel detail={detail} activeFileId={activeFile?.id ?? null} />
            </div>

            <section aria-labelledby="scriptshub-assets-heading" className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-3">
              <div className="flex items-center gap-1.5">
                <Paperclip size={12} aria-hidden="true" className="text-[var(--text-quaternary)]" />
                <h2 id="scriptshub-assets-heading" className="min-w-0 flex-1 text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">
                  {t('scriptshub.assets.title')}
                </h2>
                <input ref={uploadRef} type="file" className="sr-only" accept="image/*,application/pdf,application/zip,text/plain,application/json" onChange={(event) => void uploadAsset(event.target.files?.[0])} />
                <IconButton label={t('scriptshub.assets.upload')} size="xs" onClick={() => uploadRef.current?.click()}>
                  {assetBusy ? <Spinner size={11} /> : <Plus size={12} aria-hidden="true" />}
                </IconButton>
              </div>
              {assets.length === 0 ? (
                <p className="mt-2 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('scriptshub.assets.empty')}</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {assets.map((asset) => (
                    <li key={asset.id} className="flex items-center gap-1.5 rounded-[var(--r-sm)] px-1 py-0.5 hover:bg-[var(--bg-hover)]">
                      {asset.contentType.startsWith('image/') ? (
                        <img src={assetUrl(asset.id)} alt={asset.fileName} className="size-6 shrink-0 rounded-[var(--r-xs)] object-cover" />
                      ) : (
                        <ImageIcon size={12} aria-hidden="true" className="shrink-0 text-[var(--text-quaternary)]" />
                      )}
                      <a href={assetUrl(asset.id)} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-secondary)] hover:text-[var(--accent)]">
                        {asset.fileName}
                      </a>
                      <IconButton label={t('scriptshub.assets.delete')} size="xs" onClick={() => void removeAsset(asset)}>
                        <Trash2 size={10} aria-hidden="true" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <Button variant="secondary" block icon={<Wand2 size={13} aria-hidden="true" />} onClick={() => setHistoryOpen(true)}>
              {t('scriptshub.revisions.open', { count: detail.revisionCount })}
            </Button>
          </aside>
        </div>
        )}
      </div>

      <FolderPicker
        open={folderOpen}
        title={t('scriptshub.editor.move_folder')}
        folders={folderInputs}
        currentId={draft.folderId}
        allowRoot
        rootLabel={t('scriptshub.sidebar.unfiled')}
        onSelect={(folderId) => modify((current) => ({ ...current, folderId }))}
        onClose={() => setFolderOpen(false)}
      />
      <TagPickerDialog
        open={tagOpen}
        tags={tags}
        selected={draft.tags}
        title={t('scriptshub.editor.tags_title')}
        onClose={() => setTagOpen(false)}
        onCreate={(name) => createTag({ name })}
        onConfirm={(ids) => modify((current) => ({ ...current, tags: ids }))}
      />
      <FileDialog state={fileDialog} onChange={setFileDialog} onClose={() => setFileDialog(null)} onSubmit={applyFileDialog} />

      {dirty && mobile && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-[var(--z-sticky)] flex justify-center">
          <Button variant="primary" loading={saving} icon={<Save size={13} aria-hidden="true" />} onClick={() => void doSave()} className="pointer-events-auto shadow-[var(--shadow-pop)]">
            {t('scriptshub.editor.save_changes')}
          </Button>
        </div>
      )}
    </>
  )
}

function FileDialog({ state, onChange, onClose, onSubmit }: {
  state: { mode: 'add' | 'rename'; key?: string; name: string; language: ScriptLanguageId } | null
  onChange: (state: { mode: 'add' | 'rename'; key?: string; name: string; language: ScriptLanguageId } | null) => void
  onClose: () => void
  onSubmit: () => void
}) {
  return (
    <Modal
      open={state !== null}
      onClose={onClose}
      title={state?.mode === 'add' ? t('scriptshub.editor.add_file') : t('scriptshub.editor.rename_file')}
      width={420}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('scriptshub.common.cancel')}</Button>
          <Button variant="primary" disabled={!state?.name.trim()} onClick={onSubmit}>{t('scriptshub.common.save')}</Button>
        </>
      )}
    >
      {state && (
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.editor.file_name')}</span>
            <Input
              autoFocus
              value={state.name}
              onChange={(event) => onChange({ ...state, name: event.target.value })}
              onKeyDown={(event) => commitOnEnter(event, onSubmit)}
              placeholder={t('scriptshub.editor.file_name_placeholder')}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[length:var(--text-11-5)] font-medium text-[var(--text-secondary)]">{t('scriptshub.editor.file_language')}</span>
            <SelectMenu
              label={t('scriptshub.editor.file_language')}
              value={state.language}
              options={SCRIPT_LANGUAGES.map((language) => ({
                value: language.id,
                label: t(language.labelKey),
                icon: <LanguageIcon id={language.icon} size={13} />,
              }))}
              onChange={(language) => onChange({ ...state, language })}
              width={220}
            />
          </label>
        </div>
      )}
    </Modal>
  )
}

export function EditorPlaceholder({ art, title, description, action }: {
  art?: 'folder' | 'search' | 'notes'
  title: string
  description?: string
  action?: ReactNode
}) {
  return <Empty art={art} title={title} description={description} action={action} />
}

export function EditorLoading() {
  return <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>
}

export function EditorError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-[length:var(--text-12-5)] text-[var(--danger)]">{message}</p>
      <Button size="sm" variant="secondary" onClick={onRetry}>{t('scriptshub.common.retry')}</Button>
    </div>
  )
}
