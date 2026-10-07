export const EN_US_NOTE_TEMPLATE_CONTENT = {
    "template.kanban_sprint_board.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, checklist]
---

\`\`\`kanban
## Backlog
- [ ] Scope the stories
- [ ] Agree the sprint goal

## In progress
- [ ] Start the first story

## Done
- [x] Set up the board
\`\`\`

Sprint goal: 

Risks and blockers:
- 

{{cursor}}
`,
    "template.mindmap_reading_map.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study]
---

## Book

\`\`\`mindmap
- {{title}}
  - Core claim
  - Structure
    - Part 1
    - Part 2
  - What I will use
  - Questions
\`\`\`

## Chapters
- 

## Quotes worth keeping
> 

`,
    "template.chart_weekly_dashboard.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [weekly, table]
---

## This week

\`\`\`chart style=table
| Day | Focus hours | Breaks |
| --- | --- | --- |
| Mon | 4 | 3 |
| Tue | 5 | 2 |
| Wed | 3 | 4 |
| Thu | 6 | 2 |
| Fri | 4 | 3 |
\`\`\`

## Reading the numbers
- Best day:
- What dragged:

## Next week's one change
- [ ] 

`,
    "template.timeline_milestones.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, review]
---

::: timeline
:: [milestone] {{date}} Kickoff
Scope agreed, owner named.
:: [todo] {{date}} First release
:: [doing] {{date}} Beta feedback
:::

## Risks
- 

## Decisions still open
- 

`,
    "template.columns_comparison.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [decision, table]
---

## {{title}}

::: cols
### Option A
- Cost:
- Effort:
- Risk:

::
### Option B
- Cost:
- Effort:
- Risk:
:::

## Verdict
> 

## Why
- 

`,
    "template.tabs_alternatives.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [planning]
---

:::: tabs
::: tab-item Plan A
- Goal:
- Steps:
- Cost:
:::
::: tab-item Plan B
- Goal:
- Steps:
- Cost:
:::
::: tab-item Plan C
- Goal:
- Steps:
- Cost:
:::
::::

## Chosen
- 

`,
    "template.details_faq.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing]
---

## {{title}}

::: details [What is this?]
> 

:::

::: details [Who is it for?]
> 

:::

::: details [How do I start?]
1. 
2. 

:::

## Still unclear
- 

`,
    "template.callout_annotations.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing, checklist]
---

## {{title}}

> [!NOTE]
> Extra context that should not interrupt the reading.

> [!TIP]
> A shortcut the reader can use right away.

> [!WARNING]
> Something that goes wrong if ignored.

## How to use them
- [ ] One per page, at most
- [ ] Put the warning where the action is

`,
    "template.blank.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [daily]
---

{{cursor}}
`,
    "template.front_matter_only.content": `---
title: {{title}}
createdAt: {{createdAt}}
date: {{date}}
folder: {{folder}}
tags: [table]
---

{{cursor}}
`,
    "template.daily_note.content": `---
title: {{title}}
createdAt: {{createdAt}}
date: {{date}}
tags: [daily]
---

## Today
- [ ] 

## Notes
- 

## Log
- {{time}} 

## Closed out
- Done:
- Carried over:
- [ ] 

`,
    "template.weekly_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [weekly, review]
---

## Wins
1. 

## Missed
1. 

## Numbers
| Metric | Target | Actual |
| --- | --- | --- |
|  |  |  |

## Next week, in order
- [ ] 
- [ ] 
- [ ] 

## One thing to stop doing
> 

`,
    "template.monthly_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [review, goal]
---

## Goals this month
| Goal | Status | Evidence |
| --- | --- | --- |
|  |  |  |

## Habits
- Kept:
- Broken:

## Best decision
> 

## What the month cost
- 

## Next month's theme
- [ ] 

`,
    "template.annual_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [review, goal]
---

## The year in numbers
| Area | Last year | This year |
| --- | --- | --- |
| Health |  |  |
| Work |  |  |
| Learning |  |  |
| Money |  |  |

## Q1
- 

## Q2
- 

## Q3
- 

## Q4
- 

## What I would repeat
1. 

## What I am leaving behind
1. 

## Next year, in one line
> 

`,
    "template.one_on_one.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, meeting]
---

## With
- 

## Their topics
1. 

## My topics
1. 

## Questions worth asking
- What is blocking you this week?
- What did you learn recently?
- What would you change about how we work?

## Actions
- [ ] Owner: — Task:
- [ ] Owner: — Task:

## Private notes
> 

`,
    "template.rfc.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [tech, decision]
---

## Status
- Author:
- Reviewers:
- Decision: pending

## Problem
> 

## Proposed change
- 

## Alternatives considered
1. Rejected because:
2. Rejected because:

## Rollout
- [ ] 
- [ ] 

## Open questions
- 

`,
    "template.incident_postmortem.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [tech, review]
---

## Summary
> 

## Impact
| Window | Users affected | Detected by |
| --- | --- | --- |
|  |  |  |

## Timeline
| Time | What happened |
| --- | --- |
| {{time}} |  |

## Root cause
- 

## What went well
- 

## What went badly
- 

## Follow-ups
- [ ] 
- [ ] 

`,
    "template.sop.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [checklist, work]
---

## When this runs
- Trigger:
- Frequency:
- Owner:

## Steps
1. 
2. 
3. 

## Checks before finishing
- [ ] 
- [ ] 

## Exceptions
> 

## If something breaks
- Escalate to:
- Rollback:

`,
    "template.zettelkasten_permanent.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, writing]
---

## {{title}}

> 

## In my own words
- 

## Links to
- [[]]

## Links from
- [[]]

## Source
- 

`,
    "template.fleeting_note.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [daily]
---

## Captured
> 

## Where it came from
- 

## What it might become
- [ ] A permanent note
- [ ] A task
- [ ] A project
- [ ] Deleted

## Process by
- {{tomorrow}}

`,
    "template.literature_note.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, writing]
---

## Source
| Field | Value |
| --- | --- |
| Author |  |
| Year |  |
| Link |  |

## Claims, in order
1. (p. ) 
2. (p. ) 

## My reaction
> 

## Open questions
- 

`,
    "template.map_of_content.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, tech]
---

## {{title}}

> 

## Start here
- [[]]
- [[]]

## By question
- ? → [[]]

## By concept
- → [[]]

## Gaps
- [ ] 

## Recently added
- 

`,
    "template.sq3r_reading.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, checklist]
---

## 1. Survey
- Heading:
- Figures:

## 2. Question
- [ ] 

## 3. Read
> 

## 4. Recite, without looking
- 

## 5. Review
| Question | Answer |
| --- | --- |
|  |  |

## Still unclear
- 

`,
    "template.glossary.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, table]
---

## {{title}}

| Term | Definition | First seen |
| --- | --- | --- |
|  |  | [[]] |

## Confused pairs
- vs → 

## Add when
- [ ] 

`,
    "template.interview_notes.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, meeting]
---

## With
- Who:
- When:
- Purpose:

## Questions and answers
**Q:** 
**A:** 

## In their words
> 

## Signals
- 

## Follow-ups I owe
- [ ] 

`,
    "template.backlog.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, checklist]
---

## Ranked
| Item | Value | Cost | Decision by |
| --- | --- | --- | --- |
|  |  |  |  |

## Cold storage
- 

## Cut this quarter
- 

## How to raise one
1. 

`,
    "template.competitive_analysis.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [tech, table]
---

## Who
| Name | Positioning | Price |
| --- | --- | --- |
|  |  |  |

## Feature by feature
| Feature | Us | Them | Notes |
| --- | --- | --- | --- |
|  |  |  |  |

## Where we lose
> 

## Where we win
> 

## What to copy
- [ ] 

`,
    "template.decision_log.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [decision, review]
---

## Decision
> 

## Context
- 

## Options rejected
| Option | Why not |
| --- | --- |
|  |  |

## Who agreed
- 

## What would reverse this
- [ ] 

## Revisit on
- {{tomorrow}}

`,
    "template.onboarding_checklist.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [checklist, work]
---

## Access
- [ ] 

## People to meet
- [ ] 

## Read first
- [ ] 

## First tasks
- [ ] 

## Week one
| Day | Outcome |
| --- | --- |
| 1 |  |
| 3 |  |
| 5 |  |

## Questions for the manager
- 

`,
    "template.handover_doc.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, checklist]
---

## What this is
> 

## Where things live
| Thing | Location | Access |
| --- | --- | --- |
|  |  |  |

## Recurring work
| When | What | Who to ask |
| --- | --- | --- |
|  |  |  |

## Half done
- [ ] 

## Traps
- 

## Contacts
- 

`,
    "template.ab_experiment.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [tech, table]
---

## Hypothesis
> 

## Design
| Field | Value |
| --- | --- |
| Metric |  |
| Sample size |  |
| Runtime |  |
| Split |  |

## Guardrails
- 

## Result
| Variant | N | Metric | Lift |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |

## Decision
- [ ] Ship
- [ ] Iterate
- [ ] Kill

`,
    "template.character_card.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing]
---

## {{title}}

| Field | Value |
| --- | --- |
| Age |  |
| Role |  |
| Wants |  |
| Needs |  |
| Wound |  |

## Voice
> 

## Tells
- 

## Contradiction
- 

## Arc
- Starts:
- Ends:

`,
    "template.worldbuilding.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing]
---

## {{title}}

## The rule
> 

## The cost
- 

## Who benefits
- 

## Who is harmed
- 

## What everyone believes about it
- 

## What is actually true
- 

## Where it shows up
- [[]]

`,
    "template.book_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, writing]
---

## Verdict
> 

## The book claims
1. 

## How well it proves it
- 

## Best chapter
- 

## Weakest part
- 

## Read it if
- [ ] 

## Skip it if
- [ ] 

## Rating
| Axis | Score |
| --- | --- |
| Ideas |  |
| Prose |  |
| Usefulness |  |

`,
    "template.film_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing, review]
---

## One line
> 

## What it aims at
- 

## Whether it lands
- 

## The scene that decides it
> 

## Craft
| Element | Works? | Why |
| --- | --- | --- |
| Editing |  |  |
| Sound |  |  |
| Script |  |  |

## See it
- [ ] In a cinema
- [ ] At home
- [ ] Never

`,
    "template.scqa_pyramid.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing, work]
---

## Situation
- 

## Complication
- 

## Question
> 

## Answer (say this first)
> 

## Support
1. Because 
   1. 
2. Because 
   1. 
3. Because 
   1. 

## Order check
- [ ] The reader's question comes before the answer
- [ ] Each support is one idea

`,
    "template.longform_article.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [writing]
---

## Promise
> 

## Lede
> 

## Section 1
### 
- 

## Section 2
### 
- 

## The turn
> 

## Section 3
### 
- 

## Close
> 

## Cut list
- 

::: details [Notes for the editor]
- 

:::

`,
    "template.medication_log.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [health, table]
---

## Today
| Time | What | Dose | Reaction |
| --- | --- | --- | --- |
| {{time}} |  |  |  |

## Symptoms
- Where:
- Severity (0-10):
- Started:

## Questions for the doctor
- [ ] 

## Notes
- 

`,
    "template.therapy_prep.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [health, review]
---

## Since last time
- 

## Strongest feeling this week
> 

## Patterns I noticed
- 

## One thing to bring up
1. 

## What helped
- 

## What did not
- 

`,
    "template.health_metrics.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [health, table]
---

## {{title}}

| Measure | Last year | This year | Range | Flag |
| --- | --- | --- | --- | --- |
| Weight |  |  |  |  |
| Blood pressure |  |  |  |  |
| Pulse |  |  |  |  |
| Fasting glucose |  |  |  |  |
| LDL |  |  |  |  |

## What changed
- 

## To follow up
- [ ] 

## Doctor's note
> 

`,
    "template.quit_tracker.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [health, goal, checklist]
---

## Started
- When: {{date}}
- Why:
> 

## Today
| Time | Urge | Strength | What I did instead |
| --- | --- | --- | --- |
|  |  |  |  |

## Substitutions that work
- 

## Slip plan
> 

## Milestones
- [ ] 24h
- [ ] 1 week
- [ ] 1 month

`,
    "template.mood_checkin.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [health, daily]
---

## {{date}} {{time}}

| Axis | 1-5 |
| --- | --- |
| Mood |  |
| Energy |  |
| Focus |  |
| Anxiety |  |

## What set it off
- 

## What I did
- 

## What I need
- [ ] 

## Tomorrow
> 

`,
    "template.lesson_plan.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [study, planning]
---

## Class
- Subject:
- Length:

## Objective
> Students will be able to 

## Activate (5 min)
- 

## Teach (15 min)
1. 
2. 

## Practise (20 min)
- [ ] 

## Check
| Question | What a good answer looks like |
| --- | --- |
|  |  |

## Exit ticket
> 

## Next time
- 

`,
    "template.lab_notebook.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [tech, table]
---

## Question
> 

## Hypothesis
> 

## Materials
- 

## Method
1. 

## Raw results
| Run | Input | Output | Notes |
| --- | --- | --- | --- |
| 1 |  |  |  |

## Anomalies
- 

## Conclusion
- [ ] Supports
- [ ] Refutes
- [ ] Inconclusive

## Next experiment
- 

`,
    "template.client_profile.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, meeting]
---

## Who
| Field | Value |
| --- | --- |
| Company |  |
| Contact |  |
| Role |  |

## Their situation
> 

## Decision chain
- Who decides:
- Who blocks:
- Budget owner:

## Timeline
- 

## Our ask
- 

## Objections heard
- 

## Next step
- [ ] 

`,
    "template.sales_call.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [work, checklist]
---

## Before
- I want:
- They likely want:

## During
| Topic | They said | I said |
| --- | --- | --- |
|  |  |  |

## Signals
- Budget:
- Authority:
- Need:
- Timing:

## Committed
- [ ] 

## Follow up by
- {{tomorrow}}

`,
    "template.case_summary.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [review, writing]
---

## Reference
| Field | Value |
| --- | --- |
| Matter |  |
| Client |  |
| Court |  |

## Facts
- 

## Issues
1. 

## Positions
| Party | Argues | Authority |
| --- | --- | --- |
|  |  |  |

## Open questions
- [ ] 

## Deadlines
| Due | What | Owner |
| --- | --- | --- |
|  |  |  |

`,
    "template.flat_comparison.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [finance, table]
---

## Deal breakers
| Place | Deal breaker? | What |
| --- | --- | --- |
|  |  |  |

## Side by side
| Item | A | B | C |
| --- | --- | --- | --- |
| Price |  |  |  |
| Commute |  |  |  |
| Light |  |  |  |
| Noise |  |  |  |
| Storage |  |  |  |

## Costs beyond rent
- 

## Visited
- {{date}} 

## Leaning
> 

`,
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
