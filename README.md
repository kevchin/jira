# JIRA Relationship Visualizer

A web-based application for visualizing and managing JIRA issue relationships. Query issues via JQL, visualize them as an interactive node graph, create/modify/delete relationships via drag-and-drop, and write changes back to JIRA with pre-commit review.

## Features

- **JQL Query**: Fetch issues from JIRA using JQL queries
- **Interactive Graph**: vis.js-based node graph with zoom, pan, and drag-and-drop
- **Relationship Management**: Create, modify, and delete issue links via drag-and-drop
- **Search**: Find issues by key or summary text with highlight navigation
- **Display Filter**: Filter nodes by field (type, status, project, assignee) with strict mode
- **Write-Back**: Commit changes to JIRA with pre-commit log review
- **Theme Toggle**: Dark (Catppuccin Mocha) and light themes
- **Live Logging**: Real-time log panel with pasteable plain-text format
- **Keyboard Shortcuts**: Ctrl+F (find), Ctrl+L (log), Ctrl+Shift+F (filter), Delete (remove edge), Escape (close dialogs)

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              Browser (Frontend)                       │
│  vis.js network  ·  Drag-Drop  ·  Zoom  ·  Find      │
│  Filter  ·  Search  ·  Commit Review  ·  Log Panel   │
├─────────────────────────────────────────────────────┤
│  REST API (FastAPI) — JSON requests/responses        │
├─────────────────────────────────────────────────────┤
│               Application Layer                      │
│  GraphModel · RelationshipValidator · LayoutEngine   │
│  CommitPlanner · FindEngine · LiveChangeTracker      │
├─────────────────────────────────────────────────────┤
│                 Data Layer                           │
│  JIRAFetcher (jira library)                          │
│  JIRAWriter (link create/update/delete via API)      │
│  Logger (structured: file + console)                 │
└─────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Python 3.10+
- JIRA account with API access
- Browser (Chrome, Firefox, Edge)

### Installation

```bash
cd jira
pip install -r requirements.txt
```

### Configuration

1. Create `JIRA_API.key` with your JIRA API token:
   ```
   your-email@example.com:your-api-token
   ```

2. Update the JIRA base URL in `jira_viz/server.py` if using a self-hosted instance:
   ```python
   JIRA_BASE_URL = "https://your-instance.atlassian.net/"
   ```

### Running

```bash
./run_server.sh
# or
python -m uvicorn jira_viz.server:app --reload --port 8000
```

Open `http://localhost:8000` in your browser.

## Usage

1. **Fetch Issues**: Enter a JQL query (e.g., `project = OKR AND status != Done`) and click Fetch
2. **Create Relationships**: Drag one node onto another, select a link type
3. **Search**: Use the search bar to find issues by key or summary
4. **Filter**: Use the display filter to show only matching nodes
5. **Commit**: Review changes in the commit dialog, then commit to JIRA
6. **Reload**: Click "Reload from JIRA" to sync with remote state

## Project Structure

```
jira/
├── jira_viz/              # Backend package
│   ├── __init__.py
│   ├── server.py          # FastAPI application
│   ├── fetcher.py         # JIRA API interactions
│   ├── graph.py           # Graph model and validation
│   ├── layout.py          # Force-directed layout algorithm
│   ├── models.py          # Data models
│   ├── logger.py          # Structured logging
│   └── warning.py         # Warning system
├── static/                # Frontend files
│   ├── index.html         # Single-page application
│   ├── app.js             # Frontend JavaScript
│   └── style.css          # Styling (dark + light themes)
├── requirements.txt       # Python dependencies
├── run_server.sh          # Startup script
├── JIRA_API.key          # API credentials (not in git)
└── jira_viz.log          # Session log (not in git)
```

## Logging

All operations are logged to `jira_viz.log` in pasteable plain-text format:

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
- **Pre-Commit Review**: Review all changes before writing to JIRA
- **Dry Run**: Test commits without writing to JIRA
- **Validation**: Client-side checks for self-loops, invalid link types, circular dependencies

## Troubleshooting

### Port already in use
```bash
lsof -i :8000
kill <PID>
```

### Authentication failed
Check `JIRA_API.key` format: `email:api-token`

### Canvas too bright in light mode
Already adjusted — uses `#d5d8dc` background instead of white

### Edges not visible in light mode
Edge colors automatically darken in light mode via `getLinkTypeColorLight()`

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

## License

Private project — not for distribution.

## Support

For debugging, paste `jira_viz.log` contents into chat with description of the issue.
