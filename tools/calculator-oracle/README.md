# Calculator golden oracle

Builds the reference Windows Calculator C++ engine (`microsoft/calculator`, MIT, commit `79e1ac5`)
into a command-sequence oracle and generates the fixtures used by `tests/calculator-golden.test.ts`.

The oracle is a development tool: it is not imported by the app, is not part of the production
bundle, and `build/` is gitignored.

## Build

```bash
CALC_REF=/home/kubuntu/projects/reference/calculator ./tools/calculator-oracle/build.sh
```

The build script compiles `Ratpack`, `CEngine`, `CalculatorHistory`, `ExpressionCommand` and
`CalculatorManager` with `g++ -std=c++20 -include cmath`. No Windows headers are needed for these
translation units.

## Generate fixtures

```bash
node tools/calculator-oracle/generate.mjs
```

This writes `tests/fixtures/calculator/golden.json` (273 command sequences: curated standard,
scientific and programmer cases plus seeded random chains). The companion test compares:

- primary display (exact for integers, numeric tolerance `1e-12` for floating point),
- error state,
- history entry count and each history result.

History expression text and token spacing are intentionally not byte-compared: the reference
serialises localized operator names and spacing that the UI renderer owns.

## Scope

The corpus covers the behaviour implemented in `src/shared/tools/calculator/engine`. Extreme
exponent ranges and byte-for-byte last-digit rounding are outside the assertion contract and are
tracked in the migration plan (§15.3).
