# JIRA Relationship Visualizer — Design Document

**Version:** 1.0  
**Date:** 2026-07-04  
**Status:** Production Ready  

---

## 1. System Overview

The JIRA Relationship Visualizer is a web-based application that provides an interactive graph view of JIRA issues and their relationships. Users can query issues via JQL, visualize them as a node graph, create/modify/delete relationships through drag-and-drop, and write changes back to JIRA with pre-commit review.

### 1.1 Core Capabilities

| Capability | Description |
|------------|-------------|
| Issue Query | Fetch issues from JIRA via JQL with configurable max_results |
| Graph Visualization | vis.js-based interactive node graph with zoom, pan, drag |
| Relationship Creation | Drag-and-drop nodes to create issue links |
| Relationship Editing | Right-click edges to change type or delete |
| Search | Find issues by key fragment or summary text |
| Display Filter | Filter nodes by field with strict mode (matches only) |
| Write-Back | Commit relationships to JIRA with pre-commit review |
| Theme Toggle | Dark (Catppuccin Mocha) and light themes |
| Live Logging | Real-time log panel with pasteable plain-text format |

---

## 2. Architecture

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     Browser (Frontend)                        │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ vis.js      │  │ Search     │  │ Display Filter       │  │
│  │ Network     │  │ Bar        │  │ Panel                │  │
│  │             │  │            │  │                      │  │
│  │ - Nodes     │  │ - Input    │  │ - Field dropdown     │  │
│  │ - Edges     │  │ - Apply    │  │ - Value dropdown     │  │
│  │ - Physics   │  │ - Strict   │  │ - Apply/Clear        │  │
│  │ - Zoom/Pan  │  │ - Navigate │  │                      │  │
│  └─────────────┘  └────────────┘  └──────────────────────┘  │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ Log Panel   │  │ Commit     │  │ Connections Panel    │  │
│  │             │  │ Review     │  │                      │  │
│  │ - Live log  │  │ Dialog     │  │ - Relationship list  │  │
│  │ - Auto-refresh│ │ - Dry run  │  │ - Focus button       │  │
│  │ - Toggle    │  │ - Confirm  │  │ - JIRA URL links     │  │
│  └─────────────┘  └────────────┘  └──────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  FastAPI REST API                             │
│  GET  /          │ HTML page                                  │
│  GET  /api/issues│ JQL query execution                        │
│  GET  /api/layout│ Computed positions                         │
│  GET  /api/search│ Text search                                │
│  POST /api/relationships│ Add relationship                    │
│  DELETE /api/relationships│ Delete relationship               │
│  GET  /api/relationships/{key}│ Get relationships for node    │
│  POST /api/validate│ Client-side validation                  │
│  GET  /api/commit-queue│ Pending changes                      │
│  GET  /api/commit-plan│ Review before commit                 │
│  GET|POST /api/commit│ Execute commit (with dry_run)          │
│  GET  /log         │ Session log tail                        │
├──────────────────────────────────────────────────────────────┤
│                  Application Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ GraphModel   │  │ CommitPlanner│  │ LayoutEngine     │  │
│  │              │  │              │  │                  │  │
│  │ - Issues     │  │ - Build plan │  │ - Fruchterman-   │  │
│  │ - Relationships│ │ - Validate   │  │   Reingold       │  │
│  │ - Search     │  │ - Dry run    │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ CommitQueue  │  │ WarningSystem│                        │
│  │              │  │              │                        │
│  │ - Pending    │  │ - Self-loops │                        │
│  │ - Live log   │  │ - Cycles     │                        │
│  │ - Dedup      │  │ - Types      │                        │
│  └──────────────┘  └──────────────┘                        │
├──────────────────────────────────────────────────────────────┤
│                  Data Layer                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ JIRAFetcher  │  │ JIRAWriter   │  │ Logger           │  │
│  │              │  │              │  │                  │  │
│  │ - fetch_issues│ │ - create_link│  │ - File handler   │  │
│  │ - fetch_links│  │ - delete_link│  │ - Console handler│  │
│  │ - link_types │  │              │  │ - Pasteable format│  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│                  JIRA REST API                                │
│  /rest/api/2/issue           │ Issue data                    │
│  /rest/api/2/issueLinkType   │ Link types                    │
│  /rest/api/2/issue/{key}/links│ Issue links                  │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
User enters JQL → FastAPI → JIRAFetcher.fetch_issues()
                          → JIRAFetcher.fetch_issue_links() for each issue
                          → GraphModel.add_issue() + add_relationship()
                          → Return JSON: {issues, relationships, count}

User drags node → vis.js dragStart/dragEnd events
                → Frontend validation (self-loop, type check)
                → POST /api/relationships
                → CommitQueue.add()
                → Live log entry
                → Update commit queue badge

User clicks Commit → GET /api/commit-plan
                   → Display review dialog with validation status
                   → POST /api/commit?dry_run=false
                   → CommitPlanner.execute()
                   → JIRAWriter.create_issue_link() / delete_issue_link()
                   → Update CommitQueue
                   → Show result dialog
```

---

## 3. Data Models

### 3.1 JiraIssue

```python
@dataclass
class JiraIssue:
    key: str                    # e.g., "OKR-1"
    summary: str                # Truncated to ~60 chars in UI
    issue_type: str             # Epic, Story, Task, Bug, Key Result
    status: str                 # To Do, In Progress, Done
    priority: Optional[str]     # High, Medium, Low
    assignee: Optional[str]     # Display name
    project: Optional[str]      # e.g., "OKR", "SNOW"
    self_url: Optional[str]     # JIRA REST URL
    jira_web_url: Optional[str] # e.g., https://.../browse/OKR-1
```

### 3.2 Relationship

```python
@dataclass
class Relationship:
    source: JiraIssue    # Source issue (the one initiating the link)
    target: JiraIssue    # Target issue (the one receiving the link)
    link_type: str       # e.g., "Blocks", "Relates", "Cloners"
```

### 3.3 GraphModel

```python
class GraphModel:
    _issues: Dict[str, JiraIssue]    # key → issue
    _relationships: List[Relationship]
    _link_types_allowed: List[str]   # Discovered from JIRA
    logger: Optional[Logger]
    
    def add_issue(issue: JiraIssue)
    def add_relationship(rel: Relationship)
    def search(query: str) -> List[dict]
    def validate() -> List[Warning]
    def save(path: Path)
    def load(path: Path) -> GraphModel
```

### 3.4 CommitQueue

```python
class CommitQueue:
    _pending: List[CommitEntry]
    _live_log: List[str]
    
    def add(entry: CommitEntry)
    def remove(entry: CommitEntry)
    def edit(old: CommitEntry, new: CommitEntry)
    def clear()
```

### 3.5 CommitEntry

```python
@dataclass
class CommitEntry:
    source_key: str
    target_key: str
    link_type: str
    action: str       # "add" or "delete"
    validation_status: str  # "ok", "warning", "error"
    validation_message: str
```

---

## 4. UI Layout

### 4.1 Header (3 Rows)

```
┌─────────────────────────────────────────────────────────────┐
│ jira_viz                                                     │
├─────────────────────────────────────────────────────────────┤
│ JQL Query: [project = OKR AND status != Done ORDER BY key]  │
│          [Fetch] [Layout] [9 issues]                         │
├─────────────────────────────────────────────────────────────┤
│ Search: [Breaches_______] [Apply] [✓]Strict [Clear] [◀] [▶] │
│ Filter: [Filter:] [Project ▼] [OKR ▼] [✓]Strict [Apply]     │
├─────────────────────────────────────────────────────────────┤
│ [Link types badge] [Commit queue badge] [Commit] [Reload]   │
│ [📷] [🌙] [📋] [🔍]                                          │
└─────────────────────────────────────────────────────────────┘
```

**Row 1: JQL Query** — Full width, primary data source
**Row 2: Search + Filter** — Side by side, 40/60 split
**Row 3: Controls** — Actions and status indicators

### 4.2 Main Content Area

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   vis.js Network Canvas (flex: 1)                           │
│                                                             │
│   - Nodes: Rounded rectangles with key + summary            │
│   - Edges: Directed arrows, colored by link type            │
│   - Interactions: Zoom, pan, drag, double-click             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│   Log Panel (360px, toggleable)                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Log [total]  [Clear] [✓ Auto-refresh]                │   │
│   ├─────────────────────────────────────────────────────┤   │
│   │ 2026-07-04 14:32:01  INFO   Fetched 9 issues        │   │
│   │ 2026-07-04 14:35:15  INFO   Added: OKR-4 → OKR-1    │   │
│   │ ...                                                   │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 Connections Panel (Right Side)

Appears when double-clicking a node:

```
┌─────────────────────────────────────────┐
│ OKR-1 Connections              [✕]      │
├─────────────────────────────────────────┤
│ Incoming (sorted by type, then key):    │
│ ┌─────────────────────────────────────┐ │
│ │ Blocks   OKR-4 → OKR-1  [×]         │ │
│ │ Blocks   OKR-7 → OKR-1  [×]         │ │
│ └─────────────────────────────────────┘ │
│ Outgoing:                               │
│ ┌─────────────────────────────────────┐ │
│ │ Relates  OKR-1 → OKR-2  [×]         │ │
│ └─────────────────────────────────────┘ │
│ [Focus on connected nodes]              │
└─────────────────────────────────────────┘
```

- Issue keys are clickable JIRA URLs
- Relationships sorted by type, then source key
- Delete button (×) on each relationship
- "Focus" button highlights connected subgraph

### 4.4 Commit Review Dialog

```
┌─────────────────────────────────────────┐
│ Commit Changes              [Cancel] [Commit] │
├─────────────────────────────────────────┤
│ 3 operations pending:                   │
│                                         │
│ ✓ Add: OKR-4 → OKR-1 (Blocks)           │
│ ✓ Add: OKR-5 → OKR-1 (Problem/Incident) │
│ ⚠️ Delete: OKR-2 → OKR-3 (Relates)      │
│                                         │
│ Validation:                             │
│   ✓ Add: OKR-4 → OKR-1 (Blocks) — ok   │
│   ✓ Add: OKR-5 → OKR-1 (Problem/Incident) │
│   ⚠️ Delete: OKR-2 → OKR-3 (Relates) —  │
│      relationship exists                │
│                                         │
│ [🔍 Dry Run]                            │
│                                         │
│ Live Log:                               │
│   INFO: User added OKR-4 → OKR-1        │
│   INFO: User added OKR-5 → OKR-1        │
└─────────────────────────────────────────┘
```

---

## 5. Interaction Design

### 5.1 Drag-and-Drop Relationship Creation

```
1. User drags node A onto node B
2. vis.js dragEnd event fires
3. Frontend shows relationship type selection dialog
4. User selects type (e.g., "Blocks")
5. Frontend validates:
   - Self-loop check
   - Link type validity
   - Cycle detection
6. If valid: POST /api/relationships
7. If invalid: Show warning, do not send
8. CommitQueue updated
9. Live log entry created
```

### 5.2 Double-Click Node

```
1. User double-clicks node OKR-1
2. Connections panel opens
3. Shows all incoming and outgoing relationships
4. Relationships sorted by type, then source key
5. Issue keys are clickable JIRA URLs
6. "Focus on connected nodes" button available
7. Click relationship → focus on connected node
8. Click ✕ → close panel, restore full graph
```

### 5.3 Search with Strict Mode

```
1. User types "Breaches" in search bar
2. User checks "Strict" checkbox
3. User clicks "Apply" (or presses Enter)
4. performFind() called with strict=true
5. Backend returns matches via /api/search
6. Frontend highlights matches (red background, bold text)
7. If strict: hide all non-matching nodes
8. If not strict: show matches + their connections
9. Status message shows mode: "(strict: matches only)"
10. Navigate with ◀/▶ buttons
```

### 5.4 Display Filter

```
1. User selects field (e.g., "Project") and value (e.g., "OKR")
2. User may check "Strict" for matches-only mode
3. User clicks "Apply"
4. Frontend filters nodes by field value
5. If strict: only matching nodes visible
6. If not strict: matching nodes + transitive closure
7. Auto-zooms to fit visible subgraph
8. Status message shows mode and count
```

### 5.5 Commit Workflow

```
1. User clicks "Commit" button
2. Commit dialog opens with pending operations
3. Each operation shows validation status (✓ ok, ⚠️ warning, ⚡ error)
4. User reviews the plan
5. Optional: Click "🔍 Dry Run" to test without writing
6. Click "Commit" to execute
7. Backend sends batch commit to JIRA
8. Result dialog shows success/failure for each operation
9. Successful operations removed from CommitQueue
10. Failed operations logged with HTTP error details
```

---

## 6. Theming

### 6.1 Dark Theme (Catppuccin Mocha)

| Element | Color |
|---------|-------|
| Background | `#1e1e2e` |
| Header | `#11111b` |
| Nodes | Type-colored backgrounds |
| Edges | Bright colors (red, blue, purple, green, orange, teal) |
| Text | `#cdd6f4` |
| Log panel | `#181825` |

### 6.2 Light Theme

| Element | Color |
|---------|-------|
| Background | `#d5d8dc` |
| Header | `#d5d8dc` |
| Nodes | Type-colored backgrounds (same as dark) |
| Edges | Darker colors (deeper red, blue, purple, etc.) |
| Text | `#3c3f46` |
| Log panel | `#d5d8dc` |

**Edge color mapping (light mode):**
- Blocks: `#e74c3c` → `#c0392b`
- Relates: `#3498db` → `#2980b9`
- Duplicates: `#9b59b6` → `#8e44ad`
- Clones: `#2ecc71` → `#27ae60`
- Requires: `#f39c12` → `#d68910`
- Causes: `#1abc9c` → `#16a085`

---

## 7. Search and Filter Behavior

### 7.1 Search

- **Input**: Text field with Apply button
- **Modes**: Normal (matches + connections), Strict (matches only)
- **Highlighting**: Red background (#ff6b6b) with white bold text
- **Current match**: Gold background (#ffd700) with black bold text, 8px gold border
- **Text highlight**: Matched text in summary highlighted with yellow background
- **Navigation**: ◀/▶ buttons, Focus button for current match
- **Keyboard**: Ctrl+F to focus, Enter to apply

### 7.2 Display Filter

- **Fields**: Issue Type, Status, Project, Assignee
- **Values**: Auto-populated from current JQL query results
- **Modes**: Normal (matches + transitive closure), Strict (matches only)
- **Transitive closure**: Shows matching nodes AND all their connections
- **Auto-zoom**: Fits visible subgraph with 30% scale reduction and 80px margin
- **Keyboard**: Ctrl+Shift+F to toggle

---

## 8. Logging System

### 8.1 Log Format

Plain-text, pasteable format for debugging:

```
2026-07-04 14:32:01  INFO   Fetching issues: project = OKR
2026-07-04 14:32:02  INFO   Fetched 9 issues, 6 relationships
2026-07-04 14:35:15  INFO   Added relationship: OKR-4 → OKR-1 (Blocks)
2026-07-04 14:35:20  ERROR  POST https://company.atlassian.net/rest/api/2/issue/OKR-5/links
    Status: 403 Forbidden
    Action: Creating link "blocks" between OKR-5 and OKR-3
    Response: {"errorMessages":["You do not have permission to create issue links of type 'blocks'."]}
    Context: User dragged OKR-5 onto OKR-3, selected "blocks", clicked Commit
```

### 8.2 Log Destinations

1. **File**: `jira_viz.log` (persistent, pasteable)
2. **Console**: Standard output (development)
3. **UI Panel**: Live log panel in browser (auto-refresh toggle)
4. **Commit Dialog**: Live log in commit review dialog

### 8.3 Log Levels

| Level | Color (dark) | Color (light) | Use Case |
|-------|--------------|---------------|----------|
| DEBUG | `#6c7086` | `#4c4f69` | Internal details |
| INFO | `#a6adc8` | `#4c4f69` | Normal operations |
| WARN | `#f9e2af` | `#df8d42` | Non-critical issues |
| ERROR | `#f38ba8` | `#d74242` | Failures requiring attention |

---

## 9. Validation Rules

### 9.1 Client-Side (Immediate)

| Rule | Severity | Description |
|------|----------|-------------|
| Self-loop | ERROR | Node cannot link to itself |
| Invalid link type | ERROR | Type not in discovered JIRA link types |
| Circular dependency | WARNING | A → B → C → A chain detected |
| Relationship exists | WARNING | Link already exists between pair |

### 9.2 Server-Side (Commit)

| Rule | Severity | Description |
|------|----------|-------------|
| Permission denied | ERROR | 403 from JIRA API |
| Link type rejected | ERROR | JIRA rejects the link type |
| Rate limiting | WARNING | 429 from JIRA API |
| Network error | ERROR | Connection timeout or failure |

---

## 10. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Focus search bar |
| `Ctrl+L` | Toggle log panel |
| `Ctrl+Shift+F` | Toggle display filter panel |
| `Delete` | Remove selected edge |
| `Escape` | Close dialogs |
| `Enter` | Apply search/filter |

---

## 11. Deployment Considerations

### 11.1 Single-User Desktop

- FastAPI runs on `localhost:8000`
- No authentication required (local access only)
- JIRA API key stored in `JIRA_API.key`

### 11.2 Multi-User (Future)

- Add user authentication (OAuth2 with JIRA)
- Separate graphs per user
- Rate limiting per user
- HTTPS for production

### 11.3 Self-Hosted JIRA

- Update `JIRA_BASE_URL` in `server.py`
- Adjust API endpoints if using JIRA Server vs Cloud
- Handle SSL certificates if self-signed

---

## 12. Future Enhancements

- [ ] Batch operations (multiple relationship changes at once)
- [ ] Graph export (PNG, SVG, JSON)
- [ ] Custom node shapes based on issue type
- [ ] Edge routing improvements for complex graphs
- [ ] Real-time collaboration (WebSocket)
- [ ] Issue comment integration
- [ ] Suggested relationships based on patterns
- [ ] Performance optimization for 100+ nodes
- [ ] Mobile responsive design
- [ ] Plugin system for custom validators

---

## 13. Testing Strategy

All phases are independently testable:

```bash
python test_phase0.py   # JIRA fetch + logging (5 tests)
python test_phase1.py   # Graph model + validation (4 tests)
python test_phase2.py   # FastAPI + static canvas (5 tests)
python test_phase3.py   # Drag-and-drop + validation (7 tests)
python test_phase4.py   # Search feature (5 tests)
python test_phase5.py   # Write-back to JIRA (6 tests)
python test_phase6.py   # Polish + graceful shutdown (2 tests)
```

**Total:** 34 tests, all passing.

---

## 14. Known Limitations

1. **Node count**: Recommended max 50 nodes for optimal performance
2. **Layout**: Force-directed layout may not produce ideal results for all graph shapes
3. **Edge labels**: May overlap for dense graphs
4. **Mobile**: Not optimized for mobile devices
5. **Real-time**: No WebSocket support for live collaboration
6. **Autocomplete**: Search does not autocomplete issue keys

---

## 15. Appendix: Link Type Colors

| Link Type | Dark Mode | Light Mode |
|-----------|-----------|------------|
| Blocks | `#e74c3c` (Red) | `#c0392b` (Deep Red) |
| Relates | `#3498db` (Blue) | `#2980b9` (Deep Blue) |
| Duplicates | `#9b59b6` (Purple) | `#8e44ad` (Deep Purple) |
| Clones | `#2ecc71` (Green) | `#27ae60` (Deep Green) |
| Requires | `#f39c12` (Orange) | `#d68910` (Deep Orange) |
| Causes | `#1abc9c` (Teal) | `#16a085` (Deep Teal) |
| Other | `#95a5a6` (Gray) | `#7f8c8d` (Deep Gray) |

---

**End of Design Document**
