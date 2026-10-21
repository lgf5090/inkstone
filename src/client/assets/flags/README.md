# Currency flags

The SVG files in this directory are the national flags from
[`flag-icons`](https://www.npmjs.com/package/flag-icons) 7.6.0 (Panayiotis Lipiridis, MIT licence),
copied out of its `flags/4x3` set. They are vendored here so the app can ship the thirty-one it needs
without adding an icon package for five hundred, and each file is renamed to the **currency** it
identifies rather than the country: `usd.svg`, `twd.svg`, `eur.svg`.

The flag is the one flown by the economy that issues the currency, which is the only reason a currency
picker can draw anything at all: `eur.svg` is the European flag because the euro is issued by the Eurosystem,
and `hkd.svg` is the Hong Kong regional flag because that is whose monetary authority issues the Hong Kong
dollar. These files are used to identify a currency and nothing else — they carry no statement about
sovereignty, borders or status, and no such statement should be read into them or implied by adding or
removing one.

A few are detailed state emblems rather than stripes (MXN, BRL, NZD, TWD), so the largest is around
85 KB. Each is fetched only when a screen actually draws that currency, which is why they are loaded as
image URLs rather than inlined.

Upstream files are unmodified: same paths, same internal ids, same `viewBox`. Nothing here references an
external document — every `href` inside a file points at a `<defs>` entry in the same file, which is safe
because each one is drawn through an `<img>`, in its own document.
