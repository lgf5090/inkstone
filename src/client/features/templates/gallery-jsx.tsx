import { FolderPlus, Globe, Hash, LayoutTemplate, Pin, Plus, Star, Trash2 } from 'lucide-react'
import { useNoteTemplates } from '../../store/note-templates'
import { Button } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { t } from '../../lib/i18n'
import { CategoryRow, FilterChip, SidebarButton } from './gallery-controls'
import { TemplateCard } from './template-card'
import {
  BatchMoveDialog,
  CategoryDialog,
  ImportTemplatesModal,
  MoveTemplateDialog,
  TemplateEditorModal,
  TemplateRenameDialog,
} from './gallery-modals'
import { CommunityPanel } from './community-panel'
import { KeyboardHelpModal, PublishTemplateDialog } from './misc-modals'
import type { GalleryController } from './gallery-controller'

export function GalleryMobileChips({ g }: { g: GalleryController }) {
  const { state, store, derived, filterActions, dragActions } = g
  const { filter, setFilter, draggingId, dropCategory } = state
  return (
    <div className='flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--border-subtle)] px-[var(--sp-3)] py-[var(--sp-2)] md:hidden'>
      <FilterChip label={t('templates.all_templates')} count={store.templates.length} active={filter.kind === 'all'} onClick={() => setFilter({ kind: 'all' })}/>
      <FilterChip label={t('templates.favorites')} count={derived.counts.starred} active={filter.kind === 'favorites'} onClick={() => setFilter({ kind: 'favorites' })}/>
      <FilterChip label={t('templates.community')} count={g.community.community.length} active={filter.kind === 'community'} onClick={() => setFilter({ kind: 'community' })}/>
      {derived.counts.uncategorized > 0 && <FilterChip label={t('templates.uncategorized')} count={derived.counts.uncategorized} active={filter.kind === 'uncategorized'} onClick={() => setFilter({ kind: 'uncategorized' })}/>}
      {store.categories.map((category) => (<FilterChip key={category.id} label={category.name} count={derived.counts.byCategory.get(category.id) ?? 0} active={filter.kind === 'category' && filter.id === category.id} onClick={() => setFilter({ kind: 'category', id: category.id })} dropTarget={draggingId !== null && dropCategory === category.id} onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        state.setDropCategory(category.id)
      }} onDragLeave={() => state.setDropCategory((current) => current === category.id ? null : current)} onDrop={(event) => {
        event.preventDefault()
        dragActions.handleCategoryDrop(category.id)
      }}/>))}
      {derived.tagList.map(([tag, count]) => (<FilterChip key={`tag-${tag}`} label={`#${tag}`} count={count} active={filter.kind === 'tag' && filter.tag === tag} onClick={() => filterActions.toggleTagFilter(tag)}/>))}
      <FilterChip label={t('templates.new_category')} count={null} active={false} onClick={() => state.setCategoryDialog({ mode: 'create' })}/>
    </div>
  )
}

export function GallerySidebar({ g }: { g: GalleryController }) {
  const { state, store, derived, filterActions, dragActions } = g
  const { filter, setFilter, draggingId, dropCategory } = state
  return (
    <aside aria-label={t('templates.categories')} className='hidden w-54.5 shrink-0 flex-col overflow-y-auto border-r border-[var(--border-subtle)] p-[var(--sp-2)] md:flex'>
      <SidebarButton icon={<LayoutTemplate size={14}/>} label={t('templates.all_templates')} count={store.templates.length} active={filter.kind === 'all'} onClick={() => setFilter({ kind: 'all' })}/>
      <SidebarButton icon={<Star size={14}/>} label={t('templates.favorites')} count={derived.counts.starred} active={filter.kind === 'favorites'} onClick={() => setFilter({ kind: 'favorites' })}/>
      <SidebarButton icon={<Globe size={14}/>} label={t('templates.community')} count={g.community.community.length} active={filter.kind === 'community'} onClick={() => setFilter({ kind: 'community' })}/>
      {derived.counts.uncategorized > 0 && <SidebarButton icon={<FolderPlus size={14}/>} label={t('templates.uncategorized')} count={derived.counts.uncategorized} active={filter.kind === 'uncategorized'} onClick={() => setFilter({ kind: 'uncategorized' })}/>}
      <div className='mt-[var(--sp-3)] mb-[var(--sp-1)] flex items-center justify-between px-[var(--sp-2)]'>
        <span className='text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'>{t('templates.categories')}</span>
        <Tooltip label={t('templates.new_category')} side='right'>
          <button type='button' aria-label={t('templates.new_category')} onClick={() => state.setCategoryDialog({ mode: 'create' })} className='flex size-6 items-center justify-center rounded-md text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'>
            <Plus size={13}/>
          </button>
        </Tooltip>
      </div>
      <div className='space-y-0.5'>
        {store.categories.map((category) => (<CategoryRow key={category.id} category={category} count={derived.counts.byCategory.get(category.id) ?? 0} active={filter.kind === 'category' && filter.id === category.id} dropTarget={draggingId !== null && dropCategory === category.id} onSelect={() => setFilter({ kind: 'category', id: category.id })} onRename={() => state.setCategoryDialog({ mode: 'rename', category })} onDelete={() => void filterActions.deleteCategory(category)} onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          state.setDropCategory(category.id)
        }} onDragLeave={() => state.setDropCategory((current) => current === category.id ? null : current)} onDrop={(event) => {
          event.preventDefault()
          dragActions.handleCategoryDrop(category.id)
        }}/>))}
      </div>
      {derived.tagList.length > 0 && (<>
        <div className='mt-[var(--sp-3)] mb-[var(--sp-1)] px-[var(--sp-2)] text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'>{t('templates.tags')}</div>
        <div className='space-y-0.5'>
          {derived.tagList.map(([tag, count]) => (<SidebarButton key={tag} icon={<Hash size={14}/>} label={tag} count={count} active={filter.kind === 'tag' && filter.tag === tag} onClick={() => filterActions.toggleTagFilter(tag)}/>))}
        </div>
      </>)}
      <button type='button' onClick={() => state.setCategoryDialog({ mode: 'create' })} className='mt-[var(--sp-2)] flex h-8 w-full items-center gap-1.5 rounded-[var(--r-md)] px-[var(--sp-2)] text-[12px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]'>
        <Plus size={13}/>{t('templates.new_category')}
      </button>
    </aside>
  )
}

export function GalleryMain({ g }: { g: GalleryController }) {
  const { state, store, derived, templateActions, filterActions, communityActions, dragActions, selectActions, community } = g
  const { filter, selectedIds, focusedId, draggingId, dropHint, selectMode } = state
  return (
    <main className='min-h-0 flex-1 overflow-y-auto p-[var(--sp-3)] md:p-4'>
      {filter.kind === 'community' && <CommunityPanel items={community.community} loading={community.isCommunityLoading} isError={community.isCommunityError} myId={state.currentUserId} onRefresh={() => void community.refreshCommunity()} onUse={templateActions.useCommunityTemplate} onImport={templateActions.importCommunityTemplate} onUnpublish={(item) => void communityActions.unpublishCommunityTemplate(item)}/>}
      {filter.kind !== 'community' && derived.visible.some((item) => item.isPinned) && (<div className='mb-[var(--sp-3)] flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'>
        <Pin size={11}/>{t('notes.pin')}
      </div>)}
      {filter.kind !== 'community' && derived.visible.length === 0 ? (<div className='flex h-full min-h-[240px] flex-col items-center justify-center gap-[var(--sp-2)] text-center'>
        <LayoutTemplate size={26} className='text-[var(--text-quaternary)]'/>
        <p className='text-[13px] font-medium text-[var(--text-secondary)]'>
          {state.query.trim() ? t('templates.no_matching_templates') : t('templates.no_templates')}
        </p>
        <p className='text-[11.5px] text-[var(--text-quaternary)]'>{t('templates.no_templates_hint')}</p>
      </div>) : filter.kind !== 'community' && (<div ref={state.gridRef} className='grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3'>
        {derived.visible.map((template) => (<TemplateCard key={template.id} template={template} categoryName={filterActions.categoryName(template.categoryId)} selectMode={selectMode} selected={selectedIds.has(template.id)} focused={focusedId === template.id} dragging={draggingId === template.id} dropHint={dropHint?.id === template.id ? dropHint.after : null} onToggleSelect={() => selectActions.toggleSelect(template.id)} onDragStart={(id) => state.setDraggingId(id)} onDragOver={(id, after) => state.setDropHint({ id, after })} onDrop={(card, after) => dragActions.handleCardDrop(card, after)} onDragEnd={() => {
            state.setDraggingId(null)
            state.setDropHint(null)
          }} onUse={() => templateActions.useTemplate(template)} onEdit={() => state.setEditing(template)} onRename={() => state.setRenaming(template)} onDuplicate={() => useNoteTemplates.getState().duplicateTemplate(template.id)} onMove={() => state.setMoving(template)} onDelete={() => void templateActions.deleteTemplate(template)} onPublish={() => state.setPublishing(template)} onTogglePin={() => store.togglePin(template.id)} onToggleStar={() => store.toggleStar(template.id)}/>))}
      </div>)}
    </main>
  )
}

export function GallerySelectBar({ g }: { g: GalleryController }) {
  const { state, derived, selectActions, batchActions } = g
  return (
    <div className='flex shrink-0 flex-wrap items-center gap-[var(--sp-2)] border-t border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-[var(--sp-4)] py-2.5'>
      <span className='text-[12.5px] font-semibold text-[var(--text-secondary)]'>{t('templates.selected_count_value0', { value0: state.selectedIds.size })}</span>
      <div className='ml-auto flex flex-wrap items-center gap-1.5'>
        <Button size='sm' variant='ghost' onClick={selectActions.toggleSelectAll}>{derived.allVisibleSelected ? t('templates.clear_selection') : t('templates.select_all')}</Button>
        <Button size='sm' variant='secondary' icon={<Star size={13}/>} disabled={state.selectedIds.size === 0} onClick={batchActions.batchToggleStar}>{derived.allSelectedStarred ? t('common.remove_from_favorites') : t('navigation.favorites')}</Button>
        <Button size='sm' variant='secondary' icon={<FolderPlus size={13}/>} disabled={state.selectedIds.size === 0} onClick={() => state.setIsBatchMoving(true)}>{t('templates.move_to_category')}</Button>
        <Button size='sm' variant='danger' icon={<Trash2 size={13}/>} disabled={!derived.hasDeletableSelection} onClick={() => void batchActions.batchDelete()}>{t('templates.delete_template')}</Button>
        <Button size='sm' variant='ghost' onClick={selectActions.exitSelectMode}>{t('templates.exit_select_mode')}</Button>
      </div>
    </div>
  )
}

export function GalleryModals({ g }: { g: GalleryController }) {
  const { state, store, filterActions, batchActions, community } = g
  return (<>
    {state.editing && <TemplateEditorModal template={state.editing === 'new' ? null : state.editing} categories={store.categories} onClose={() => state.setEditing(null)}/>}
    {state.renaming && <TemplateRenameDialog template={state.renaming} onClose={() => state.setRenaming(null)}/>}
    {state.moving && <MoveTemplateDialog template={state.moving} categories={store.categories} onClose={() => state.setMoving(null)}/>}
    {state.categoryDialog && <CategoryDialog dialog={state.categoryDialog} onClose={() => state.setCategoryDialog(null)}/>}
    {state.isImportOpen && <ImportTemplatesModal onClose={() => state.setIsImportOpen(false)}/>}
    {state.isBatchMoving && <BatchMoveDialog categories={store.categories} onMove={batchActions.batchMove} onClose={() => state.setIsBatchMoving(false)}/>}
    {state.isHelpOpen && <KeyboardHelpModal onClose={() => state.setIsHelpOpen(false)}/>}
    {state.publishing && <PublishTemplateDialog template={state.publishing} category={state.publishing.categoryId === null ? t('templates.uncategorized') : filterActions.categoryName(state.publishing.categoryId)} onClose={() => state.setPublishing(null)} onPublished={() => {
      state.setPublishing(null)
      if (state.filter.kind === 'community') void community.refreshCommunity()
    }}/>}
  </>)
}
