/**
 * Managing the shared taxonomy from the chat's sidebar.
 *
 * A conversation's folders and tags are the notebook's own rows, so creating, renaming, recolouring and
 * deleting one here is the same act as doing it in the notes rail — and it goes through the same writes:
 * the store's folder mutations and the tags feature's own entry points carry the optimistic update, the
 * sync and the rollback, and this file only decides which rows a menu offers.
 *
 * The folder menu is the notebook rail's set minus everything that is about a *note* — creating a note
 * in this folder, exporting it, making it the inbox. That is the honest reading of where the reader is:
 * a panel for filing chats is not a place to file a note, and offering it would be furniture from
 * another screen.
 */

import { CornerDownRight, FolderPlus, Palette, Pencil, Smile, Trash2 } from 'lucide-react'
import type { ChatFolderNode, ConversationTag } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { Menu, confirm, prompt, useContextMenu, type MenuItem } from '../../components/overlay'
import { TagChip } from '../../components/TagChip'
import { FolderColorMenu, FolderIconMenu } from '../folders/FolderAppearanceMenus'
import { useTagMenuItems } from '../tags/useTagMenuItems'
import { useNotes } from '../../store/notes'
import { useAssistant } from './assistant-store'

/**
 * The tag rows that mean something in a chat panel.
 *
 * `useTagMenuItems` answers four entrances in the notebook, and several of its rows act on a note or on
 * the notebook's search. A chip here filters conversations, so what it can usefully offer is the rows
 * that change the tag itself.
 */
const TAG_ROWS = new Set(['rename', 'child', 'color', 'delete'])

/** The name a reader types for a folder or a tag, or null when they change their mind. */
async function askForName(title: string, value?: string): Promise<string | null> {
  const answer = await prompt({ title, defaultValue: value })
  const name = answer?.trim()
  return name ? name : null
}

/**
 * The folder rows, and the state that opens them.
 *
 * A hook because every row owns its own menu anchor: one point for the whole tree is the shape that
 * makes two rows share a menu, and the second row's press would open the first row's.
 *
 * `bootstrap(true)` after a write re-reads the assistant's own folder and tag counts and its
 * conversation list, which are computed over the shared tables and are now one write out of date.
 */
export function useChatFolderMenu(node: ChatFolderNode) {
  const menu = useContextMenu()
  const items: MenuItem[] = [
    {
      id: 'new-child',
      label: t('sidebar.new_subfolder'),
      icon: <FolderPlus size={13} />,
      onSelect: () => void addChild(),
    },
    { id: 'rename', label: t('sidebar.rename'), icon: <Pencil size={13} />, onSelect: () => void rename() },
    {
      id: 'color',
      label: t('folders.color'),
      icon: <Palette size={13} />,
      separatorBefore: true,
      submenu: ({ closeMenu }) => (
        <FolderColorMenu
          color={node.color}
          onSelectColor={(color) => {
            useNotes.getState().patchFolder(node.id, { color })
            refresh()
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'icon',
      label: t('folders.icon'),
      icon: <Smile size={13} />,
      submenu: ({ closeMenu }) => (
        <FolderIconMenu
          icon={node.icon}
          onSelectIcon={(icon) => {
            useNotes.getState().patchFolder(node.id, { icon })
            refresh()
            closeMenu()
          }}
        />
      ),
    },
    {
      id: 'delete',
      label: t('sidebar.delete_folder'),
      icon: <Trash2 size={13} />,
      tone: 'danger',
      separatorBefore: true,
      onSelect: () => void remove(),
    },
  ]

  async function addChild() {
    const name = await askForName(t('folders.new_subfolder_hint', { value0: node.name }))
    if (!name) return
    useNotes.getState().createFolder({ name, parentId: node.id })
    refresh()
  }

  async function rename() {
    const name = await askForName(t('sidebar.rename'), node.name)
    if (!name || name === node.name) return
    useNotes.getState().patchFolder(node.id, { name })
    refresh()
  }

  async function remove() {
    const children = useAssistant.getState().folderNodes.filter((entry) => entry.parentId === node.id).length
    const agreed = await confirm({
      title: t('sidebar.delete_folder_value0', { value0: node.name }),
      description: t('folders.delete_empty_or_shared', { value0: node.count, value1: children }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!agreed) return
    useNotes.getState().deleteFolder(node.id)
    refresh()
  }

  return { menu, items }
}

function refresh(): void {
  // The light read rather than `bootstrap`: a folder write changes nothing about the model, the
  // providers or the skills, and re-reading all of them per menu press would be a lot of requests for
  // one number.
  void useAssistant.getState().loadTaxonomy()
}

/** The menu a folder row opens, anchored where it was asked for. */
export function ChatFolderMenu({ state }: { state: ReturnType<typeof useChatFolderMenu> }) {
  if (!state.menu.point) return null
  return <Menu anchor={state.menu.point} open onClose={state.menu.close} items={state.items} label={t('assistant.chat.folder_filter')} />
}

/**
 * A tag chip with the notebook's own tag menu behind a right-click.
 *
 * The tag is looked up from the notes store rather than from the chat's node, because the tag mutations
 * take a `Tag` and the chat's node carries only what the conversation list needs.
 */
export function ConversationTagChip({ tag, pressed, onPress }: {
  tag: ConversationTag & { count: number }
  pressed: boolean
  onPress: () => void
}) {
  const contextMenu = useContextMenu()
  const items = useTagMenuItems(tag.name, {
    onStartRename: () => void rename(),
    onCreateChild: () => void addChild(),
  }).filter((item) => TAG_ROWS.has(item.id))

  const stored = () => useNotes.getState().tags.find((entry) => entry.id === tag.id)

  async function rename() {
    const name = await askForName(t('tags.rename'), tag.name)
    if (!name || name === tag.name) return
    const current = stored()
    if (!current) return
    // Loaded on the press rather than with the panel: the tags module's own graph reaches the note
    // store and the drawing editors, and none of that is something a filter chip needs to draw.
    const { renameTag } = await import('../tags/tagMutations')
    await renameTag(current, name)
    refresh()
  }

  async function addChild() {
    const name = await askForName(t('tags.new_child'), `${tag.name}/`)
    if (!name) return
    const { createTag } = await import('../tags/tagMutations')
    createTag(name)
    refresh()
  }

  return (
    <>
      <TagChip
        label={tag.name}
        pressed={pressed}
        color={tag.color}
        count={tag.count}
        onPress={onPress}
        onContextMenu={contextMenu.onContextMenu}
      />
      {contextMenu.point && (
        <Menu
          anchor={contextMenu.point}
          open
          onClose={contextMenu.close}
          items={items}
          label={t('assistant.chat.tag_filter')}
        />
      )}
    </>
  )
}

/** The row above the tree that creates a folder at the root, since a tree with no rows has nothing to press. */
export function NewRootFolderRow() {
  return (
    <button
      type="button"
      onClick={() => {
        void (async () => {
          const name = await askForName(t('folders.new_folder_hint'))
          if (!name) return
          useNotes.getState().createFolder({ name, parentId: null })
          refresh()
        })()
      }}
      className="mt-0.5 flex w-full items-center gap-1.5 rounded-[var(--r-md)] px-2 py-1 text-left text-[length:var(--text-12)] text-[var(--text-quaternary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]"
    >
      <CornerDownRight size={13} />
      {t('common.new_folder')}
    </button>
  )
}
