export class WorkerEntrypoint<Env = unknown> {
  ctx: unknown = {}
  env: Env = {} as Env
}

export class DurableObject<Env = unknown> {
  ctx: unknown = { storage: {}, waitUntil() {} }
  state: unknown = { storage: {} }
  env: Env = {} as Env
  constructor(_ctx?: unknown, _env?: Env) {}
}

export function Maybe<T>(value?: T | null): T | undefined {
  return value ?? undefined
}

export function err(toThrow: unknown): never {
  throw toThrow
}
