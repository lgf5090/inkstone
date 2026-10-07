export const EN_US_NOTE_TEMPLATE_CONTENT = {
    "template.article_outline.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing]
---

## Working Title

## Thesis
> 

## Audience

## Outline
### 1. Hook
- 

### 2. Section 1
- Key argument:
- Evidence:

### 3. Section 2
- Key argument:
- Evidence:

### 4. Conclusion
- 

## Sources
- 
`,
    "template.book_notes.content": `---
title: Book Notes: {{title}}
createdAt: {{createdAt}}
tags: [reading]
---

## Book Info
- Author:
- Started: {{date}}
- Finished:

## Key Ideas
1. 

## Quotes
> 

## My Thoughts
- 

## Action Items
- [ ] 

## Rating
⭐⭐⭐⭐⭐
`,
    "template.brainstorm.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [brainstorm]
---

## Topic

## Rules
- Quantity over quality
- No criticism during the session
- Build on each other's ideas

## Raw Ideas
- 
- 
- 
- 

## Clusters
### Cluster A
- 

### Cluster B
- 

## Top Picks
1. 

## Next Step
- [ ] 
`,
    "template.bug_tracker.content": `---
title: Bug: {{title}}
createdAt: {{createdAt}}
tags: [bug]
---

## Severity
- [ ] Critical
- [ ] High
- [ ] Medium
- [ ] Low

## Environment
- Version:
- OS / Browser:

## Repro Steps
1. 

## Expected
- 

## Actual
- 

## Root Cause
- 

## Fix
- [ ] 

## Verification
- [ ] Reproduced before fix
- [ ] Fixed in:
`,
    "template.bullet_journal.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [bullet-journal]
---

## Future Log
- [[Month]] · {{tomorrow}}
- [[Month]] · {{tomorrow}}
- [[Month]] · {{tomorrow}}

## Monthly Log

| Date | Tasks | Events | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Daily Log

- [ ] Task
- [ ] Migrated task · >
- [ ] Scheduled task · <
- Event · o
- Note · -

## Key
- · task · > migrated · < scheduled · o event · - note
- * priority · ! inspiration · ? question · x done
`,
    "template.class_notes.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [class]
---

## Course
- Lecturer:
- Topic:

## Key Points
1. 

## Examples
- 

## Questions
- [ ] 

## After Class
- [ ] Review notes
- [ ] Do exercises
- [ ] Ask questions
`,
    "template.cornell.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [cornell]
---

| Cue column | Notes |
| --- | --- |
| Keywords, questions | Main notes, diagrams, examples |

> Write keywords and questions on the left, then take notes on the right.
> Review within 24 hours, cover the notes and quiz yourself from the cue column.

## Summary

Summarize the page in your own words in 1-3 sentences. {{cursor}}
`,
    "template.dev_daily.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [dev]
---

## Today
- [ ] 
- [ ] 

## Details
- 

## Commits / PRs
- 

## Blockers
- 

## Open Questions
- 

## Tomorrow
- [ ] 

## Learned
- 
`,
    "template.diary.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [diary]
---

## Mood
- Energy (1-5):
- Mood (1-5):

## Today's Highlights
1. 

## What Happened
- 

## Gratitude
- 

## Tomorrow
- [ ] 

{{cursor}}
`,
    "template.expense_log.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [expense]
---

## Daily Spending
| Item | Category | Amount |
| --- | --- | --- |
|  |  |  |

## Category Totals
- Food:
- Transport:
- Shopping:
- Other:

## Budget Check
- Daily budget:
- Spent today:
- Remaining this month:

## Notes
- 
`,
    "template.feynman.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [feynman]
---

## Concept

## Plain-Language Explanation

Pretend you are teaching an 8-year-old:

> 

## Gaps Found
1. 

## Simplify & Retry

Rewrite with an analogy:

## Final Check
- [ ] Can I explain it without jargon?
- [ ] Can I give a concrete example?
`,
    "template.four_quadrant.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [priority]
---

## 1. Important & Urgent — do now
- [ ] 

## 2. Important & Not Urgent — schedule
- [ ] 

## 3. Not Important & Urgent — delegate
- [ ] 

## 4. Not Important & Not Urgent — drop or limit
- [ ] 

> Principle: protect time for quadrant 2; the most meaningful work lives there. {{cursor}}
`,
    "template.gtd.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [gtd]
---

## Inbox
- 

## Next Actions
- [ ] 

## Waiting For
- [ ] 

## Projects
- [ ] 

## Someday / Maybe
- 

## Calendar
- {{today}}:
- {{tomorrow}}:

> Weekly review: empty the inbox, update lists, and decide the next physical action for each project.
`,
    "template.habit_tracker.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [habits]
---

## Habits
- [ ] 
- [ ] 
- [ ] 

## Monthly Grid

| Date | Habit 1 | Habit 2 | Habit 3 |
| --- | --- | --- | --- |
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

## Notes
- Missed a day? Don't break the chain — just continue. {{cursor}}
`,
    "template.knowledge_cards.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [cards]
---

## Idea

> One sentence.

## Notes

## Sources
- 

## Related
- [[Related Note]]

## Actions
- [ ] 

> Write it as if you will never see the original source again. {{cursor}}
`,
    "template.marketing_plan.content": `---
title: {{title}} Marketing Plan
createdAt: {{createdAt}}
tags: [marketing]
---

## Campaign Overview
- Goal:
- Target audience:
- Launch date:

## Channels
- [ ] Social media
- [ ] Email
- [ ] Content / SEO
- [ ] Paid ads

## Content Plan
| Date | Channel | Topic | Status |
| --- | --- | --- | --- |
|  |  |  |  |

## Budget
| Item | Planned | Actual |
| --- | --- | --- |
| Ads |  |  |
| Production |  |  |

## Success Metrics
- 

## Review
- {{tomorrow}}
`,
    "template.meal_log.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [food]
---

## Breakfast
- 

## Lunch
- 

## Dinner
- 

## Snacks
- 

## Daily Check
- Calories:  / 
- Water:  glasses
- Feeling:
- 

> Honest records beat perfect records. {{cursor}}
`,
    "template.meeting_minutes.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [meeting]
---

## Meta
- Time:
- Attendees:
- Absent:

## Agenda
1. 

## Discussion
- 

## Decisions
1. 

## Action Items
- [ ] Owner:  · Due: 

## Next Meeting
- {{tomorrow}}
`,
    "template.mistake_notebook.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [mistakes]
---

## Subject

## Original Problem

## My Mistake

## Correct Approach

## Root Cause
- [ ] Careless
- [ ] Knowledge gap
- [ ] Wrong method

## Retest Date
- {{tomorrow}}
`,
    "template.morning_pages.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [journal]
---

## Free writing

Start writing whatever comes to mind. Don't edit, don't stop.

{{cursor}}

## One-line today

## Intention
`,
    "template.movie_log.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [movies]
---

## Seen

### {{date}}
- Title:
- Rating: ⭐⭐⭐
- Review:
- Favorite scene:

## Want to Watch
- [ ] 
- [ ] 

## Yearly Stats
- Total:
- Favorites:
`,
    "template.okr.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [okr]
---

## Objective 1

- [ ] KR 1.1: 
- [ ] KR 1.2: 
- [ ] KR 1.3: 

## Objective 2

- [ ] KR 2.1: 
- [ ] KR 2.2: 

## Weekly Check-in
| Week | Progress | Blockers |
| --- | --- | --- |
|  |  |  |

> KRs should be measurable, ambitious and time-bound. Review weekly.
`,
    "template.pdca.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [pdca]
---

## Plan
- Goal:
- Current status:
- Root causes:
- Actions to take:

## Do
- [ ] 
- [ ] 

## Check
- Results vs plan:
- What worked:
- What did not:

## Act
- Keep:
- Adjust:
- Next cycle starts: {{tomorrow}}
`,
    "template.pomodoro.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [pomodoro]
---

## Today's Goal

## Pomodoros

| # | Task | Interruptions | Done |
| --- | --- | --- | --- |
| 1 |  |  | [ ] |
| 2 |  |  | [ ] |
| 3 |  |  | [ ] |
| 4 |  |  | [ ] |

## Notes
- 

> Rhythm: 25 min work, 5 min break; every 4 pomodoros take a longer break. {{cursor}}
`,
    "template.prd.content": `---
title: {{title}} PRD
createdAt: {{createdAt}}
tags: [product]
---

## Background
- Problem:
- Why now:

## Goals
1. 

## Non-Goals
- 

## Target Users
- 

## User Stories
- As a ..., I want to ..., so that ...

## Scope
### In Scope
- [ ] 

### Out of Scope
- 

## Acceptance Criteria
- [ ] 

## Metrics
- 

## Open Questions
- 
`,
    "template.project_review.content": `---
title: {{title}} Retrospective
createdAt: {{createdAt}}
tags: [review]
---

## Background
- Project:
- Period:
- Goal:

## What Went Well
1. 

## What Went Wrong
1. 

## Root Causes
- 

## Keep Doing
- 

## Improve Next Time
- [ ] 

## Lessons
- 
`,
    "template.recipe.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [cooking]
---

## Dish

## Servings

## Time
- Prep:  min
- Cook:  min

## Ingredients
- 

## Steps
1. 

## Taste Notes
- Rating: ⭐⭐⭐
- Adjust next time:

> Remember to write down the seasoning amounts you actually used. {{cursor}}
`,
    "template.shopping_list.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [shopping]
---

## Groceries
- [ ] 
- [ ] 

## Household
- [ ] 
- [ ] 

## Electronics / Other
- [ ] 

## Budget
- Planned: 
- Spent: 
- Remaining: 

> Tick items off as you put them into the cart. {{cursor}}
`,
    "template.sleep_diary.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [sleep]
---

## Last Night
- Bedtime:
- Fell asleep:
- Woke up:
- Got up:

## Quality
- Total sleep:  h
- Quality (1-5):
- Awakenings:

## Factors
- Caffeine after 14:00: 
- Screen time before bed: 
- Exercise today: 

## Tonight's Plan
- [ ] Wind down at:
- [ ] Lights off at:

> Keep a consistent schedule — weekends too. {{cursor}}
`,
    "template.speech_draft.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [speech]
---

## Occasion
- Event:
- Duration:  min
- Audience:

## One-Minute Message
> 

## Opening
- Hook:
- Why this topic:

## Main Points
### Point 1
- 

### Point 2
- 

### Point 3
- 

## Closing
- Recap:
- Call to action:

## Delivery Notes
- Pace:
- Pauses:
`,
    "template.story_setting.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [story]
---

## Logline
> 

## Characters
### Protagonist
- Name:
- Want:
- Need:
- Flaw:

### Antagonist
- Name:
- Want:

## World
- Setting:
- Rules:
- Conflict source:

## Plot
### Act 1
- 

### Act 2
- 

### Act 3
- 

## Themes
- 
`,
    "template.swot.content": `---
title: {{title}} SWOT
createdAt: {{createdAt}}
tags: [swot]
---

|  | Positive | Negative |
| --- | --- | --- |
| Internal | **Strengths** | **Weaknesses** |
|  |  |  |
| External | **Opportunities** | **Threats** |
|  |  |  |

## Strategies
- SO (use strengths to seize opportunities):
- WO (fix weaknesses to grab opportunities):
- ST (use strengths to reduce threats):
- WT (avoid threats, minimize weaknesses):
`,
    "template.task_breakdown.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [planning]
---

## Big Task

**Goal / Definition of done:**

## Subtasks
- [ ] 1. 
  - [ ] Details
- [ ] 2. 
  - [ ] Details
- [ ] 3. 

## Dependencies & Risks
- 

## Estimate
- Total:  hours
- Deadline: 

> Each subtask should be small enough to start without thinking. {{cursor}}
`,
    "template.todo_list.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [todo]
---

## Today
- [ ] **High priority**
  - [ ] 
- [ ] **Medium priority**
  - [ ] 
- [ ] **Low priority**
  - [ ] 

## Deferred
- [ ] 

> Pick the single most important task and finish it first. {{cursor}}
`,
    "template.travel_guide.content": `---
title: {{title}} Travel Guide
createdAt: {{createdAt}}
tags: [travel]
---

## Trip Info
- Destination:
- Dates:
- Travelers:

## Itinerary
### Day 1 · {{today}}
- [ ] Morning:
- [ ] Afternoon:
- [ ] Evening:

### Day 2 · {{tomorrow}}
- [ ] Morning:
- [ ] Afternoon:
- [ ] Evening:

## Budget
| Item | Planned | Actual |
| --- | --- | --- |
| Transport |  |  |
| Accommodation |  |  |
| Food |  |  |
| Tickets |  |  |

## Packing
- [ ] Documents & IDs
- [ ] 

## Bookings
- [ ] Flights
- [ ] Hotel
- [ ] 

## Notes
- 
`,
    "template.weekly_plan.content": `---
title: {{title}} · Week
createdAt: {{createdAt}}
tags: [weekly]
---

## This Week's Focus
1. 

## Schedule
| Day | Tasks | Notes |
| --- | --- | --- |
| Mon |  |  |
| Tue |  |  |
| Wed |  |  |
| Thu |  |  |
| Fri |  |  |
| Sat |  |  |
| Sun |  |  |

## Next Week Preview
- 

> Review on Sunday: what moved forward, what needs replanning. {{cursor}}
`,
    "template.weekly_report.content": `---
title: {{title}} Weekly Report
createdAt: {{createdAt}}
tags: [report]
---

## Completed
1. 

## In Progress
- 

## Blockers
- 

## Learned
- 

## Next Week
- [ ] 

## Metrics
| KPI | Target | Actual |
| --- | --- | --- |
|  |  |  |
`,
    "template.workout_plan.content": `---
title: {{title}} Workout Plan
createdAt: {{createdAt}}
tags: [fitness]
---

## Weekly Split
| Day | Focus |
| --- | --- |
| Mon |  |
| Wed |  |
| Fri |  |

## Workout Log
### Push Day
| Exercise | Sets × Reps | Weight | Done |
| --- | --- | --- | --- |
|  |  |  | [ ] |

### Pull Day
| Exercise | Sets × Reps | Weight | Done |
| --- | --- | --- | --- |
|  |  |  | [ ] |

## Rest & Recovery
- Sleep:  h
- Stretching: [ ] 
`,
} as const

export type NoteTemplateContentKey = keyof typeof EN_US_NOTE_TEMPLATE_CONTENT
