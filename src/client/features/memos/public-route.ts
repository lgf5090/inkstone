import { parseMemoPath, type MemoRoute } from './route'

export type MemoPublicRoute = Extract<MemoRoute, { kind: 'share' | 'profile' | 'profileMemo' }>

export type MemoPublicView = MemoPublicRoute | { kind: 'explore' }

export type MemoSurface =
  | { kind: 'public'; route: MemoPublicRoute }
  | { kind: 'explore' }
  | { kind: 'app' }

export function classifyMemoSurface(pathname: string): MemoSurface {
  const route = parseMemoPath(pathname)
  switch (route.kind) {
    case 'share':
    case 'profile':
    case 'profileMemo':
      return { kind: 'public', route }
    case 'explore':
      return { kind: 'explore' }
    default:
      return { kind: 'app' }
  }
}
