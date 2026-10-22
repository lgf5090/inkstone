import { HardDrive, Upload, X } from 'lucide-react'
import type { HubAttachmentWithUsage } from '@shared/attachment-hub'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { Modal } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { FolderPicker } from '../../folders/FolderPicker'
import { AttachmentHubSidebar } from '../attachment-hub-sidebar'
import { AttachmentHubToolbar } from '../attachment-hub-toolbar'
import { AttachmentDashboardView } from '../attachment-dashboard-view'
import { AttachmentGridView } from '../attachment-grid-view'
import { AttachmentListView } from '../attachment-list-view'
import { AttachmentInspector } from '../attachment-inspector'
import { AttachmentBatchBar } from '../attachment-batch-bar'
import { AttachmentQrModal } from '../attachment-qr-modal'
import { AttachmentRenameModal } from '../attachment-rename-modal'
import { UploadEmptyState } from '../attachment-item-common'
import { hubFolderToNoteFolder } from '../attachment-helpers'
import { FilePreviewModal } from '../../file-preview'
import { LoadingBlock } from '../../../components/feedback'
import { useAttachmentHubModal } from './hooks'

const MODAL_WIDTH = 1300

type HubBundle = ReturnType<typeof useAttachmentHubModal>

interface AttachmentHubModalProps {
  open: boolean
  onClose: () => void
  onInsertFile?: (file: HubAttachmentWithUsage) => void
}

export function AttachmentHubModal(props: AttachmentHubModalProps) {
  const { open, onClose, onInsertFile } = props
  const hub = useAttachmentHubModal(open)

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        ariaLabel={t('attachments.hub_title')}
        width={MODAL_WIDTH}
        className='h-[82vh] max-h-[calc(100dvh-2rem)] min-h-[24rem] p-0 overflow-hidden flex flex-col'
        bodyClassName='p-0 flex-1 min-h-0 flex flex-col overflow-hidden'
      >
        <HubHeader onClose={onClose} />
        <div className='flex min-h-0 flex-1'>
          <AttachmentHubSidebar
            selectedCategory={hub.category}
            onSelectCategory={(category) => {
              hub.setCategory(category)
              hub.setFolderId(null)
              hub.setTag(null)
            }}
            selectedFolderId={hub.folderId}
            onSelectFolder={(id) => {
              hub.setFolderId(id)
              hub.setCategory('all')
              hub.setTag(null)
            }}
            selectedTag={hub.tag}
            onSelectTag={(tagName) => {
              hub.setTag(tagName)
              hub.setCategory('all')
              hub.setFolderId(null)
            }}
            stats={hub.stats}
            onDropFilesToFolder={hub.handleDropFilesToFolder}
          />
          <HubMain hub={hub} onInsertFile={onInsertFile} />
          <AttachmentInspector
            file={hub.activeFile}
            onClose={() => hub.setActiveFile(null)}
            onRename={hub.setRenameFile}
            onShowQr={hub.setQrFile}
            onInsertHere={onInsertFile}
            onDelete={(file) => void hub.handleDeleteFile(file)}
            onUpdateTags={hub.handleUpdateTags}
            onPreview={hub.handlePreview}
          />
        </div>
      </Modal>
      <HubDialogs hub={hub} />
    </>
  )
}

function HubHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className='flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-[var(--sp-4)]'>
      <div className='flex items-center gap-[var(--sp-2)]'>
        <HardDrive size={16} className='text-[var(--accent)]' />
        <h2 className='text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]'>
          {t('attachments.hub_title')}
        </h2>
      </div>
      <IconButton label={t('common.close')} size='sm' onClick={onClose}>
        <X size={15} />
      </IconButton>
    </div>
  )
}

function HubMain({ hub, onInsertFile }: { hub: HubBundle; onInsertFile?: (file: HubAttachmentWithUsage) => void }) {
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          hub.setIsDragOverMain(true)
        }
      }}
      onDragLeave={() => hub.setIsDragOverMain(false)}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return
        e.preventDefault()
        hub.setIsDragOverMain(false)
        void hub.uploadFiles(e.dataTransfer.files)
      }}
      className={cn(
        'relative flex min-w-0 flex-1 flex-col bg-[var(--bg-base)]',
        hub.isDragOverMain && 'bg-[var(--accent-soft)]/20 ring-2 ring-[var(--accent)] ring-inset',
      )}
    >
      <AttachmentHubToolbar
        search={hub.search}
        onSearchChange={hub.setSearch}
        extension={hub.extension}
        onExtensionChange={hub.setExtension}
        sizeRange={hub.sizeRange}
        onSizeRangeChange={hub.setSizeRange}
        sort={hub.sort}
        onSortChange={hub.setSort}
        viewMode={hub.viewMode}
        onViewModeChange={hub.setViewMode}
        zoom={hub.zoom}
        onZoomChange={hub.setZoom}
        stats={hub.stats}
        onUploadClick={() => hub.fileInputRef.current?.click()}
        onPruneClick={() => void hub.prune()}
        pruning={hub.isPruning}
      />
      <input
        ref={hub.fileInputRef}
        type='file'
        multiple
        aria-label={t('attachments.upload_file')}
        className='hidden'
        onChange={(e) => {
          if (e.target.files) void hub.uploadFiles(e.target.files)
        }}
      />
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <HubContent hub={hub} onInsertFile={onInsertFile} />
      </div>
      <AttachmentBatchBar
        selectedCount={hub.selectedIds.size}
        onClearSelection={() => hub.setSelectedIds(new Set())}
        onBatchDownload={hub.handleBatchDownload}
        onBatchMove={() => hub.setMovingFileIds(Array.from(hub.selectedIds))}
        onBatchStar={() => void hub.handleBatchStar()}
        onBatchDelete={() => void hub.handleBatchDelete()}
      />
    </div>
  )
}

function HubContent({ hub, onInsertFile }: { hub: HubBundle; onInsertFile?: (file: HubAttachmentWithUsage) => void }) {
  if (hub.category === 'dashboard') {
    return (
      <AttachmentDashboardView
        stats={hub.stats}
        onSelectCategory={(category) => {
          hub.setCategory(category)
          hub.setFolderId(null)
          hub.setTag(null)
        }}
        onSelectExtension={(ext) => {
          hub.setExtension(ext)
          hub.setCategory('all')
          hub.setFolderId(null)
          hub.setTag(null)
        }}
        onPreviewFile={hub.handlePreview}
        onDownloadFile={hub.handleDownloadFile}
        onDeleteFile={(file) => void hub.handleDeleteFile(file)}
        onPrune={() => void hub.prune()}
      />
    )
  }
  if (hub.isLoading && hub.files.length === 0) return <LoadingBlock label={t('common.loading')} />
  if (hub.files.length === 0) return <HubEmptyState hasSearch={Boolean(hub.search)} onUploadClick={() => hub.fileInputRef.current?.click()} />
  return (
    <>
      <HubFileView hub={hub} onInsertFile={onInsertFile} />
      {hub.stats && hub.stats.totalCount > hub.files.length && (
        <p className='px-[var(--sp-4)] pb-[var(--sp-4)] text-[length:var(--text-11)] text-[var(--text-quaternary)]'>
          {t('attachments.shown_value0', { value0: hub.files.length })}
        </p>
      )}
    </>
  )
}

function HubEmptyState({ hasSearch, onUploadClick }: { hasSearch: boolean; onUploadClick: () => void }) {
  if (hasSearch) {
    return (
      <div className='flex h-full flex-col items-center justify-center px-[var(--sp-4)] py-[var(--sp-16)] text-center'>
        <Upload size={24} className='mb-[var(--sp-3)] text-[var(--text-quaternary)]' />
        <p className='max-w-sm text-[length:var(--text-13)] font-medium text-[var(--text-secondary)]'>
          {t('attachments.none_match')}
        </p>
      </div>
    )
  }
  return (
    <div className='flex h-full flex-col p-[var(--sp-4)]'>
      <UploadEmptyState onUploadClick={onUploadClick} />
    </div>
  )
}

function HubFileView({ hub, onInsertFile }: { hub: HubBundle; onInsertFile?: (file: HubAttachmentWithUsage) => void }) {
  const commonProps = {
    files: hub.files,
    selectedIds: hub.selectedIds,
    onToggleSelect: hub.handleToggleSelect,
    activeFile: hub.activeFile,
    onSelectActive: hub.setActiveFile,
    onPreview: hub.handlePreview,
    onRename: hub.setRenameFile,
    onShowQr: hub.setQrFile,
    onInsertHere: onInsertFile,
    onToggleStar: hub.handleToggleStar,
    onTogglePin: hub.handleTogglePin,
    onMoveToFolder: (file: HubAttachmentWithUsage) => hub.setMovingFileIds([file.id]),
    onDelete: hub.handleDeleteFile,
    onUploadClick: () => hub.fileInputRef.current?.click(),
  }
  return (
    <>
      {hub.viewMode === 'grid'
        ? <AttachmentGridView {...commonProps} zoom={hub.zoom} />
        : (
          <AttachmentListView
            {...commonProps}
            onToggleSelectAll={hub.handleToggleSelectAll}
            allSelected={hub.files.length > 0 && hub.selectedIds.size === hub.files.length}
          />
        )}
      {/* Only offered while the server says there is more: the grid already shows the count it
          loaded, and a control that can never finish would sit under a list that looks complete. */}
      {hub.nextCursor && (
        <div className='flex justify-center py-[var(--sp-3)]'>
          <Button size='sm' loading={hub.isLoadingMore} onClick={() => void hub.loadMore()}>
            {t('attachments.load_more')}
          </Button>
        </div>
      )}
    </>
  )
}

function HubDialogs({ hub }: { hub: HubBundle }) {
  return (
    <>
      {hub.qrFile && (
        <AttachmentQrModal
          open
          onClose={() => hub.setQrFile(null)}
          url={hub.qrFile.url}
          filename={hub.qrFile.filename}
        />
      )}
      {hub.renameFile && (
        <AttachmentRenameModal
          open
          onClose={() => hub.setRenameFile(null)}
          currentFilename={hub.renameFile.filename}
          onRename={hub.handleRename}
        />
      )}
      {hub.movingFileIds && (
        <FolderPicker
          open
          title={t('attachments.move_to')}
          folders={hub.organizerFolders.map(hubFolderToNoteFolder)}
          currentId={null}
          onSelect={(targetId) => void hub.handleDropFilesToFolder(hub.movingFileIds ?? [], targetId)}
          onClose={() => hub.setMovingFileIds(null)}
        />
      )}
      {hub.previewFile && (
        <FilePreviewModal
          open
          onClose={() => hub.setPreviewFile(null)}
          file={{
            url: hub.previewFile.url,
            filename: hub.previewFile.filename,
            mime: hub.previewFile.mime,
            size: hub.previewFile.size,
          }}
        />
      )}
    </>
  )
}
