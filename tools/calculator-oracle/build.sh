#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${CALC_REF:-/home/kubuntu/projects/reference/calculator}"
OUT="${1:-$HERE/build}"
mkdir -p "$OUT"
INCLUDES=(-I"$REF/src/CalcManager" -I"$REF/src/CalcManager/Header Files")
CXXFLAGS=(-std=c++20 -O2 -include cmath -w)
SOURCES=()
for file in "$REF"/src/CalcManager/Ratpack/*.cpp "$REF"/src/CalcManager/CEngine/*.cpp \
  "$REF"/src/CalcManager/CalculatorHistory.cpp "$REF"/src/CalcManager/ExpressionCommand.cpp \
  "$REF"/src/CalcManager/CalculatorManager.cpp; do
  SOURCES+=("$file")
done
g++ "${CXXFLAGS[@]}" "${INCLUDES[@]}" "$HERE/harness.cpp" "${SOURCES[@]}" -o "$OUT/calculator-oracle"
echo "$OUT/calculator-oracle"
