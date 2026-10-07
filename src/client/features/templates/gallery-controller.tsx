import { Copy, Download, FilePlus2, Upload } from 'lucide-react'
import type { MenuItem } from '../../components/overlay'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { t } from '../../lib/i18n'
import { copyTemplateLibraryJson, exportTemplateLibrary } from './gallery-export'
import { useGalleryKeyboard } from './gallery-keyboard'
import { useGalleryLocalState, useGalleryStoreState, useGalleryEffects, useGalleryCommunity } from './gallery-state'
import { useGalleryDerived } from './gallery-derived'
import {
  reorderTarget,
  useGalleryBatchActions,
  useGalleryCommunityActions,
  useGalleryDragActions,
  useGalleryFilterActions,
  useGalleryNoteBridge,
  useGallerySelectActions,
  useGalleryTemplateActions,
} from './gallery-actions'

export function useGalleryController({ onClose }: { onClose: () => void }) {
  const owner = useSession((state) => state.user?.id ?? '')
  const state = useGalleryLocalState({ onClose })
  const store = useGalleryStoreState(owner)
  useGalleryEffects(state, store)
  const community = useGalleryCommunity(state.filter)
  const derived = useGalleryDerived(store.templates, state.filter, state.query, state.selectedIds)
  const filterActions = useGalleryFilterActions(state, store.categories)
  const templateActions = useGalleryTemplateActions(state, store.categories)
  const communityActions = useGalleryCommunityActions(community.setCommunity)
  const selectActions = useGallerySelectActions(state, derived.visible)
  const batchActions = useGalleryBatchActions(state, derived.selectedTemplates, derived.allSelectedStarred)
  const dragActions = useGalleryDragActions(state, store.templates)
  const noteBridge = useGalleryNoteBridge(state, onClose)
  const moreItems: MenuItem[] = [
    { id: 'export', label: t('templates.export_library'), icon: <Download size={13}/>, onSelect: () => exportTemplateLibrary() },
    { id: 'copy-json', label: t('templates.copy_json'), icon: <Copy size={13}/>, onSelect: () => void copyTemplateLibraryJson() },
    { id: 'import', label: t('templates.import_templates'), icon: <Upload size={13}/>, separatorBefore: true, onSelect: () => state.setIsImportOpen(true) },
    {
      id: 'save-note',
      label: t('templates.save_note_as_template'),
      icon: <FilePlus2 size={13}/>,
      separatorBefore: true,
      disabled: !noteBridge.hasActiveNote,
      onSelect: noteBridge.saveActiveNoteAsTemplate,
    },
  ]
  const handleKeyDown = useGalleryKeyboard({
    editing: state.editing,
    renaming: state.renaming,
    moving: state.moving,
    categoryDialog: state.categoryDialog,
    isImportOpen: state.isImportOpen,
    isBatchMoving: state.isBatchMoving,
    publishing: state.publishing,
    isHelpOpen: state.isHelpOpen,
    isMoreOpen: state.isMoreOpen,
    setIsHelpOpen: state.setIsHelpOpen,
    toggleSelectMode: selectActions.toggleSelectMode,
    searchRef: state.searchRef,
    query: state.query,
    setQuery: state.setQuery,
    selectMode: state.selectMode,
    setSelectMode: state.setSelectMode,
    visible: derived.visible,
    setSelectedIds: state.setSelectedIds,
    toggleSelectAll: selectActions.toggleSelectAll,
    focusedId: state.focusedId,
    gridRef: state.gridRef,
    toggleSelect: selectActions.toggleSelect,
    setFocusedId: state.setFocusedId,
    reorder: (direction) => {
      const target = reorderTarget(store.templates, store.categories, state.focusedId, direction)
      if (!target) return
      useNoteTemplates.getState().placeTemplate(target.id, target.categoryId, target.index)
      const moved = useNoteTemplates.getState().templates.find((item) => item.id === target.id)
      if (moved) state.setFocusedId(moved.id)
    },
  })
  return {
    state,
    store,
    community,
    derived,
    filterActions,
    templateActions,
    communityActions,
    selectActions,
    batchActions,
    dragActions,
    noteBridge,
    moreItems,
    handleKeyDown,
  }
}

export type GalleryController = ReturnType<typeof useGalleryController>
