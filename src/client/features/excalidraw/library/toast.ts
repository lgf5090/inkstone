import { useUi } from '../../../store/ui'

export function toast(input: {
  title: string
  description?: string
  tone?: 'default' | 'danger' | 'success'
}): void {
  useUi.getState().toast(input)
}
