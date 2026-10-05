// Only `DEV` is read by the Worker, and only through optional chaining, so a bundle
// that never went through Vite's replacement simply keeps the strict policy.
interface ImportMeta {
  readonly env?: {
    readonly DEV?: boolean
  }
}
