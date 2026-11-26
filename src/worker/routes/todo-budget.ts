import { createMinuteBudget } from '../lib/rate-limit'

export const WRITE_BUDGET_PER_MINUTE = 60
export const READ_BUDGET_PER_MINUTE = 120

const writeBudget = createMinuteBudget(WRITE_BUDGET_PER_MINUTE, 'Too many changes at once. Try again in a minute.')
const readBudget = createMinuteBudget(READ_BUDGET_PER_MINUTE, 'Too many reads at once. Try again in a minute.')

export function spendTodoWriteBudget(userId: string): void {
  writeBudget(userId)
}

export function spendTodoReadBudget(userId: string): void {
  readBudget(userId)
}
