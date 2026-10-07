import type { BaseMessageKey } from '@shared/locales/en-US';

/**
 * The starter bodies behind the editor toolbar's diagram submenus, as data: one row per entry, each
 * carrying the label it is offered under and the text written into the new fence.
 *
 * Every body here has to be something the block's own reader accepts, so the lists are asserted against
 * those readers in `diagram-templates.test.ts` rather than trusted — a template that inserts a fence the
 * block then reports as broken is worse than no template at all.
 */
export interface DiagramTemplate {
    id: string;
    labelKey: BaseMessageKey;
    body: string;
}

export const MERMAID_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'flowchart',
        labelKey: 'workspace.mermaid_flowchart',
        body: `flowchart TD
    A[Start] --> B{Condition}
    B -->|Yes| C[Success]
    B -->|No| D[Handle Error]`,
    },
    {
        id: 'sequence',
        labelKey: 'workspace.mermaid_sequence',
        body: `sequenceDiagram
    autonumber
    actor User
    participant App
    participant Server
    User->>App: Action
    App->>Server: API Request
    Server-->>App: Response Data
    App-->>User: Render View`,
    },
    {
        id: 'gantt',
        labelKey: 'workspace.mermaid_gantt',
        body: `gantt
    title Project Schedule
    dateFormat YYYY-MM-DD
    section Planning
    Requirements :2026-09-01, 5d
    Architecture :2026-09-06, 4d
    section Development
    Core Features :2026-09-10, 14d
    Testing & QA :2026-09-24, 7d`,
    },
    {
        id: 'class',
        labelKey: 'workspace.mermaid_class',
        body: `classDiagram
    class User {
        +String id
        +String name
        +login()
    }
    class Admin {
        +manageUsers()
    }
    User <|-- Admin`,
    },
    {
        id: 'pie',
        labelKey: 'workspace.mermaid_pie',
        body: `pie title Expense Distribution
    "Engineering" : 45
    "Operations" : 25
    "Marketing" : 20
    "Other" : 10`,
    },
    {
        id: 'state',
        labelKey: 'workspace.mermaid_state',
        body: `stateDiagram-v2
    [*] --> Pending
    Pending --> InProgress: Start
    InProgress --> Review: Submit
    Review --> Completed: Approve
    Review --> InProgress: Reject
    Completed --> [*]`,
    },
    {
        id: 'er',
        labelKey: 'workspace.mermaid_er',
        body: `erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ ORDER_ITEM : contains
    PRODUCT ||--o{ ORDER_ITEM : refers`,
    },
    {
        id: 'mindmap',
        labelKey: 'workspace.mermaid_mindmap',
        body: `mindmap
  root((Core Topic))
    Product
      Target Audience
      Key Value
    Architecture
      Web Client
      Edge Runtime
      Database
    Operations
      Community
      Ecosystem`,
    },
    {
        id: 'timeline',
        labelKey: 'workspace.mermaid_timeline',
        body: `timeline
    title Milestone History
    2024 : Concept : Prototype
    2025 : Version 1.0 : Cross Platform
    2026 : Version 2.0 : AI Integration`,
    },
    {
        id: 'journey',
        labelKey: 'workspace.mermaid_journey',
        body: `journey
    title User Onboarding Journey
    section Discovery
      Visit Homepage: 5: User
      Read Docs: 4: User
    section Sign Up
      Enter Email: 3: User
      Verify Account: 4: User
      Enter Workspace: 5: User`,
    },
    {
        id: 'quadrant',
        labelKey: 'workspace.mermaid_quadrant',
        body: `quadrantChart
    title Feature Priority Matrix
    x-axis Low Complexity --> High Complexity
    y-axis Low Value --> High Value
    quadrant-1 Strategic Priority
    quadrant-2 Quick Win
    quadrant-3 Re-evaluate
    quadrant-4 Avoid
    Feature A: [0.3, 0.85]
    Feature B: [0.75, 0.9]
    Feature C: [0.2, 0.3]
    Feature D: [0.8, 0.25]`,
    },
    {
        id: 'gitgraph',
        labelKey: 'workspace.mermaid_gitgraph',
        body: `gitGraph
    commit
    commit
    branch feature
    checkout feature
    commit
    commit
    checkout main
    merge feature
    commit`,
    },
    {
        id: 'c4',
        labelKey: 'workspace.mermaid_c4',
        body: `C4Context
    title System Context Diagram
    Person(customer, "User", "A customer of the notebook system.")
    System(app, "Inkstone", "Markdown notes and live preview.")
    System_Ext(s3, "S3 Storage", "Encrypted backup storage.")
    Rel(customer, app, "Edits and views notes")
    Rel(app, s3, "Performs scheduled backup")`,
    },
    {
        id: 'kanban',
        labelKey: 'workspace.mermaid_kanban',
        body: `kanban
  Todo
    [Improve unit test coverage]
    [Optimize mobile typography]
  InProgress
    [Extend chart and diagram options]
  Done
    [Upgrade code block highlighting]
    [Table visual alignment]`,
    },
];

/**
 * The chart bodies are tables rather than Chart.js options, because a table is what an author edits in
 * place: the first cell names the type, the header row is the x axis, and every row is one series. The
 * block's own toolbar converts any of them to JSON when the full option set is needed. None carries a
 * colour on purpose — a chart with no colours of its own is painted from the note's accent and repaints
 * when the accent or the theme changes.
 */
export const CHART_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'bar',
        labelKey: 'workspace.chart_bar',
        body: `| :bar: | Jan | Feb | Mar |
| --- | --- | --- | --- |
| Series A | 12 | 19 | 15 |`,
    },
    {
        id: 'line',
        labelKey: 'workspace.chart_line',
        body: `| :line: | Jan | Feb | Mar | Apr |
| --- | --- | --- | --- | --- |
| Series A | 12 | 19 | 15 | 25 |`,
    },
    {
        // A slice chart is one row per slice, not one column per slice: the categories live in the first
        // column and the second header cell names the value column.
        id: 'pie',
        labelKey: 'workspace.chart_pie',
        body: `| :pie: | Share |
| --- | --- |
| Engineering | 45 |
| Operations | 25 |
| Marketing | 20 |
| Other | 10 |`,
    },
    {
        id: 'doughnut',
        labelKey: 'workspace.chart_doughnut',
        body: `| :doughnut: | Share |
| --- | --- |
| Direct | 40 |
| Search | 30 |
| Social | 20 |
| Referral | 10 |`,
    },
    {
        id: 'radar',
        labelKey: 'workspace.chart_radar',
        body: `| :radar: | Speed | Stamina | Power | Range | Accuracy |
| --- | --- | --- | --- | --- | --- |
| Player A | 7 | 5 | 8 | 6 | 9 |
| Player B | 4 | 8 | 5 | 7 | 6 |`,
    },
    {
        id: 'polarArea',
        labelKey: 'workspace.chart_polar_area',
        body: `| :polarArea: | Population |
| --- | --- |
| North | 30 |
| South | 45 |
| East | 20 |
| West | 55 |`,
    },
    {
        // The keyword cell doubles as the point-name column, and a size column is what turns the scatter
        // into bubbles — which is the type this entry is named for.
        id: 'bubble',
        labelKey: 'workspace.chart_bubble',
        body: `| :scatter: | x | y | size |
| --- | --- | --- | --- |
| A | 1 | 2 | 12 |
| B | 3 | 4 | 30 |
| C | 5 | 1 | 20 |`,
    },
];

export const MINDMAP_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'outline',
        labelKey: 'workspace.mindmap_outline',
        body: `- Core Topic
  - Product
    - Target Audience
    - Key Value
  - Architecture
    - Web Client
    - Edge Runtime
  - Operations
    - Community`,
    },
    {
        id: 'json',
        labelKey: 'workspace.mindmap_json',
        body: `{
  "nodeData": {
    "topic": "Core Topic",
    "children": [
      {
        "topic": "Product",
        "children": [{ "topic": "Target Audience" }, { "topic": "Key Value" }]
      },
      {
        "topic": "Architecture",
        "children": [{ "topic": "Web Client" }, { "topic": "Edge Runtime" }]
      },
      {
        "topic": "Operations",
        "children": [{ "topic": "Community" }]
      }
    ]
  }
}`,
    },
];

export const KANBAN_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'outline',
        labelKey: 'workspace.kanban_outline',
        body: `## To Do
- [ ] Write the plan
- [ ] Review the plan

## Doing
- [ ] Draft the columns

## Done
- [x] Pick the board format`,
    },
    {
        id: 'json',
        labelKey: 'workspace.kanban_json',
        body: `{
  "title": "Kanban",
  "columns": [
    {
      "id": "status",
      "name": "Status",
      "type": "select",
      "options": [
        { "id": "todo", "label": "To Do", "color": "gray" },
        { "id": "in_progress", "label": "In Progress", "color": "blue" },
        { "id": "done", "label": "Done", "color": "green" }
      ]
    }
  ],
  "items": []
}`,
    },
];
