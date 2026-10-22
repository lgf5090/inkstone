export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className='px-[var(--sp-2)] pb-[var(--sp-1)] text-[length:var(--text-10-5)] font-semibold tracking-wider text-[var(--text-tertiary)] uppercase'>
      {children}
    </h3>
  )
}
