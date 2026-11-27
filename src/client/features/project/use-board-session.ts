import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectBoardBundle, ProjectCard } from '@shared/project/model'
import { useSearch } from '../../lib/app-history'
import { createRefreshQueue } from '../../lib/refresh-queue'
import { useUi } from '../../store/ui'
import { fetchProjectBoardBundle, fetchProjectBoardCards, fetchProjectCard } from './api'

function mergeProjectCardPage(current: ProjectBoardBundle, page: ProjectBoardBundle): ProjectBoardBundle {
  const cards = new Map(current.cards.map((card) => [card.id, card]))
  for (const card of page.cards) cards.set(card.id, card)
  const contents = new Map(current.contents.map((content) => [content.id, content]))
  for (const content of page.contents) contents.set(content.id, content)
  const comments = new Map(current.comments.map((comment) => [comment.id, comment]))
  for (const comment of page.comments) comments.set(comment.id, comment)
  return {
    ...current,
    cards: [...cards.values()],
    contents: [...contents.values()],
    comments: [...comments.values()],
    people: { ...current.people, ...page.people },
    cursor: Math.max(current.cursor, page.cursor),
    cardCount: page.cardCount ?? current.cardCount,
    cardsHasMore: page.cardsHasMore,
    cardsNextCursor: page.cardsNextCursor,
    contentsTruncated: current.contentsTruncated || page.contentsTruncated,
    commentsTruncated: current.commentsTruncated || page.commentsTruncated,
  }
}

export function useBoardSession(boardId: string, setOpenCardId: (id: string | null) => void) {
  const search = useSearch()
  const [bundle, setBundle] = useState<ProjectBoardBundle | null>(null)
  const bundleRef = useRef<ProjectBoardBundle | null>(null)
  bundleRef.current = bundle
  const pendingCardRef = useRef<ProjectCard | null>(null)
  const loadedCardCursors = useRef<string[]>([])
  const cardPageQueue = useRef<Promise<void>>(Promise.resolve())
  const enqueueCardOperation = useCallback(function enqueueCardOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = cardPageQueue.current.then(operation, operation)
    cardPageQueue.current = result.then(() => undefined, () => undefined)
    return result
  }, [])
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const [cardsError, setCardsError] = useState(false)
  const [detailCardId, setDetailCardId] = useState<string | null>(null)
  const refreshBoard = useRef(boardId)
  refreshBoard.current = boardId
  const renderedBoard = useRef(boardId)
  const boardEpoch = useRef(0)
  if (renderedBoard.current !== boardId) {
    renderedBoard.current = boardId
    boardEpoch.current += 1
  }
  const deepLinkGeneration = useRef(0)
  const refresh = useMemo(
    () => createRefreshQueue(
      () => enqueueCardOperation(async () => {
        let result = await fetchProjectBoardBundle(boardId)
        for (const cursor of loadedCardCursors.current) {
          result = mergeProjectCardPage(result, await fetchProjectBoardCards(boardId, cursor))
        }
        return result
      }),
      (result) => setBundle((current) => {
        const next = current && result.cursor < current.cursor ? current : result
        const pending = pendingCardRef.current
        return pending && !next.cards.some((card) => card.id === pending.id)
          ? { ...next, cards: [...next.cards, pending], cursor: Math.max(next.cursor, pending.updateAt) }
          : next
      }),
      () => refreshBoard.current === boardId,
    ),
    [boardId, enqueueCardOperation],
  )
  useEffect(() => {
    pendingCardRef.current = null
    loadedCardCursors.current = []
    loadingMoreRef.current = false
    setLoadingMore(false)
    setCardsError(false)
    setDetailCardId(null)
  }, [boardId])
  useEffect(() => {
    const id = new URLSearchParams(search).get('card')
    const request = ++deepLinkGeneration.current
    pendingCardRef.current = null
    setDetailCardId(null)
    if (!id) return
    setOpenCardId(id)
    if (bundleRef.current?.cards.some((card) => card.id === id)) return
    const epoch = boardEpoch.current
    void fetchProjectCard(boardId, id)
      .then((card) => {
        if (request !== deepLinkGeneration.current || refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
        if (new URLSearchParams(window.location.search).get('card') !== id) return
        pendingCardRef.current = card
        setBundle((current) => current && !current.cards.some((entry) => entry.id === id)
          ? { ...current, cards: [...current.cards, card], cursor: Math.max(current.cursor, card.updateAt) }
          : current)
        setDetailCardId(id)
      })
      .catch((reason: unknown) => {
        if (request !== deepLinkGeneration.current || refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
        if (new URLSearchParams(window.location.search).get('card') !== id) return
        setOpenCardId(null)
        useUi.getState().toast({ title: reason instanceof Error ? reason.message : String(reason), tone: 'danger' })
      })
  }, [search, boardId, setOpenCardId])
  const loadMoreCards = useCallback((): Promise<void> => enqueueCardOperation(async () => {
    const cursor = bundleRef.current?.cardsNextCursor
    if (!cursor || loadingMoreRef.current) return
    const epoch = boardEpoch.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setCardsError(false)
    try {
      const page = await fetchProjectBoardCards(boardId, cursor)
      if (refreshBoard.current !== boardId || boardEpoch.current !== epoch) return
      if (!loadedCardCursors.current.includes(cursor)) loadedCardCursors.current = [...loadedCardCursors.current, cursor]
      setBundle((current) => current ? mergeProjectCardPage(current, page) : current)
    } catch {
      if (refreshBoard.current === boardId && boardEpoch.current === epoch) setCardsError(true)
    } finally {
      loadingMoreRef.current = false
      if (refreshBoard.current === boardId && boardEpoch.current === epoch) setLoadingMore(false)
    }
  }), [boardId, enqueueCardOperation])
  const forgetCard = useCallback((cardId: string) => {
    if (pendingCardRef.current?.id === cardId) pendingCardRef.current = null
    setDetailCardId((current) => current === cardId ? null : current)
  }, [])
  return {
    bundle, setBundle, bundleRef, refresh, loadMoreCards, loadingMore, cardsError,
    detailCardId, refreshBoard, boardEpoch, forgetCard,
  }
}
