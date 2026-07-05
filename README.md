# JIRA Relationship Visualizer & Gantt Chart

A web-based application for visualizing, managing, and scheduling JIRA issues. Two tools in one:

- **jira_viz** (port 8000): Query issues via JQL, visualize as an interactive node graph, create/modify/delete relationships via drag-and-drop
- **jira_tree** (port 8001): Build a complete linked-work-item tree from a root JQL, with Gantt chart scheduling from Blocks relationships

Both share the same backend modules and write changes back to JIRA with pre-commit review.

## Features

### Graph Visualization (both servers)
- **JQL Query**: Fetch issues from JIRA using JQL queries
- **Interactive Graph**: vis.js-based node graph with zoom, pan, and drag-and-drop
- **Relationship Management**: Create, modify, and delete issue links via drag-and-drop
- **Search**: Find issues by key or summary text with highlight navigation
- **Display Filter**: Filter nodes by field (type, status, project, assignee) with strict mode
- **Write-Back**: Commit changes to JIRA with pre-commit log review (supports field edits now too)
- **Theme Toggle**: Dark (Catppuccin Mocha) and light themes
- **Live Logging**: Real-time log panel with pasteable plain-text format
- **Keyboard Shortcuts**: Ctrl+F (find), Ctrl+L (log), Ctrl+Shift+F (filter), Delete (remove edge), Escape (close dialogs)

### Tree Traversal (jira_tree only)
- **Recursive BFS**: Start from root JQL, follow all linked work items up to configurable depth and node limits
- **Cycle Detection**: Detects and marks cycle edges; breaks cycles for Gantt rendering
- **Root/Leaf Indicators**: 🌱 for root nodes, 🔄 for cycle nodes

### Gantt Chart (jira_tree & jira_viz)
- **Blocks DAG Scheduling**: Topological sort of Blocks relationships into a time-scaled bar chart
- **Multi-Blocker Support**: Issue waits for `max(end_time of all blockers)` — handles diamond dependencies correctly
- **Inline Field Editing**: Click any bar → edit **Start Date** and **Effort** (human-readable: `3d`, `2.5w`, `4h`)
- **Assignee Utilization View**: Toggle between DAG view (by topological level) and Assignee view (one row per person); overlapping bars highlighted for overallocation
- **Data Quality Warnings**: Bars missing dates/estimates flagged with ⚠️ styling and orange borders
- **Export PNG**: Download the Gantt chart as a retina-quality PNG (via html2canvas)
- **Optimistic Editing**: Edits render immediately, then server-validate and queue for JIRA commit
- **Per-Assignee Filter**: Dropdown to show only one person's work

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   Browser (Frontend)                       │
│  vis.js network  ·  Drag-Drop  ·  Zoom  ·  Find           │
│  Filter  ·  Search  ·  Commit Review  ·  Log Panel        │
│  Gantt Chart  ·  Assignee View  ·  PNG Export  ·  Edit    │
├──────────────────────────────────────────────────────────┤
│  REST API (FastAPI) — JSON requests/responses             │
│  /api/tree  /api/gantt  /api/gantt/apply-edits            │
├──────────────────────────────────────────────────────────┤
│               Application Layer                           │
│  GraphModel · TreeBuilder · GanttBuilder                  │
│  LayoutEngine · CommitPlanner · CommitQueue               │
│  FieldEditEntry · AssigneeSummary                         │
├──────────────────────────────────────────────────────────┤
│                 Data Layer                                │
│  JIRAFetcher (jira library + REST API)                    │
│  issue links  ·  field updates (estimate, start date)     │
│  Logger (structured: file + console)                      │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.10+
- JIRA account with API access
- Browser (Chrome, Firefox, Edge)

### Installation

```bash
git clone git@github.com:kevchin/jira.git
cd jira
pip install -r requirements.txt
```

### Configuration

1. Create `JIRA_API.key` with your JIRA API token:
   ```
   your-email@example.com:your-api-token
   ```

2. Update the JIRA base URL in `jira_viz/config.py` and `jira_tree/config.py` if using a self-hosted instance:
   ```python
   JIRA_BASE_URL = "https://your-instance.atlassian.net/"
   ```

3. Configure your JIRA "Start Date" custom field ID in `jira_viz/config.py`:
   ```python
   JIRA_START_DATE_FIELD = "customfield_10015"   # Adjust to your instance
   ```

### Running

**jira_viz** (graph view, port 8000):
```bash
python -m uvicorn jira_viz.server:app --reload --port 8000
```

**jira_tree** (tree + Gantt, port 8001):
```bash
./run_tree_server.sh
# or
python -m uvicorn jira_tree.server:app --reload --port 8001
```

Open `http://localhost:8001` for the tree/Gantt view, or `http://localhost:8000` for the graph view.

## Usage

### Graph View (port 8000)
1. **Fetch Issues**: Enter a JQL query (e.g., `project = OKR AND status != Done`) and click Fetch
2. **Create Relationships**: Drag one node onto another, select a link type
3. **Search**: Use the search bar to find issues by key or summary
4. **Filter**: Use the display filter to show only matching nodes
5. **Commit**: Review changes in the commit dialog, then commit to JIRA

### Tree + Gantt View (port 8001)
1. **Fetch Tree**: Enter a root JQL (e.g., `project = OKR AND issuetype = Epic`) and click 🌳 Fetch Tree
2. **Explore**: The tree recursively follows all linked work items; adjust max depth/nodes as needed
3. **Open Gantt**: Double-click a node → Connections panel → click **📊 View Gantt**
4. **Schedule**: See the Blocks DAG as a time-scaled chart; click any bar to edit its Start Date or Effort
5. **Assignee View**: Toggle to "By Assignee" to see per-person utilization; overlapping bars highlighted
6. **Export**: Click 📥 to download the chart as PNG
7. **Commit**: Click Commit to write field edits and relationship changes back to JIRA

### Effort Input Format

| Input | Meaning | Seconds |
|-------|---------|---------|
| `3d` | 3 days (8h/day) | 86,400 |
| `2.5w` | 2.5 weeks | 360,000 |
| `4h` | 4 hours | 14,400 |
| `1d 4h` | 1 day + 4 hours | 43,200 |
| `30m` | 30 minutes | 1,800 |
| `8` | Plain number → hours | 28,800 |

## Project Structure

```
jira/
├── jira_viz/              # Shared backend package
│   ├── __init__.py
│   ├── server.py          # FastAPI app (graph view, port 8000)
│   ├── fetcher.py         # JIRA API interactions + field updates
│   ├── graph.py           # Graph model and validation
│   ├── gantt.py           # Gantt builder + effort parser + assignee summaries
│   ├── layout.py          # Force-directed layout algorithm
│   ├── models.py          # Data models (JiraIssue, Relationship)
│   ├── logger.py          # Structured logging
│   ├── config.py          # Central config (URLs, field IDs, effort constants)
│   └── warning.py         # Warning system
├── jira_tree/             # Tree server package
│   ├── __init__.py
│   ├── server.py          # FastAPI app (tree + Gantt, port 8001)
│   ├── tree_builder.py    # BFS tree traversal with cycle detection
│   └── config.py          # Tree-specific config (default JQL, depth, node limits)
├── static/                # Frontend for graph view
│   ├── index.html
│   ├── app.js
│   └── style.css
├── static_tree/           # Frontend for tree + Gantt view
│   ├── index.html
│   ├── app.js
│   └── style.css
├── gantt_design.md        # Full Gantt feature design document
├── jira_design.md         # Graph visualizer design document
├── requirements.txt       # Python dependencies
├── run_tree_server.sh     # Startup script for tree server
├── JIRA_API.key          # API credentials (not in git — .gitignored)
└── jira_viz.log          # Session log (not in git — .gitignored)
```

## Gantt Chart Design

See [gantt_design.md](gantt_design.md) for the full design document covering:

- DAG scheduling algorithm (topological sort + `max(blocker_end_times)`)
- Multi-blocker sequencing logic
- Data quality classification (missing estimate, missing start date, missing both)
- Assignee utilization view with overlap detection
- PNG export via html2canvas
- Drag-to-reschedule behavior
- Human-readable effort parser/converter
- Inline field editing with optimistic render + server validation

## Logging

All operations are logged to `jira_viz.log` or `jira_tree.log` in pasteable plain-text format:

```
2026-07-04 14:32:01  INFO   Fetching issues: project = OKR
2026-07-04 14:32:02  INFO   Fetched 9 issues, 6 relationships
2026-07-04 14:35:15  INFO   Added relationship: OKR-4 → OKR-1 (Blocks)
2026-07-04 14:35:20  ERROR  POST https://.../rest/api/2/issue/OKR-5/links
    Status: 403 Forbidden
    Action: Creating link "blocks" between OKR-5 and OKR-3
```

Paste log contents into chat for debugging assistance.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Focus search bar |
| `Ctrl+L` | Toggle log panel |
| `Ctrl+Shift+F` | Toggle display filter |
| `Delete` | Remove selected edge |
| `Escape` | Close dialogs |
| `Enter` | Apply search/filter |

## Themes

- **Dark Mode** (default): Catppuccin Mocha theme
- **Light Mode**: Softer gray tones to reduce glare

Click 🌙/☀️ button to toggle.

## Safety Features

- **Large Query Warning**: Confirmation dialog if query returns >50 issues
- **Pre-Commit Review**: Review all changes (relationships + field edits) before writing to JIRA
- **Dry Run**: Test commits without writing to JIRA
- **Validation**: Client-side checks for self-loops, invalid link types, circular dependencies
- **Data Quality Flags**: Gantt bars with missing schedule data are visually flagged (⚠️)

## Troubleshooting

### Port already in use
```bash
lsof -i :8000
lsof -i :8001
kill <PID>
```

### Authentication failed
Check `JIRA_API.key` format: `email:api-token`

### Start date field not showing in Gantt
Update `JIRA_START_DATE_FIELD` in `jira_viz/config.py` to match your JIRA instance's custom field ID

### Gantt dependency chain looks wrong
Re-fetch the tree — relationship direction is determined at fetch time

## Development

All phases are tested independently:

```bash
python test_phase0.py   # JIRA fetch + logging
python test_phase1.py   # Graph model + validation
python test_phase2.py   # FastAPI + static canvas
python test_phase3.py   # Drag-and-drop + validation
python test_phase4.py   # Search feature
python test_phase5.py   # Write-back to JIRA
python test_phase6.py   # Polish + graceful shutdown
```

Gantt-specific tests live in `jira_viz/gantt.py` (effort parser, topological sort, assignee summaries).

## License

Private project — not for distribution.

## Support

For debugging, paste log file contents into chat with description of the issue.
