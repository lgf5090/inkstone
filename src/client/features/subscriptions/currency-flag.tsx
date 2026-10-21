/**
 * The flag each currency is drawn with.
 *
 * The files are vendored in `src/client/assets/flags` from `flag-icons` 7.6.0 (MIT) and renamed to the
 * currency rather than the country; the README beside them records the source, the licence and why a
 * currency has a flag at all. They are emitted as URLs rather than inlined, so a reader billed in
 * Mexican pesos is the only one who downloads the Mexican coat of arms.
 *
 * The map is keyed by `CurrencyCode`, so adding a currency to the app fails to compile until its flag is
 * copied in — which is the right order for a list this long.
 */
import type { ReactElement, SelectHTMLAttributes } from 'react'
import { CURRENCY_CODES, type CurrencyCode } from '@shared/subscriptions/model'
import { currencySymbol } from '@shared/subscriptions/format'
import { Select } from '../../components/form'
import { cn } from '../../lib/cn'
import aud from '../../assets/flags/aud.svg?url'
import brl from '../../assets/flags/brl.svg?url'
import cad from '../../assets/flags/cad.svg?url'
import chf from '../../assets/flags/chf.svg?url'
import cny from '../../assets/flags/cny.svg?url'
import czk from '../../assets/flags/czk.svg?url'
import dkk from '../../assets/flags/dkk.svg?url'
import eur from '../../assets/flags/eur.svg?url'
import gbp from '../../assets/flags/gbp.svg?url'
import hkd from '../../assets/flags/hkd.svg?url'
import huf from '../../assets/flags/huf.svg?url'
import idr from '../../assets/flags/idr.svg?url'
import ils from '../../assets/flags/ils.svg?url'
import inr from '../../assets/flags/inr.svg?url'
import isk from '../../assets/flags/isk.svg?url'
import jpy from '../../assets/flags/jpy.svg?url'
import krw from '../../assets/flags/krw.svg?url'
import mxn from '../../assets/flags/mxn.svg?url'
import myr from '../../assets/flags/myr.svg?url'
import nok from '../../assets/flags/nok.svg?url'
import nzd from '../../assets/flags/nzd.svg?url'
import php from '../../assets/flags/php.svg?url'
import pln from '../../assets/flags/pln.svg?url'
import ron from '../../assets/flags/ron.svg?url'
import sek from '../../assets/flags/sek.svg?url'
import sgd from '../../assets/flags/sgd.svg?url'
import thb from '../../assets/flags/thb.svg?url'
import try_ from '../../assets/flags/try.svg?url'
import twd from '../../assets/flags/twd.svg?url'
import usd from '../../assets/flags/usd.svg?url'
import zar from '../../assets/flags/zar.svg?url'

export const CURRENCY_FLAGS: Record<CurrencyCode, string> = {
  CNY: cny, AUD: aud, BRL: brl, CAD: cad, CHF: chf, CZK: czk, DKK: dkk, EUR: eur, GBP: gbp,
  HKD: hkd, HUF: huf, IDR: idr, ILS: ils, INR: inr, ISK: isk, JPY: jpy, KRW: krw, MXN: mxn,
  MYR: myr, NOK: nok, NZD: nzd, PHP: php, PLN: pln, RON: ron, SEK: sek, SGD: sgd, THB: thb,
  TRY: try_, TWD: twd, USD: usd, ZAR: zar,
}

/**
 * A currency's flag, drawn beside the code that carries its meaning.
 *
 * Empty `alt` on purpose: the flag is how a reader finds their row in a list, and the code next to it is
 * what a screen reader is told. A row that announced "flag of Singapore" as well would say more and mean
 * no more.
 */
export function CurrencyFlag({ code, className }: { code: string, className?: string }): ReactElement | null {
  const url = CURRENCY_FLAGS[code as CurrencyCode]
  if (!url) return null
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      className={cn('h-2.5 w-3.5 shrink-0 rounded-[var(--r-xs)] object-cover', className)}
    />
  )
}

/**
 * The field that chooses which currency a plan is billed in.
 *
 * A native option list cannot draw a flag inside a row, and swapping the select for a custom menu would
 * trade a control every platform already announces correctly for one this app has to teach. So the flag
 * marks the choice the box already shows, and each option carries the symbol beside its code — which is
 * also what makes thirty-one of them scannable.
 *
 * It takes the props `Field` hands a control (`id`, `aria-labelledby`, `aria-describedby`) and puts them
 * on the select itself, so the label still points at the thing a reader types into.
 */
export function CurrencySelect({ value, onChange, className, ...rest }: {
  value: CurrencyCode
  onChange: (code: CurrencyCode) => void
  className?: string
} & Pick<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'aria-labelledby' | 'aria-describedby' | 'aria-required'>): ReactElement {
  return (
    <div className="relative">
      <Select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value as CurrencyCode)}
        className={cn('pl-8', className)}
      >
        {CURRENCY_CODES.map((code) => (
          <option key={code} value={code}>{code} · {currencySymbol(code).trim()}</option>
        ))}
      </Select>
      {/* Drawn after the select rather than raised above it: a positioned sibling that comes later in the
          document already paints on top, which is the whole trick and needs no z-index of its own. */}
      <CurrencyFlag code={value} className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-4 -translate-y-1/2" />
    </div>
  )
}
