import { useUi } from '../../store/ui'

/** Show an operation failure without discarding the server's explanatory message. */
export function toastFailure(title: string, error: unknown): void {
  useUi.getState().toast({
    title,
    description: error instanceof Error && error.message ? error.message : undefined,
    tone: 'danger',
  })
}
