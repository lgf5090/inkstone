import type { BaseMessageKey } from '@shared/locales/en-US';

/**
 * The starter bodies behind the editor toolbar's diagram submenus, as data: one row per entry, each
 * carrying the label it is offered under and the text written into the new fence.
 *
 * Every body here has to be something the block's own reader accepts, so the lists are asserted against
 * those readers in `diagram-templates.test.ts` rather than trusted — a template that inserts a fence the
 * block then reports as broken is worse than no template at all.
 *
 * The Mermaid rows are the documentation site's own first example for each type that still fits a
 * starter's size, one per diagram type the engine registers. Taking them from there rather than writing
 * fresh snippets means the menu ships bodies the renderer is itself tested against, and that a type
 * cannot be offered in the menu without existing on that page.
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
  A --> B
  B --> A`,
    },
    {
        id: 'sequence',
        labelKey: 'workspace.mermaid_sequence',
        body: `sequenceDiagram
  autonumber
  actor Customer
  participant Web as Web app
  participant API as API gateway
  participant Bank
  Customer->>Web: Place order
  Web->>API: POST /orders
  activate API
  API->>Bank: Authorise payment
  Bank-->>API: Approved
  API-->>Web: 201 Created
  deactivate API
  Web-->>Customer: Order confirmed
  Note over Customer,Bank: One order, one transaction`,
    },
    {
        id: 'gantt',
        labelKey: 'workspace.mermaid_gantt',
        body: `gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
        A task          :a1, 2014-01-01, 30d
        Another task    :after a1, 20d
    section Another
        Task in Another :2014-01-12, 12d
        another task    :24d`,
    },
    {
        id: 'class',
        labelKey: 'workspace.mermaid_class',
        body: `classDiagram
  Animal <|-- Turtle
  Animal <|-- Shark
  Animal <|-- Whale
  Animal *-- Habitat
  Habitat o-- Animal
  Turtle --> Shark : fears
  Shark --> Turtle : hunts`,
    },
    {
        id: 'pie',
        labelKey: 'workspace.mermaid_pie',
        body: `pie title Pets adopted by volunteers
    "Dogs" : 386
    "Cats" : 85
    "Rats" : 15`,
    },
    {
        id: 'state',
        labelKey: 'workspace.mermaid_state',
        body: `stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> Idle : stop
  Running --> Paused : pause
  Paused --> Running : resume
  Paused --> Idle : stop
  Running --> [*]`,
    },
    {
        id: 'er',
        labelKey: 'workspace.mermaid_er',
        body: `erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER }|..|{ ADDRESS : uses
  ORDER }o--|| ADDRESS : "ships to"
  PRODUCT ||--o{ LINE_ITEM : "appears in"`,
    },
    {
        id: 'mindmap',
        labelKey: 'workspace.mermaid_mindmap',
        body: `mindmap
  root((mindmap))
    Origins
      Long history
      ::icon(fa fa-book)
      Popularization
        British popular psychology author Tony Buzan
    Research
      On effectiveness<br/>and features
      On Automatic creation
        Uses
            Creative techniques
            Strategic planning
            Argument mapping
    Tools
      Pen and paper
      Mermaid`,
    },
    {
        id: 'timeline',
        labelKey: 'workspace.mermaid_timeline',
        body: `timeline
    title History of Social Media Platform
    2002 : LinkedIn
    2004 : Facebook
         : Google
    2005 : YouTube
    2006 : Twitter`,
    },
    {
        id: 'journey',
        labelKey: 'workspace.mermaid_journey',
        body: `journey
    title My working day
    section Go to work
      Make tea: 5: Me
      Go upstairs: 3: Me
      Do work: 1: Me, Cat
    section Go home
      Go downstairs: 5: Me
      Sit down: 5: Me`,
    },
    {
        id: 'quadrant',
        labelKey: 'workspace.mermaid_quadrant',
        body: `quadrantChart
    title Reach and engagement of campaigns
    x-axis Low Reach --> High Reach
    y-axis Low Engagement --> High Engagement
    quadrant-1 We should expand
    quadrant-2 Need to promote
    quadrant-3 Re-evaluate
    quadrant-4 May be improved
    Campaign A: [0.3, 0.6]
    Campaign B: [0.45, 0.23]
    Campaign C: [0.57, 0.69]
    Campaign D: [0.78, 0.34]
    Campaign E: [0.40, 0.34]
    Campaign F: [0.35, 0.78]`,
    },
    {
        id: 'gitgraph',
        labelKey: 'workspace.mermaid_gitgraph',
        body: `---
title: Example Git diagram
---
gitGraph
   commit
   commit
   branch develop
   checkout develop
   commit
   commit
   checkout main
   merge develop
   commit
   commit`,
    },
    {
        id: 'c4',
        labelKey: 'workspace.mermaid_c4',
        body: `    C4Dynamic
    title Dynamic diagram for Internet Banking System - API Application

    ContainerDb(c4, "Database", "Relational Database Schema", "Stores user registration information, hashed authentication credentials, access logs, etc.")
    Container(c1, "Single-Page Application", "JavaScript and Angular", "Provides all of the Internet banking functionality to customers via their web browser.")
    Container_Boundary(b, "API Application") {
      Component(c3, "Security Component", "Spring Bean", "Provides functionality Related to signing in, changing passwords, etc.")
      Component(c2, "Sign In Controller", "Spring MVC Rest Controller", "Allows users to sign in to the Internet Banking System.")
    }
    Rel(c1, c2, "Submits credentials to", "JSON/HTTPS")
    Rel(c2, c3, "Calls isAuthenticated() on")
    Rel(c3, c4, "select * from users where username = ?", "JDBC")

    UpdateRelStyle(c1, c2, $textColor="red", $offsetY="-40")
    UpdateRelStyle(c2, c3, $textColor="red", $offsetX="-40", $offsetY="60")
    UpdateRelStyle(c3, c4, $textColor="red", $offsetY="-40", $offsetX="10")`,
    },
    {
        id: 'kanban',
        labelKey: 'workspace.mermaid_kanban',
        body: `kanban
  column1[Column Title]
    task1[Task Description]`,
    },
    {
        id: 'block',
        labelKey: 'workspace.mermaid_block',
        body: `block
columns 1
  db(("DB"))
  blockArrowId6<["&nbsp;&nbsp;&nbsp;"]>(down)
  block:ID
    A
    B["A wide one in the middle"]
    C
  end
  space
  D
  ID --> D
  C --> D
  style B fill:#969,stroke:#333,stroke-width:4px`,
    },
    {
        id: 'eventmodeling',
        labelKey: 'workspace.mermaid_eventmodeling',
        body: `eventmodeling

tf 01 ui CartUI
tf 02 cmd AddItem
tf 03 evt ItemAdded`,
    },
    {
        id: 'packet',
        labelKey: 'workspace.mermaid_packet',
        body: `packet
title UDP Packet
+16: "Source Port"
+16: "Destination Port"
32-47: "Length"
48-63: "Checksum"
64-95: "Data (variable length)"`,
    },
    {
        id: 'requirement',
        labelKey: 'workspace.mermaid_requirement',
        body: `requirementDiagram
  requirement fast {
    id: 1
    text: Renders quickly
  }
  requirement small {
    id: 2
    text: Ships little code
  }
  element layout {
    type: module
  }
  layout - satisfies -> fast
  layout - satisfies -> small
  fast - derives -> small
  small - refines -> fast`,
    },
    {
        id: 'sankey',
        labelKey: 'workspace.mermaid_sankey',
        body: `sankey

%% source,target,value
Electricity grid,Over generation / exports,104.453
Electricity grid,Heating and cooling - homes,113.726
Electricity grid,H2 conversion,27.14`,
    },
    {
        id: 'xychart',
        labelKey: 'workspace.mermaid_xychart',
        body: `xychart
    title "Sales Revenue"
    x-axis [jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]
    line [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]`,
    },
    {
        id: 'agentflow',
        labelKey: 'workspace.mermaid_agentflow',
        body: `agentflow-beta TB
  flow reviewer["Review Agent"]
    changes["Gather changes"]@{ shape: input }
    analyze["Analyze diff"]@{ shape: task }
    lint["run_linter"]@{ shape: tool }
    ok["Clean?"]@{ shape: decision }

    changes --> analyze --> lint --> ok
  end`,
    },
    {
        id: 'architecture',
        labelKey: 'workspace.mermaid_architecture',
        body: `architecture-beta
    group api(cloud)[API]

    service db(database)[Database] in api
    service disk1(disk)[Storage] in api
    service disk2(disk)[Storage] in api
    service server(server)[Server] in api

    db:L -- R:server
    disk1:T -- B:server
    disk2:T -- B:db`,
    },
    {
        id: 'cynefin',
        labelKey: 'workspace.mermaid_cynefin',
        body: `cynefin-beta
  title Incident Response

  complex
    "Investigate root cause"
    "Run chaos experiment"

  complicated
    "Analyze performance data"
    "Expert review needed"

  clear
    "Restart service"
    "Apply known fix"

  chaotic
    "Page on-call immediately"

  confusion
    "Unknown failure mode"`,
    },
    {
        id: 'ishikawa',
        labelKey: 'workspace.mermaid_ishikawa',
        body: `ishikawa-beta
    Blurry Photo
    Process
        Out of focus
        Shutter speed too slow
        Protective film not removed
        Beautification filter applied
    User
        Shaky hands
    Equipment
        LENS
            Inappropriate lens
            Damaged lens
            Dirty lens
        SENSOR
            Damaged sensor
            Dirty sensor
    Environment
        Subject moved too quickly
        Too dark`,
    },
    {
        id: 'radar',
        labelKey: 'workspace.mermaid_radar',
        body: `---
title: "Grades"
---
radar-beta
  axis m["Math"], s["Science"], e["English"]
  axis h["History"], g["Geography"], a["Art"]
  curve a["Alice"]{85, 90, 80, 70, 75, 90}
  curve b["Bob"]{70, 75, 85, 80, 90, 85}

  max 100
  min 0`,
    },
    {
        id: 'railroad',
        labelKey: 'workspace.mermaid_railroad',
        body: `railroad-ebnf-beta
title "JSON Grammar"

json = element ;
element = object | array | string | number | "true" | "false" | "null" ;
object = "{" [ member ( "," member )* ] "}" ;
array = "[" [ element ( "," element )* ] "]" ;
member = string ":" element ;`,
    },
    {
        id: 'swimlane',
        labelKey: 'workspace.mermaid_swimlane',
        body: `swimlane-beta LR
  subgraph Customer
    Browse[Browse catalogue]
    Pay[Pay]
  end
  subgraph Warehouse
    Pick[Pick items]
    Ship[Ship order]
  end
  subgraph Finance
    Invoice[Raise invoice]
  end
  Browse --> Pay
  Pay --> Pick
  Pick --> Ship
  Pay --> Invoice`,
    },
    {
        id: 'treeview',
        labelKey: 'workspace.mermaid_treeview',
        body: `treeView-beta
  project/
    this_is_a_long_filename_that_needs_to_wrap_on_a_phone.ts :::highlight ## A description that stays with the file when the layout narrows
    source/
      app.ts`,
    },
    {
        id: 'treemap',
        labelKey: 'workspace.mermaid_treemap',
        body: `treemap-beta
"Category A"
    "Item A1": 10
    "Item A2": 20
"Category B"
    "Item B1": 15
    "Item B2": 25`,
    },
    {
        id: 'usecase',
        labelKey: 'workspace.mermaid_usecase',
        body: `usecase-beta
direction LR
actor Customer("Customer")
systemBoundary "Order system"
  Checkout("Place order")
end
Customer --> Checkout`,
    },
    {
        id: 'venn',
        labelKey: 'workspace.mermaid_venn',
        body: `venn-beta
  title What makes a good feature
  set Desirable
  set Feasible
  set Viable
  union Desirable,Feasible["Buildable"]
  union Feasible,Viable["Sustainable"]
  union Desirable,Viable["Marketable"]
  union Desirable,Feasible,Viable["Ship it"]`,
    },
    {
        id: 'wardley',
        labelKey: 'workspace.mermaid_wardley',
        body: `wardley-beta
title Tea Shop Value Chain

anchor Business [0.95, 0.63]
component Cup of Tea [0.79, 0.61]
component Tea [0.63, 0.81]
component Hot Water [0.52, 0.80]
component Kettle [0.43, 0.35]
component Power [0.10, 0.70]

Business -> Cup of Tea
Cup of Tea -> Tea
Cup of Tea -> Hot Water
Hot Water -> Kettle
Kettle -> Power

evolve Kettle 0.62
evolve Power 0.89

note "Standardising power allows Kettles to evolve faster" [0.30, 0.49]`,
    },
    {
        id: 'info',
        labelKey: 'workspace.mermaid_info',
        body: `info showInfo`,
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

/**
 * The starter queries behind the toolbar's Dataview submenu. Every body is a query the parser accepts
 * and the index can answer with nothing indexed yet — an empty result, not an error — because a
 * template that inserts a block reporting itself broken is worse than no template.
 */
export const DATAVIEW_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'table',
        labelKey: 'workspace.dataview_table',
        body: 'TABLE file.mtime AS "Updated"\nSORT file.mtime DESC\nLIMIT 10',
    },
    {
        id: 'table-tagged',
        labelKey: 'workspace.dataview_tagged',
        body: 'TABLE file.folder AS "Folder", length(file.tasks) AS "Tasks"\nFROM #project\nSORT file.name',
    },
    {
        id: 'list',
        labelKey: 'workspace.dataview_list',
        body: 'LIST\nFROM -"Archive"\nSORT file.mtime DESC',
    },
    {
        id: 'task',
        labelKey: 'workspace.dataview_task',
        body: 'TASK\nWHERE !completed\nSORT due',
    },
    {
        id: 'calendar',
        labelKey: 'workspace.dataview_calendar',
        body: 'CALENDAR file.day\nFROM ""',
    },
    {
        id: 'grouped',
        labelKey: 'workspace.dataview_grouped',
        body: 'LIST\nGROUP BY file.folder',
    },
]

/** The DML starter: the shortest program that shows the `dv` object is working. */
/**
 * The starter queries behind the toolbar's Tasks submenu. Each body is an instruction set the
 * engine accepts and that answers with an empty list rather than an error while nothing is indexed,
 * because a template that inserts a block reporting itself broken is worse than no template.
 */
export const TASKS_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'open',
        labelKey: 'workspace.tasks_open',
        body: 'not done\ndue before next month\nsort by urgency',
    },
    {
        id: 'overdue',
        labelKey: 'workspace.tasks_overdue',
        body: 'not done\ndue before today\nsort by due',
    },
    {
        id: 'grouped',
        labelKey: 'workspace.tasks_by_folder',
        body: 'not done\ngroup by folder\nsort by due',
    },
]

export const DATAVIEW_JS_BODY = [
    'const pages = dv.pages("")',
    'dv.header(3, `Notes: ${pages.length}`)',
    'dv.table(["Name", "Updated"], pages.map((p) => [p.file.link, p.file.mtime]))',
].join('\n')

export const EXCALIDRAW_TEMPLATES: DiagramTemplate[] = [
    {
        id: 'blank',
        labelKey: 'common.new_drawing',
        body: JSON.stringify({
            type: 'excalidraw',
            version: 2,
            source: 'https://excalidraw.com',
            elements: [],
            appState: { viewBackgroundColor: '#ffffff', gridSize: null },
            files: {},
        }, null, 2),
    },
];

