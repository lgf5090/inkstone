import { describe, expect, it } from 'vitest'
import { pageSteps, planSlidePages, resolvePageIndex, samePlan, slideLayoutForFit, type SlideBlock, type SlidePlan } from './slide-pagination'

function stack(entries: [number, boolean?][]): SlideBlock[] {
  let top = 0
  return entries.map(([height, heading]) => {
    const block = { top, height, heading: heading === true }
    top += height
    return block
  })
}

// A 200-row table measured on a real show (`scripts/measure-slide-fit.mjs`, 1920×1080): 11 672 design
// px of block on a 632 px page, its rows 58 px apart, so ten of them make a band. Shrunk to fit
// instead, its body arrives at 1.8 px on the projector. These fixtures keep the units at a round
// 100 px so an assertion can name the band edges; the packing rule is the same one the show ran.
function rows(count: number, height = 100): SlideBlock {
  return { top: 0, height: count * height, heading: false, breaks: Array.from({ length: count - 1 }, (_, index) => (index + 1) * height) }
}

describe('planSlidePages — packing', () => {
  it('keeps a slide on one page while every block fits', () => {
    const plan = planSlidePages(stack([[100], [200], [300]]), 640)
    expect(plan.pages).toEqual([{ from: 0, to: 3, top: 0 }])
    expect(plan.scales).toEqual([1, 1, 1])
  })

  it('moves the overflowing block onto the next page', () => {
    const plan = planSlidePages(stack([[300], [300], [300]]), 640)
    expect(plan.pages).toEqual([
      { from: 0, to: 2, top: 0 },
      { from: 2, to: 3, top: 600 },
    ])
  })

  it('produces one page for an empty slide instead of zero pages', () => {
    expect(planSlidePages([], 640).pages).toEqual([{ from: 0, to: 0, top: 0 }])
  })
})

describe('planSlidePages — subsection alignment', () => {
  it('breaks before the following subsection heading so subsections stay whole', () => {
    // 12.3 + its chart, then 12.4 + its chart: the second chart cannot fit.
    const plan = planSlidePages(stack([[40, true], [400], [40, true], [400]]), 640)
    expect(plan.pages).toEqual([
      { from: 0, to: 2, top: 0 },
      { from: 2, to: 4, top: 440 },
    ])
  })

  it('never leaves a heading alone at the bottom of a page', () => {
    const plan = planSlidePages(stack([[40, true], [560], [40, true], [200]]), 640)
    expect(plan.pages).toEqual([
      { from: 0, to: 2, top: 0 },
      { from: 2, to: 4, top: 600 },
    ])
  })

  it('fills the page as far as it can when no heading follows on that page', () => {
    const plan = planSlidePages(stack([[40, true], [500], [500]]), 640)
    expect(plan.pages).toEqual([
      { from: 0, to: 2, top: 0 },
      { from: 2, to: 3, top: 540 },
    ])
  })
})

describe('planSlidePages — oversized blocks', () => {
  it('shrinks a block that alone exceeds the page instead of clipping or scrolling it', () => {
    const plan = planSlidePages(stack([[1280], [100]]), 640)
    expect(plan.scales[0]).toBeCloseTo(0.5)
    expect(plan.scales[1]).toBe(1)
    expect(plan.pages).toEqual([
      { from: 0, to: 1, top: 0 },
      { from: 1, to: 2, top: 1280 },
    ])
  })

  it('treats a non-positive page height as one pixel rather than dividing by zero', () => {
    const plan = planSlidePages(stack([[10]]), 0)
    expect(plan.scales[0]).toBe(0.1)
    expect(plan.pages).toEqual([{ from: 0, to: 1, top: 0 }])
  })
})

describe('planSlidePages — a block that continues over pages', () => {
  it('continues a three-page table on its rows at full size instead of shrinking it', () => {
    const plan = planSlidePages([rows(18)], 640)
    expect(plan.pages).toEqual([
      { from: 0, to: 1, top: 0, clip: { top: 0, bottom: 1200 } },
      { from: 0, to: 1, top: 600, clip: { top: 600, bottom: 600 } },
      { from: 0, to: 1, top: 1200, clip: { top: 1200, bottom: 0 } },
    ])
    expect(plan.scales).toEqual([1])
  })

  it('fills each page of a continued block to the last unit that fits', () => {
    const block = rows(18)
    planSlidePages([block], 640).pages.forEach((page) => {
      // What the page paints is the block with its two insets cut away, and a page that could have
      // taken one more unit is a page that left a row's height of the canvas empty.
      const band = block.height - page.clip!.top - page.clip!.bottom
      expect(band).toBeLessThanOrEqual(640)
      expect(band).toBeGreaterThan(640 - 100)
    })
  })

  it('takes every unit when they fill the page exactly', () => {
    // Six rows of 100 px on a 600 px page leaves no leftover at all, and a band that stops one unit
    // short would spend a third page on the rows it left out.
    expect(planSlidePages([rows(12)], 600).pages).toEqual([
      { from: 0, to: 1, top: 0, clip: { top: 0, bottom: 600 } },
      { from: 0, to: 1, top: 600, clip: { top: 600, bottom: 0 } },
    ])
  })

  it('continues the block that overflows among the blocks before it', () => {
    const blocks: SlideBlock[] = [{ top: 0, height: 300, heading: true }, rows(18)]
    blocks[1] = { ...blocks[1]!, top: 300 }
    const plan = planSlidePages(blocks, 640)
    expect(plan.pages).toEqual([
      { from: 0, to: 1, top: 0 },
      { from: 1, to: 2, top: 300, clip: { top: 0, bottom: 1200 } },
      { from: 1, to: 2, top: 900, clip: { top: 600, bottom: 600 } },
      { from: 1, to: 2, top: 1500, clip: { top: 1200, bottom: 0 } },
    ])
  })

  it('counts a clip as a new plan when the page it sits on did not move', () => {
    const continued: SlidePlan = { pages: [{ from: 0, to: 1, top: 0, clip: { top: 0, bottom: 40 } }], scales: [1] }
    expect(samePlan(continued, { pages: [{ from: 0, to: 1, top: 0 }], scales: [1] })).toBe(false)
    expect(samePlan(continued, { pages: [{ from: 0, to: 1, top: 0, clip: { top: 0, bottom: 40 } }], scales: [1] })).toBe(true)
  })
})

describe('planSlidePages — a block that cannot be cut', () => {
  it('keeps shrinking when a block sits inside the one that overflows', () => {
    // A negative margin can drop the next block back into the tall one's box, and a horizontal cut
    // would then pass through both at once. Only a block the page holds alone can be continued.
    const plan = planSlidePages([rows(20), { top: 300, height: 200, heading: false }], 640)
    expect(plan.pages).toEqual([{ from: 0, to: 2, top: 0 }])
    expect(plan.scales[0]).toBeCloseTo(0.32)
  })

  it('keeps shrinking a block that only just exceeds the page', () => {
    // 900 px on a 640 px page is a 0.71 factor: the body is still above the readable floor, and
    // splitting it in two would leave two half-empty pages for a slide that reads as one table.
    const plan = planSlidePages([{ top: 0, height: 900, heading: false, breaks: [100, 200, 300, 400, 500, 600, 700, 800] }], 640)
    expect(plan.pages).toEqual([{ from: 0, to: 1, top: 0 }])
    expect(plan.scales[0]).toBeCloseTo(640 / 900, 6)
  })

  it('keeps shrinking when a single unit is itself taller than the page', () => {
    // One row of 1 200 px cannot be placed on any page, so continuing would clip it away. The shrink
    // is the same answer the slide gave before, and losing part of a row is not an option.
    const plan = planSlidePages([{ top: 0, height: 2000, heading: false, breaks: [1200] }], 640)
    expect(plan.pages).toEqual([{ from: 0, to: 1, top: 0 }])
    expect(plan.scales[0]).toBeCloseTo(0.32)
  })

  it('keeps shrinking a block that offers no break point at all', () => {
    const plan = planSlidePages([{ top: 0, height: 8000, heading: false }], 632)
    expect(plan.pages).toEqual([{ from: 0, to: 1, top: 0 }])
    expect(plan.scales[0]).toBeCloseTo(0.079)
  })
})

describe('planSlidePages — a column slide', () => {
  it('keeps a column slide whole on one page rather than paging through its columns', () => {
    // The same stack the flow walk splits over two pages. Two columns already put half of it
    // beside the other half, and the tops of a column layout restart with each column, so a page
    // picked out of them would hide blocks that sit side by side on the screen.
    const plan = planSlidePages(stack([[300], [300], [300]]), 640, 'split')
    expect(plan.pages).toEqual([{ from: 0, to: 3, top: 0 }])
    expect(plan.scales).toEqual([1, 1, 1])
  })

  it('reports the layout it packed with, so every surface draws the geometry it measured', () => {
    expect(planSlidePages(stack([[100]]), 640, 'split').layout).toBe('split')
    expect(planSlidePages(stack([[100]]), 640, 'cover').layout).toBe('cover')
    expect(planSlidePages([], 640, 'cover').layout).toBe('cover')
    expect(planSlidePages(stack([[100]]), 640).layout).toBeUndefined()
  })

  it('keeps the columns of a slide whose balanced height fits the page', () => {
    expect(slideLayoutForFit('split', 600, 640)).toBe('split')
  })

  it('refuses the columns of a slide that still overflows the page', () => {
    expect(slideLayoutForFit('split', 641, 640)).toBeUndefined()
  })

  it('leaves a slide that asked for no columns alone however tall it is', () => {
    expect(slideLayoutForFit('cover', 5000, 640)).toBe('cover')
    expect(slideLayoutForFit(undefined, 5000, 640)).toBeUndefined()
  })

  it('counts a layout change as a new plan when the pages themselves did not move', () => {
    const fitted: SlidePlan = { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1], layout: 'split' }
    const refused: SlidePlan = { pages: [{ from: 0, to: 2, top: 0 }], scales: [1, 1] }
    expect(samePlan(fitted, refused)).toBe(false)
    expect(samePlan(fitted, { ...fitted })).toBe(true)
  })
})

describe('planSlidePages — invariants', () => {
  it('covers every block exactly once across non-empty pages', () => {
    const blocks = stack([[40, true], [420], [300], [80, true], [700], [120], [260]])
    const plan = planSlidePages(blocks, 512)
    expect(plan.pages[0]!.from).toBe(0)
    expect(plan.pages.at(-1)!.to).toBe(blocks.length)
    plan.pages.forEach((page, index) => {
      expect(page.to).toBeGreaterThan(page.from)
      if (index > 0) expect(page.from).toBe(plan.pages[index - 1]!.to)
      expect(page.top).toBe(index === 0 ? 0 : blocks[page.from]!.top)
    })
  })

  it('keeps a page within the canvas unless its single block was shrunk', () => {
    const blocks = stack([[40, true], [300], [200], [40, true], [900], [150]])
    const plan = planSlidePages(blocks, 600)
    plan.pages.forEach((page) => {
      const bottom = page.from + 1 === page.to
        ? blocks[page.from]!.height * plan.scales[page.from]!
        : blocks[page.to - 1]!.top + blocks[page.to - 1]!.height - page.top
      expect(bottom).toBeLessThanOrEqual(600)
    })
  })
})

// Deterministic pseudo-random decks: a 32-bit LCG, so a failing case is
// reproducible from its seed without adding a property-testing dependency.
function lcg(seed: number): (max: number) => number {
  let state = seed
  return (max: number) => {
    state = (Math.imul(state, 1103515245) + 12345) | 0
    return ((state >>> 0) / 4294967296) * max
  }
}

// Tops accumulate from the final heights: a fixture whose offsets disagree with
// its heights measures a layout that cannot exist.
function stackHeights(heights: number[], headings: boolean[]): SlideBlock[] {
  let top = 0
  return heights.map((height, index) => {
    const block = { top, height, heading: headings[index] === true }
    top += height
    return block
  })
}

function generatedDeck(seed: number, count: number): SlideBlock[] {
  const next = lcg(seed)
  return stackHeights(
    Array.from({ length: count }, () => Math.round(20 + next(700))),
    Array.from({ length: count }, () => next(1) > 0.7),
  )
}

function headingDenseDeck(seed: number, count: number): SlideBlock[] {
  const next = lcg(seed)
  return stackHeights(
    Array.from({ length: count }, () => Math.round(20 + next(700))),
    Array.from({ length: count }, (_unused, index) => index % 2 === 0),
  )
}

// Every block fits a page on its own and no heading forces an early break, so
// white space on these decks is waste rather than layout intent.
function packableDeck(seed: number, count: number): SlideBlock[] {
  const next = lcg(seed)
  return stackHeights(
    Array.from({ length: count }, () => Math.round(40 + next(300))),
    Array.from({ length: count }, () => false),
  )
}

function spanOf(blocks: SlideBlock[]): number {
  if (blocks.length === 0) return 0
  const last = blocks[blocks.length - 1]!
  return last.top + last.height - blocks[0]!.top
}

// The regression this guards: a break rule that is too eager silently turns one
// slide into several half-empty pages. Counting pages against `ceil(span / page)`
// is not a valid ceiling — a subsection and an atomic oversized block each own a
// page on purpose — so the budget is expressed as the white space a page may
// leave, which is where the waste would actually show up.
describe('planSlidePages — no avoidable blank space', () => {
  const LIMIT = 640

  it('fills every page but the last to within one block of the canvas', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const blocks = packableDeck(seed, 9)
      const maxBlock = Math.max(...blocks.map((block) => block.height))
      expect(maxBlock).toBeLessThan(LIMIT)
      const plan = planSlidePages(blocks, LIMIT)
      plan.pages.slice(0, -1).forEach((page, index) => {
        const used = blocks[page.to - 1]!.top + blocks[page.to - 1]!.height - page.top
        expect(used, `seed ${seed} page ${index}`).toBeGreaterThan(LIMIT - maxBlock)
      })
      // Sound consequence of the same bound: each page but the last is more than
      // `LIMIT - maxBlock` tall, so the deck cannot need more pages than that allows.
      expect((plan.pages.length - 1) * (LIMIT - maxBlock), `seed ${seed}`).toBeLessThan(spanOf(blocks))
    }
  })

  it('starts every page after the first at a heading or a block that did not fit', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const blocks of [generatedDeck(seed, 9), headingDenseDeck(seed, 12)]) {
        const plan = planSlidePages(blocks, 480)
        plan.pages.forEach((page, index) => {
          if (index === 0) return
          const previous = plan.pages[index - 1]!
          const first = blocks[page.from]!
          const fitsOnPreviousPage = first.top + first.height - previous.top <= 480
          // A page may only start early to keep a subsection whole, never to leave white space.
          expect(Boolean(first.heading) || !fitsOnPreviousPage, `seed ${seed} page ${index}`).toBe(true)
        })
      }
    }
  })
})

describe('resolvePageIndex', () => {
  it('clamps a sub-page into the current plan instead of rendering off-plan', () => {
    const plan = planSlidePages(stack([[300], [300], [300]]), 640)
    expect(resolvePageIndex(plan, 5)).toBe(1)
    expect(resolvePageIndex(plan, -3)).toBe(0)
    expect(resolvePageIndex(plan, 1)).toBe(1)
  })
})

// N-31: how many reveals a page is worth, and whether the slide asked for any at all, are properties of
// the measured plan — the same reason the layout lives there: every surface has to agree on what the
// projector walked through, and a thumbnail that draws the last step must not change what the page
// count says.
const STEP_BLOCKS: SlideBlock[] = [
  { top: 0, height: 100, heading: true },
  { top: 100, height: 100, heading: false },
  { top: 200, height: 100, heading: false },
  { top: 300, height: 100, heading: false },
]

describe('the step count a plan carries', () => {
  it('counts one step for every block after the first on the page', () => {
    const plan = planSlidePages(STEP_BLOCKS, 220, undefined, true)
    expect(plan.steps).toBe(true)
    expect(plan.pages.length).toBe(2)
    expect(plan.pages.map((page) => pageSteps(plan, page))).toEqual([1, 1])
  })

  it('asks nothing of a slide that did not switch steps on', () => {
    const plan = planSlidePages(STEP_BLOCKS, 220)
    expect(plan.steps).toBeUndefined()
    expect(pageSteps(plan, plan.pages[0]!)).toBe(0)
  })

  // Two columns are one page either way, and the blocks in them still arrive one after another: the
  // reason a column slide is not walked page by page is geometry, not a reason to stop revealing it.
  it('reveals a two-column slide block by block as well', () => {
    const plan = planSlidePages(STEP_BLOCKS, 220, 'split', true)
    expect(plan.pages.length).toBe(1)
    expect(pageSteps(plan, plan.pages[0]!)).toBe(STEP_BLOCKS.length - 1)
  })

  // A page with one block on it has nothing left to reveal, even when the slide asked for steps.
  it('counts no step for a page that holds a single block', () => {
    const tall: SlideBlock[] = [{ top: 0, height: 100, heading: true }, { top: 100, height: 300, heading: false }]
    const plan = planSlidePages(tall, 220, undefined, true)
    expect(plan.pages.length).toBe(2)
    expect(plan.pages.map((page) => pageSteps(plan, page))).toEqual([0, 0])
  })

  it('is part of the value of a plan, so a slide that gained its switch republishes', () => {
    const plain = planSlidePages(STEP_BLOCKS, 220)
    const stepped = planSlidePages(STEP_BLOCKS, 220, undefined, true)
    expect(samePlan(plain, stepped)).toBe(false)
    expect(samePlan(stepped, planSlidePages(STEP_BLOCKS, 220, undefined, true))).toBe(true)
  })
})
