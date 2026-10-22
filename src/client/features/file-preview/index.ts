import { createElement, lazy, Suspense, type ReactElement } from 'react'
import type { FilePreviewModalProps } from './types'

const LazyFilePreviewModal = lazy(() => import('./FilePreviewModal'))

export function FilePreviewModal(props: FilePreviewModalProps): ReactElement | null {
  if (!props.open) {
    return null
  }
  return createElement(Suspense, { fallback: null }, createElement(LazyFilePreviewModal, props))
}

export type { FilePreviewTarget, FilePreviewModalProps } from './types'
