import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { Backlink } from '@shared/types'
import { renderMarkdown } from '../../lib/markdown/renderer'
import { enhancePreview } from '../../lib/markdown/enhance'
import { api } from '../../lib/api'
import { localDb } from '../../lib/db'
import { useDebounced } from '../../lib/hooks'
import { useNotes } from '../../store/notes'

interface NoteCardContent {
  status: 'loading' | 'ready' | 'missing' | 'error'
  html: string
  isTruncated: boolean
}

interface CardMarkup {
  html: string
}

const HTML_CACHE_LIMIT = 40
const CONTENT_CACHE_LIMIT = 24
const htmlCache = new Map<string, CardMarkup>()
const contentCache = new Map<string, { rev: number, content: string }>()
const EMPTY_MARKUP: CardMarkup = { html: '' }

export function useNoteCardContent(
  target: { noteId: string | null, missing: boolean, headline?: string },
  dark: boolean,
  previewMath: boolean,
  maxLength: number,
): NoteCardContent {
  const [status, setStatus] = useState<NoteCardContent['status']>(
    target.missing || !target.noteId ? 'missing' : 'loading',
  )
  const [markup, setMarkup] = useState<CardMarkup>(EMPTY_MARKUP)
  const [isTruncated, setIsTruncated] = useState(false)
  const revisionRef = useRef(0)
  const statusRef = useRef<NoteCardContent['status']>(status)
  const noteIdRef = useRef(target.noteId)
  const headline = target.headline?.trim()
  const rev = useNotes((s) => (target.noteId ? s.notes[target.noteId]?.rev ?? 0 : 0))
  const hydrated = useNotes((s) => s.hydrated)
  const liveContent = useNotes((s) => (target.noteId ? s.contents[target.noteId] : undefined))
  const debouncedLiveContent = useDebounced(liveContent ?? '', 90)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (target.missing || !target.noteId) {
      noteIdRef.current = null
      statusRef.current = 'missing'
      setStatus('missing')
      return
    }
    const noteId = target.noteId
    if (noteIdRef.current !== noteId) {
      noteIdRef.current = target.noteId
      statusRef.current = 'loading'
    }
    const revision = ++revisionRef.current
    let isCancelled = false
    if (statusRef.current !== 'ready') {
      setStatus('loading')
      setMarkup(EMPTY_MARKUP)
      setIsTruncated(false)
    }
    void loadCardContent({
      noteId,
      revision,
      rev,
      hydrated,
      maxLength,
      previewMath,
      dark,
      headline,
      statusRef,
      isCurrent: () => !isCancelled && revision === revisionRef.current,
      setStatus,
      setMarkup,
      setIsTruncated,
    })
    return () => {
      isCancelled = true
    }
  }, [target.missing, target.noteId, dark, maxLength, previewMath, headline, rev, hydrated, debouncedLiveContent])

  return { status, html: markup.html, isTruncated }
}

export function useNoteBacklinks(noteId: string | null): { links: Backlink[] | null } {
  const rev = useNotes((s) => (noteId ? s.notes[noteId]?.rev ?? 0 : 0))
  const [links, setLinks] = useState<Backlink[] | null>(null)

  useEffect(() => {
    if (!noteId) {
      setLinks(null)
      return
    }
    const controller = new AbortController()
    let isCancelled = false
    setLinks(null)
    void (async () => {
      try {
        const response = await api.notes.backlinks(noteId, controller.signal)
        if (!isCancelled) setLinks(response.backlinks)
      } catch {
        if (!isCancelled) setLinks([])
      }
    })()
    return () => {
      isCancelled = true
      controller.abort()
    }
  }, [noteId, rev])

  return { links }
}

export async function peekNoteContent(id: string): Promise<string | null> {
  const state = useNotes.getState()
  const live = state.contents[id]
  if (live !== undefined) return live
  const rev = state.notes[id]?.rev ?? 0
  const remembered = contentCache.get(id)
  if (remembered && remembered.rev === rev) return remembered.content
  const stored = await localDb.getContent(id)
  if (stored && (stored.writeId || stored.contentDirty || stored.rev >= rev)) {
    remember(contentCache, id, { rev, content: stored.content }, CONTENT_CACHE_LIMIT)
    return stored.content
  }
  const note = await api.notes.get(id)
  const content = note.content ?? ''
  remember(contentCache, id, { rev: note.rev, content }, CONTENT_CACHE_LIMIT)
  return content
}

interface LoadCardArgs {
  noteId: string
  revision: number
  rev: number
  hydrated: boolean
  maxLength: number
  previewMath: boolean
  dark: boolean
  headline: string | undefined
  statusRef: MutableRefObject<NoteCardContent['status']>
  isCurrent: () => boolean
  setStatus: (status: NoteCardContent['status']) => void
  setMarkup: (markup: CardMarkup) => void
  setIsTruncated: (value: boolean) => void
}

async function loadCardContent(args: LoadCardArgs): Promise<void> {
  try {
    const content = await peekNoteContent(args.noteId)
    if (!args.isCurrent()) return
    if (content == null) {
      if (args.hydrated || args.rev > 0) {
        args.statusRef.current = 'error'
        args.setStatus('error')
      }
      return
    }
    const { markup: nextMarkup, isTruncated } = await renderCardHtml(content, args)
    if (!args.isCurrent()) return
    const html = args.headline
      ? applyHighlightToHtml(nextMarkup.html, buildHighlightTerms(args.headline))
      : nextMarkup.html
    args.setMarkup({ html })
    args.setIsTruncated(isTruncated)
    args.statusRef.current = 'ready'
    args.setStatus('ready')
  } catch {
    if (args.isCurrent()) {
      args.statusRef.current = 'error'
      args.setStatus('error')
    }
  }
}

async function renderCardHtml(content: string, args: LoadCardArgs): Promise<{ markup: CardMarkup, isTruncated: boolean }> {
  const truncatedContent = limitPreviewLength(content, args.maxLength)
  const cacheKey = [args.noteId, args.rev, hashString(truncatedContent), args.previewMath ? 1 : 0, args.dark ? 1 : 0].join(':')
  let cached = htmlCache.get(cacheKey)
  if (cached === undefined) {
    const rendered = renderMarkdown(truncatedContent, { hideFrontMatter: true })
    const staging = document.createElement('div')
    staging.innerHTML = rendered.html
    if (staging.querySelector('pre code') || staging.querySelector('[data-math]') || staging.querySelector('[data-mermaid]')) {
      await enhancePreview(staging, {
        math: args.previewMath,
        mermaid: false,
        dark: args.dark,
        codeBlockCollapseLines: 0,
      })
    }
    cached = { html: staging.innerHTML }
    remember(htmlCache, cacheKey, cached, HTML_CACHE_LIMIT)
  }
  return { markup: cached, isTruncated: truncatedContent.length < content.length }
}

export function buildHighlightTerms(headline: string): string[] {
  const normalized = headline.trim()
  if (!normalized) return []
  const words = normalized
    .split(/[\s\u3000\uFF0C\u3002\u3001\uFF1B\uFF1A\uFF01\uFF1F\uFF08\uFF09()\u300C\u300D\u300E\u300F\u300A\u300B\u3008\u3009\u3010\u3011\[\]{}'"\u2018\u2019\u201C\u201D\u00B7\u2014\u2026:;,./\\|#+_-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
  const terms = new Set<string>(words)
  terms.add(normalized)
  if (words.length > 1) terms.add(words.join(''))
  return [...terms].sort((a, b) => b.length - a.length)
}

export function applyHighlightToHtml(html: string, terms: string[]): string {
  if (!terms.length) return html
  const staging = document.createElement('div')
  staging.innerHTML = html
  highlightMatches(staging, terms)
  return staging.innerHTML
}

function highlightMatches(root: HTMLElement, terms: string[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.data) continue
    if (node.parentElement?.closest('mark, code, pre, script, style')) continue
    textNodes.push(node)
  }
  for (const node of textNodes) {
    const parent = node.parentElement
    if (!parent) continue
    const segments = splitByTerms(node.data, terms)
    if (!segments) continue
    const fragment = document.createDocumentFragment()
    for (const segment of segments) {
      if (segment.highlight) {
        const mark = document.createElement('mark')
        mark.className = 'card-hl'
        mark.textContent = segment.text
        fragment.appendChild(mark)
      } else {
        fragment.appendChild(document.createTextNode(segment.text))
      }
    }
    parent.replaceChild(fragment, node)
  }
}

function splitByTerms(text: string, terms: string[]): Array<{ text: string, highlight: boolean }> | null {
  const lower = text.toLowerCase()
  const result: Array<{ text: string, highlight: boolean }> = []
  let position = 0
  let hasChanged = false
  while (position < text.length) {
    const match = findNextTerm(lower, terms, position)
    if (!match) {
      if (position < text.length) result.push({ text: text.slice(position), highlight: false })
      break
    }
    if (match.index > position) {
      result.push({ text: text.slice(position, match.index), highlight: false })
    }
    const end = match.index + match.term.length
    if (!isInsideWord(text, match.index, match.term)) {
      result.push({ text: text.slice(match.index, end), highlight: true })
      hasChanged = true
    } else {
      result.push({ text: text.slice(match.index, end), highlight: false })
    }
    position = end
  }
  return hasChanged ? result : null
}

function findNextTerm(lower: string, terms: string[], start: number): { term: string, index: number } | null {
  let best: { term: string, index: number } | null = null
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase(), start)
    if (index < 0) continue
    if (best === null || index < best.index || (index === best.index && term.length > best.term.length))
      best = { term, index }
  }
  return best
}

function isInsideWord(text: string, index: number, term: string): boolean {
  if (!/^[A-Za-z0-9]+$/.test(term) || term.length < 3) return false
  const before = index > 0 ? text[index - 1] : ''
  const after = index + term.length < text.length ? text[index + term.length] : ''
  return /[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)
}

function limitPreviewLength(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  const cut = content.slice(0, maxLength)
  const newline = cut.lastIndexOf('\n')
  return cut.slice(0, newline >= maxLength * 0.6 ? newline : maxLength)
}

function hashString(value: string): number {
  let hash = 5381
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
  }
  return hash
}

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value as K | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}
