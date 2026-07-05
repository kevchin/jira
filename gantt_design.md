# Gantt Chart from JIRA Blocks DAG — Design Document

**Version:** 3.0 (Revised — export PNG, data-quality warnings, multi-blocker sequencing, assignee utilization view)  
**Date:** 2026-07-05  
**Status:** Design Proposal  

---

## 1. Overview

Add Gantt chart generation to both `jira_viz` and `jira_tree`. Given a set of JIRA issues connected by the **Blocks** relationship, produce a time-scaled bar chart showing when each issue should start and end, using the **Original Estimate** field (seconds) for duration and the **Start Date** field for initial positioning.

> **"If C blocks B which blocks A, we want to see a visual representation of the length of time from the start date of A, then the Original Estimate for length of that line to the start date of B (if defined) and if B does not have a start date, we start immediately after A is finished."**

### 1.1 Core Rules

| Rule | Description |
|------|-------------|
| Duration | Each issue's bar length = `original_estimate` (seconds). If missing, default to 1 day (28,800 s = 8 h). |
| Start position | If the issue has `start_date`, anchor there. Otherwise, start = latest end time of all **blocking** issues. |
| End position | `start + original_estimate` |
| Root issues | If an issue has no blockers, it starts at its `start_date` (or `now` if no date). |
| Ordering | Topological sort of the Blocks DAG → rows from roots to leaves. |
| Inline editing | Click any bar to select it → edit its **Start Date** and **Effort** (human-readable: `3d`, `2.5w`, `4h`). Changes optimistically re-render the Gantt and are queued for commit to JIRA. |
| Data quality | Bars missing **both** `start_date` and `original_estimate` are flagged with ⚠️ styling (orange dashed border + warning icon). Root issues with neither field anchor to today + 8h default; non-root issues inherit from blockers. |
| Multi-blocker | An issue blocked by **multiple** parents starts at `max(end_time of all blockers)`. See §4.7 for examples. |

### 1.2 Examples

**Linear chain:**
```
A (start_date=Jul 1, est=2d)          ████████░░
                                            ↓ blocks
B (start_date=Jul 3, est=1d)              ████░░
                                            ↓ blocks
C (no start_date, est=3d)                    ████████████░░
                                            ↑ starts right after B ends
```

**Branching & merging (multi-blocker):**
```
A (Jul 1, 3d)        ████████████░░
                           ↓ blocks
B (Jul 4, 2d)            ████████░░          ← starts after A
                           ↓ blocks
                     ┌────────┐
D (no date, 1d)      │        ████░░          ← starts after max(B, C) = Jul 6
                     └────────┘
C (Jul 2, 4d)       ████████████████░░
                           ↓ blocks (also blocks D)
```
D is blocked by both B (ends Jul 6) and C (ends Jul 6). D starts Jul 6 = max(Jul 6, Jul 6). If B had been 3d (ending Jul 7), D would start Jul 7. This is the `max(blocker end times)` rule — the issue cannot start until **all** its blockers have finished.

### 1.3 Effort Input Format (Human-Readable)

Effort is stored as seconds in JIRA (`timeoriginalestimate`) but users enter it in natural shorthand:

| Input | Meaning | Seconds |
|-------|---------|---------|
| `3d` | 3 days | 86,400 |
| `2.5w` | 2.5 weeks | 360,000 |
| `4h` | 4 hours | 14,400 |
| `1d 4h` | 1 day + 4 hours | 43,200 |
| `30m` | 30 minutes | 1,800 |
| `8` | Plain number → hours | 28,800 |

**Conversion constants** (configurable in `jira_viz/config.py`):
- 1 week = 5 days = 40 hours = 144,000 s
- 1 day = 8 hours = 28,800 s
- 1 hour = 3,600 s
- 1 minute = 60 s

**Display format:** The Gantt bar label shows both — e.g. `OKR-10 (3d)` where `3d` is the rounded human form. The edit field shows the current value parsed back to human-readable format and accepts new input the same way.

### 1.4 Data Quality Warnings

Bars are visually flagged when critical scheduling data is missing:

| Condition | Warning | Bar Style |
|-----------|---------|-----------|
| Missing **both** `start_date` and `original_estimate` | `"⚠️ OKR-7: no start date and no estimate — defaulting to 1d"` | Orange dashed border, ⚠️ icon in label |
| Missing only `original_estimate` | `"⚠️ OKR-9: no estimate — defaulting to 8h"` | Thin amber left-border stripe |
| Missing only `start_date` (non-root) | `"ℹ️ OKR-12: no start date — derived from blockers"` | Hatched/striped fill pattern |
| Missing only `start_date` (root) | `"⚠️ OKR-1: root issue with no start date — anchored to today"` | Orange left-border stripe |

**API response enrichment:** The `/api/gantt` response includes a `warnings` array and a `data_quality` summary:

```json
{
  "data_quality": {
    "total": 12,
    "complete": 7,
    "missing_estimate": 2,
    "missing_start_date": 3,
    "missing_both": 1,
    "defaulted_total_hours": 40
  }
}
```

This lets the frontend show a compact quality badge in the Gantt dialog header, e.g. `"⚠️ 5/12 issues have missing data"`.

---

## 2. Where the Feature Lives

### 2.1 Entry Point: Connections Panel

The Connections panel (opened by double-clicking a node) already has VIEW and ADD sections. A new **"Gantt"** button is added:

```
┌─────────────────────────────────────────┐
│ 🔗 OKR-10                          [✕]  │
├─────────────────────────────────────────┤
│ VIEW                                     │
│ [Show All Related]  [Direct Connections] │
│ [📊 View Gantt]                          │  ← NEW
├─────────────────────────────────────────┤
│ ADD                                      │
│ [+ Add Connection]  [+ Add Multiple]     │
├─────────────────────────────────────────┤
│ Connections list ...                     │
└─────────────────────────────────────────┘
```

Clicking **"View Gantt"** builds a Gantt chart for the DAG rooted at (or containing) the selected node using **Blocks** relationships only.

The Gantt dialog itself has its own **EDIT** section for modifying fields on selected bars (see §5.3).

### 2.2 Global Gantt (Header Button)

A header button **"📊 Gantt"** near the Commit/Theme buttons generates a Gantt for the **entire visible tree/filtered node set**.

### 2.3 View Toggle: DAG vs. Assignee

Inside the Gantt dialog, a **view toggle** switches between two layouts:

```
┌──────────────────────────────────────────────────┐
│ 📊 Gantt — OKR-10 + 7 issues    [Blocks ▾] [✕]   │
│                                                  │
│  View:  ● DAG (by blockers)  ○ By Assignee       │  ← toggle
│                                                  │
│  [DAG chart shown here — rows by topological     │
│   level, as described in §5.3]                    │
└──────────────────────────────────────────────────┘
```

**DAG view (default):** Rows ordered by topological level — shows the dependency chain from roots to leaves. Same as current design.

**Assignee view:** Rows ordered by assignee name. Each assignee gets one row. Their issues are placed on a shared timeline. Overlapping bars for the same assignee indicate overallocation and are tinted red. An unassigned row collects issues with no assignee. A summary footer shows per-assignee hours and conflict count.

When toggling to Assignee view, the frontend calls the same `/api/gantt` endpoint with `?view=assignee`. The backend returns bars grouped by assignee with overlap detection metadata.

### 2.4 Per-Assignee Filter

A dropdown in the Gantt dialog filters to a single assignee:

```
Assignee: [All ▾]  (Kevin Chin, Alice, Bob, Unassigned)
```

Selecting "Kevin Chin" shows only Kevin's bars in both DAG and Assignee views. This works as a filter on the already-computed Gantt data — no additional API call.

---

## 3. Data Model Changes

### 3.1 `JiraIssue` — Two New Fields

```python
@dataclass
class JiraIssue:
    # ... existing fields ...
    original_estimate: Optional[int] = None   # seconds (JIRA field: timeoriginalestimate)
    start_date: Optional[str] = None           # ISO date string (JIRA custom field)
```

### 3.2 GanttBar — New Frontend/Backend Model

```python
@dataclass
class GanttBar:
    key: str                    # e.g. "OKR-10"
    summary: str                # truncated label
    assignee: Optional[str]     # display name or None
    start: str                  # ISO datetime "2026-07-01T00:00:00"
    end: str                    # ISO datetime "2026-07-03T16:00:00"
    duration_hours: float       # for display
    level: int                  # row position (0 = root, deeper = higher)
    blockers: List[str]         # keys that block this issue
    has_start_date: bool        # whether start_date was explicitly set
    has_estimate: bool          # whether original_estimate was explicitly set
    original_estimate_seconds: Optional[int]  # raw value for edit display
    effort_display: str         # human-readable: "3d", "2.5w", etc.
    data_quality: str           # "complete", "missing_estimate", "missing_start_date", "missing_both"
```

### 3.3 AssigneeSummary — Per-Assignee Stats

```python
@dataclass
class AssigneeSummary:
    assignee: str               # display name or "Unassigned"
    issue_count: int
    total_hours: float
    overlapping_pairs: int      # count of overlapping bar pairs (overallocation)
    bar_keys: List[str]         # keys belonging to this assignee
```

### 3.4 FieldEditEntry — New Commit Queue Entry Type

Extends the existing commit queue to support field edits alongside relationship CRUD:

```python
@dataclass
class FieldEditEntry:
    issue_key: str              # e.g. "OKR-10"
    field_name: str             # "start_date" or "original_estimate"
    old_value: Optional[str]    # previous value (for undo/display)
    new_value: str              # new value
    display_name: str           # "Start Date" or "Effort"
    action: str                 # always "edit_field"
```

This appears in the commit queue alongside `CommitEntry` (create/delete relationship). The commit dialog groups field edits separately from relationship changes.

### 3.5 API Response Shape

```json
{
  "bars": [
    {
      "key": "OKR-1",
      "summary": "Define Q3 OKRs",
      "assignee": "Kevin Chin",
      "start": "2026-07-01T00:00:00",
      "end": "2026-07-02T12:00:00",
      "duration_hours": 12.0,
      "level": 0,
      "blockers": [],
      "has_start_date": true,
      "has_estimate": true,
      "effort_display": "1.5d",
      "data_quality": "complete"
    }
  ],
  "total_duration_hours": 120.5,
  "warnings": ["OKR-7 missing original_estimate, defaulted to 8h"],
  "data_quality": {
    "total": 12,
    "complete": 7,
    "missing_estimate": 2,
    "missing_start_date": 3,
    "missing_both": 1
  },
  "assignee_summaries": [
    {"assignee": "Kevin Chin", "issue_count": 4, "total_hours": 28, "overlapping_pairs": 1, "bar_keys": ["OKR-1","OKR-4","OKR-7"]},
    {"assignee": "Unassigned", "issue_count": 3, "total_hours": 16, "overlapping_pairs": 0, "bar_keys": ["OKR-5","OKR-9"]}
  ]
}
```

---

## 4. Backend: Gantt Computation

### 4.1 New Endpoint

```
GET /api/gantt?keys=OKR-1,OKR-4,OKR-7,OKR-10&focus_key=OKR-10
POST /api/gantt   (body: {keys: [...], focus_key: "..."})
```

If `keys` is omitted, uses the full active tree.

### 4.2 GanttBuilder Class (New File)

```
jira_viz/
  gantt.py          ← NEW MODULE
```

#### Algorithm: `build_gantt(issues, relationships)`

```
1. FILTER: Keep only relationships where link_type.lower() == "blocks"
2. BUILD adjacency:
     blockers[key] = {set of keys that block this issue}
     blocks[key]   = {set of keys this issue blocks}
3. TOPOLOGICAL SORT (Kahn's algorithm):
     - Roots: issues with no blockers
     - If cycles exist, break arbitrarily + warn
4. ASSIGN TIMES (in topological order):
     For each issue in sorted order:
       a. proposed_start = issue.start_date OR None
       b. earliest_from_blockers = max(end_time of all blockers) if any blockers else None
          ↑ This is the key multi-blocker rule: the issue starts no earlier than
            the latest-finishing blocker. If 3 issues block D (ending Jul 3, Jul 5, Jul 4),
            D starts Jul 5.
       c. actual_start:
            if proposed_start AND earliest_from_blockers:
              start = max(proposed_start, earliest_from_blockers)
            elif proposed_start:
              start = proposed_start
            elif earliest_from_blockers:
              start = earliest_from_blockers
            else:
              start = TODAY (anchor root)
       d. duration = issue.original_estimate OR DEFAULT (28800s / 8h)
       e. end = start + duration
5. ASSIGN DATA QUALITY FLAGS:
     For each bar:
       - has_estimate = (original_estimate is not None)
       - has_start_date = (start_date is not None)
       - data_quality = classify(has_estimate, has_start_date)
       - If "missing_both": add ⚠️ warning
6. ASSIGN LEVELS:
     - Greedy scan: assign each bar the lowest level where it doesn't overlap
       with bars already placed at that level.
     - This ensures no overlapping bars.
7. COMPUTE ASSIGNEE SUMMARIES:
     - Group bars by assignee (None → "Unassigned")
     - For each assignee, detect overlapping bar pairs (overallocation)
     - Compute total_hours per assignee
8. RETURN {bars, warnings, data_quality, assignee_summaries}
```

#### Default Values

| Fallback | Value |
|----------|-------|
| Missing `original_estimate` | **28,800 s** (8 hours / 1 working day) |
| Missing `start_date` on root | **Today at 09:00** |
| Working hours assumption | 8 h/day, Mon-Fri (configurable later) |

### 4.3 Fetcher Changes

The fetcher must now include `timeoriginalestimate` and a start-date field when querying JIRA.

**JIRA field names:**
- `timeoriginalestimate` — built-in field (seconds)
- Start date: depends on instance. Common custom fields:
  - `customfield_10015` (common in JIRA Cloud)
  - We'll make this **configurable** via `jira_viz/config.py`

**In `fetch_issues()`:**
```python
fields = "summary,issuetype,status,priority,assignee,project,timeoriginalestimate,customfield_10015"
```

**In `_fetch_single_issue()` (tree builder):**
```python
# Same field expansion for single-issue fetches
```

**In `config.py`:**
```python
JIRA_START_DATE_FIELD = "customfield_10015"   # Adjust to your instance
```

### 4.4 Effort Parser (Backend)

A Python-side effort parser mirrors the JS one for validation:

```python
# jira_viz/gantt.py

def parse_effort_to_seconds(input_str: str) -> Optional[int]:
    """Parse human-readable effort string to seconds.
    
    Examples: '3d'→86400, '2.5w'→360000, '4h'→14400,
              '1d 4h'→43200, '30m'→1800, '8'→28800
    Returns None if unparseable.
    """
    ...

def format_seconds_to_effort(seconds: int) -> str:
    """Format seconds to human-readable: 86400→'3d', 360000→'2.5w'"""
    ...
```

### 4.5 Field Edit Endpoint

```
POST /api/gantt/apply-edits
Body: {
  "edits": [
    {"issue_key": "OKR-10", "field": "start_date", "value": "2026-07-05"},
    {"issue_key": "OKR-10", "field": "original_estimate", "value": "172800"}
  ]
}

Response: {
  "applied": 2,
  "warnings": [],
  "updated_bars": [...]   // re-computed Gantt bars after edits
}
```

This endpoint:
1. Validates each edit (field exists, value is well-formed)
2. Updates the in-memory `JiraIssue` objects
3. Queues `FieldEditEntry` items in the commit queue
4. Re-runs Gantt computation with the updated values
5. Returns the new bar positions

**Why a separate endpoint?** The frontend could optimistically re-render, but calling this endpoint ensures consistency — especially for cascading changes where editing one bar's duration shifts all dependent bars. The frontend uses the returned `updated_bars` to refresh the chart.

### 4.6 Fetcher — Field Update Method

New method on `JIRAFetcher` for writing field values back to JIRA:

```python
def update_issue_field(self, issue_key: str, field_name: str, value) -> dict:
    """
    Update a single field on a JIRA issue.
    
    Args:
        issue_key: e.g. 'OKR-10'
        field_name: 'start_date' (maps to customfield_10015) 
                    or 'original_estimate' (maps to timeoriginalestimate)
        value: string for start_date, int (seconds) for original_estimate
    
    Returns: {'success': bool, 'status': int, 'response': str}
    """
    field_map = {
        'start_date': config.JIRA_START_DATE_FIELD,
        'original_estimate': 'timeoriginalestimate',
    }
    jira_field = field_map[field_name]
    
    import requests as req_lib
    url = f"{self.server}rest/api/2/issue/{issue_key}"
    payload = {"fields": {jira_field: value}}
    response = req_lib.put(url, json=payload, ...)
    ...
```

### 4.7 Multi-Blocker Sequencing Logic

When an issue has multiple blockers, the Gantt must respect all of them. The rule is simple and deterministic:

> **An issue starts at `max(end_time of all its blockers)`.**

**Example — diamond dependency:**

```
        ┌── B (Jul 1, 2d) end=Jul 3 ──┐
A (Jul 1, 1d)                        D → max(Jul 3, Jul 4) = Jul 4
        └── C (Jul 1, 3d) end=Jul 4 ──┘
```

Both B and C block D. D waits for the later one (C, ending Jul 4).

**Example — staggered starts:**

```
A (Jul 1, 5d) end=Jul 6
B (Jul 3, 2d) end=Jul 5            ┐
C (Jul 2, 3d) end=Jul 5            ├── D starts Jul 6 = max(6, 5, 5)
                                    ┘
```

D is blocked by A, B, and C. Even though B and C finish earlier (Jul 5), D waits for A (Jul 6).

**What if a blocker has no estimate?** It gets the default 8h. The `max()` still applies.

**What if a blocker has a start_date but no estimate?** Its end = start_date + 8h. The `max()` includes it.

**What if ALL blockers AND the issue itself lack dates/estimates?** The issue is data-quality flagged as `missing_both`, anchored to the latest blocker end (which may itself be default-anchored), with a 8h default duration. The warning explains the chain of defaults.

### 4.8 Assignee Utilization Endpoint

The `/api/gantt` endpoint accepts an optional `view` parameter:

```
GET /api/gantt?keys=...&view=assignee
GET /api/gantt?keys=...&view=dag        (default)
GET /api/gantt?keys=...&view=assignee&assignee=Kevin%20Chin
```

**`view=dag` (default):** Returns bars with `level` computed via greedy non-overlap (topological).

**`view=assignee`:** Returns bars with `level` replaced by an assignee-based row index:
- Assignees are sorted alphabetically (Unassigned last)
- Each assignee occupies one row
- All bars for that assignee sit on that row, color-coded by issue type
- `assignee_level` field replaces `level` in the response
- Overlapping bar pairs for the same assignee are flagged:
  ```json
  {
    "bar": { ... },
    "overlaps_with": ["OKR-5", "OKR-9"],
    "overlap_hours": 4.5
  }
  ```

**`assignee` filter:** When an assignee name is provided, only bars for that assignee are returned (in both DAG and assignee views). This filters server-side for efficiency.

**Assignee summary** is always included in the response regardless of view mode. The frontend renders a summary footer table:

```
┌──────────────────────────────────────────────────────────┐
│ Assignee          Issues   Hours   Conflicts             │
│ ─────────         ──────   ─────   ─────────             │
│ Kevin Chin        4        32h     ⚠️ 1 (OKR-1↔OKR-7)    │
│ Alice             2        16h     —                     │
│ Unassigned        2        8h      —                     │
├──────────────────────────────────────────────────────────┤
│ Total             8        56h     1 conflict             │
└──────────────────────────────────────────────────────────┘
```

---

## 5. Frontend: Gantt Rendering

### 5.1 Approach: vis-timeline (Recommended)

Since `vis.js` is already in use, **vis-timeline** (CDN) is the natural choice:

| Pro | Con |
|-----|-----|
| Same API style as vis-network | Adds ~80 KB (gzipped ~25 KB) |
| Built-in zoom, pan, tooltips | One more `<script>` tag |
| Time axis with auto-scaling | |
| Clickable bars for navigation | |
| Dependency arrows between bars | |

**CDN link:**
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis-timeline-graph2d.min.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/vis/4.21.0/vis-timeline-graph2d.min.css">
```

### 5.2 Alternative: Pure HTML/CSS Bars in a Dialog

If avoiding an extra dependency is preferred:

| Pro | Con |
|-----|-----|
| Zero dependencies | No zoom, no pan, no interactivity |
| Full control over styling | Must implement all layout manually |
| Catppuccin theme matches exactly | Harder to add dependency arrows |

Both work. **vis-timeline is recommended** for a production-quality UX.

### 5.3 Gantt Dialog UI (with EDIT section, view toggle, export)

```
┌──────────────────────────────────────────────────────────┐
│ 📊 Gantt — OKR-10 + 7 issues  ⚠️3  [Blocks ▾] [✕] [📥]  │  ← 📥 = Export PNG
├──────────────────────────────────────────────────────────┤
│  View: ● DAG  ○ By Assignee   Assignee: [All ▾]          │  ← toggles + filter
│                                                          │
│  Jul 1      Jul 3      Jul 5      Jul 7     Jul 9        │  ← time axis
│  ──┬─────────┬─────────┬─────────┬─────────┬──────       │
│    │                                 │                   │
│  A │█████████████████████████████████│                   │  ← row 0 (root)
│    │               │                 │                   │
│  B │               │█████████████████│                   │  ← row 1
│    │               │█████████████████│                   │
│  C │               │                 │███████████████│   │  ← row 1 (parallel to B)
│    │               │        │        │███████████████│   │
│  D⚠│               │        │══╪══╪══│                   │  ← row 2 SELECTED + ⚠️ no data
│    │               │        │══╪══╪══│                   │
│                                                          │
│  Legend: ██ = has data  ═══ = selected  ⚠️ = missing both│
│          ··· = derived start  ░░ = has start_date        │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ EDIT — OKR-10 (selected)                                 │
│                                                          │
│  Start Date:  [2026-07-01      ]  📅                     │
│  (current: 2026-07-01 — explicitly set)                  │
│                                                          │
│  Effort:      [3d               ]                        │
│  (current: 3d = 86,400 s = 24 hours)                     │
│  Formats: 3d | 2.5w | 4h | 30m | 1d 4h | 8 (=hours)    │
│                                                          │
│  [Apply]  [Reset]                                        │
├──────────────────────────────────────────────────────────┤
│ Assignee Summary:        Kevin: 32h ⚠️1 | Alice: 16h     │
│ Queue: 1 field change · ⚠️ 3 bars missing data           │
│                                          [Close] [Commit]│
└──────────────────────────────────────────────────────────┘
```

**Header bar additions:**
- **⚠️3 badge**: Shows count of bars with data quality issues. Clickable → scrolls to first flagged bar.
- **[Blocks ▾]**: Dropdown to filter which link types are considered for the DAG (default: Blocks only, can add "is blocked by" for reverse direction).
- **[📥]**: Export PNG button (see §5.6).

**View toggle behavior:**
- Switching to "By Assignee" re-groups bars by assignee row (see §5.7). The EDIT section remains functional and targets the same selected bar.
- Switching back to "DAG" restores the topological row layout.
- The toggle is instant (no API call) if data already loaded; re-fetches only if `view` parameter changes.

**Interaction flow:**
1. Click a bar → bar highlights (gold border), EDIT section populates with that issue's current values
2. Change Start Date via date picker or clear it (sets to "derive from blockers")
3. Change Effort by typing e.g. `5d` or `2.5w` → parsed to seconds on Apply
4. **Apply** → updates local issue data, re-renders Gantt immediately (optimistic), queues `FieldEditEntry` for commit
5. **Reset** → discards unsaved edits in the form
6. The Gantt re-computes with the new value — all dependent bars shift accordingly
7. Click **Commit** → opens the standard commit review dialog, which now shows field edits alongside relationship changes

**Validation on Apply:**
- Effort field: must parse successfully (show error tooltip if not)
- Start Date: must be a valid date or empty (empty = "use blocker-based derivation")
- If both are empty on a root issue → warn "will anchor to today"

### 5.4 JavaScript Flow

```javascript
// static/app.js and static_tree/app.js

let ganttSelectedBar = null;       // currently selected bar key
let ganttPendingEdits = new Map();  // key → {start_date, original_estimate}

async function showGanttForNode(nodeId) {
    const reachable = collectBlocksDag(nodeId);
    const resp = await apiPost("/api/gantt", {
        keys: Array.from(reachable),
        focus_key: nodeId
    });
    ganttSelectedBar = null;
    ganttPendingEdits.clear();
    openGanttDialog(resp.bars, resp.warnings);
}

function openGanttDialog(bars, warnings) {
    // Render Gantt chart (vis-timeline or custom HTML)
    // Each bar is clickable → onBarClick(key)
}

function onBarClick(key) {
    // Highlight bar, populate EDIT section
    ganttSelectedBar = key;
    const bar = findBar(key);
    document.getElementById("gantt-edit-key").textContent = key;
    document.getElementById("gantt-start-date").value = bar.start_date || "";
    document.getElementById("gantt-effort").value = bar.effort_display || "";
    // Show current-value readouts
    document.getElementById("gantt-edit-section").style.display = "block";
}

function applyGanttEdit() {
    const key = ganttSelectedBar;
    const newStart = document.getElementById("gantt-start-date").value;
    const effortRaw = document.getElementById("gantt-effort").value.trim();

    // Parse effort
    const effortSeconds = parseEffort(effortRaw);
    if (effortRaw && effortSeconds === null) {
        showGanttError("Invalid effort format. Use: 3d, 2.5w, 4h, 1d 4h, 30m");
        return;
    }

    // Store pending edit
    ganttPendingEdits.set(key, {
        start_date: newStart || null,
        original_estimate: effortSeconds
    });

    // Optimistic re-render: update local issue data
    if (newStart) issues.find(i => i.key === key).start_date = newStart;
    if (effortSeconds) issues.find(i => i.key === key).original_estimate = effortSeconds;

    // Re-compute & re-render Gantt
    refreshGanttChart();

    // Queue for commit
    ganttCommitQueue.push({ issue_key: key, field: "start_date", ... });
    if (effortSeconds) ganttCommitQueue.push({ issue_key: key, field: "original_estimate", ... });

    updateGanttCommitBadge();
}

// ── Human-readable effort parser ──────────────────────────
function parseEffort(input) {
    if (!input) return null;
    // Regex: optional number + unit (w/d/h/m)
    const regex = /(\d+\.?\d*)\s*(w|wk|weeks?|d|days?|h|hr|hrs?|hours?|m|min|mins?|minutes?)\b/gi;
    let total = 0;
    let match;
    let found = false;
    while ((match = regex.exec(input)) !== null) {
        const val = parseFloat(match[1]);
        const unit = match[2].toLowerCase()[0];  // first char: w/d/h/m
        const multipliers = { w: 144000, d: 28800, h: 3600, m: 60 };
        total += val * (multipliers[unit] || 0);
        found = true;
    }
    if (!found) {
        // Plain number → assume hours
        const plain = parseFloat(input);
        if (!isNaN(plain)) return Math.round(plain * 3600);
        return null;
    }
    return Math.round(total);
}

function formatEffort(seconds) {
    if (!seconds) return "—";
    if (seconds >= 144000 && seconds % 144000 === 0) return (seconds / 144000) + "w";
    if (seconds >= 28800 && seconds % 28800 === 0) return (seconds / 28800) + "d";
    if (seconds >= 3600 && seconds % 3600 === 0) return (seconds / 3600) + "h";
    if (seconds % 60 === 0) return (seconds / 60) + "m";
    return (seconds / 3600).toFixed(1) + "h";
}
```

### 5.5 Bar Styling

- **Color**: Same per-issue-type colors as the node graph (Epic = purple, Story = green, etc.)
- **Label**: `KEY — summary (truncated) — (3d)` with effort in parens
- **Has explicit start_date**: Solid fill
- **Derived start (no start_date)**: Hatched/striped fill pattern (CSS: `repeating-linear-gradient`)
- **Missing estimate**: Thin amber left-border stripe
- **Missing BOTH start_date and estimate**: Orange dashed border (2px) + ⚠️ icon prepended to label
- **Hover tooltip**: Full summary, dates, estimate, blockers, data quality info
- **Click**: Select bar → populate EDIT section; double-click → focus node in main graph
- **Assignee view only**: Overlapping bars for same assignee get a red tint overlay (rgba red 0.15)

### 5.6 Export PNG

An **Export PNG** button (📥) in the Gantt dialog header captures the current chart view as a PNG image.

**Implementation:**

| Approach | How |
|----------|-----|
| **html2canvas** (recommended for custom HTML) | Capture the Gantt container `<div>` as a canvas, then `canvas.toBlob()` → download. Lightweight (~30 KB), works with any DOM. |
| **vis-timeline built-in** | If using vis-timeline, it has no native PNG export. Use html2canvas on the timeline container. |

**Flow:**
```javascript
async function exportGanttPNG() {
    const container = document.getElementById("gantt-chart-area");
    const canvas = await html2canvas(container, {
        backgroundColor: "#1e1e2e",   // match Catppuccin Mocha
        scale: 2,                       // retina quality
    });
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `gantt-${focusKey}-${new Date().toISOString().slice(0,10)}.png`;
        a.click();
        URL.revokeObjectURL(url);
    });
}
```

**CDN dependency:** `html2canvas` (optional — only loaded when export is triggered, via dynamic import or a small inline script).

**What's captured:** The visible chart area (time axis + bars + labels), legend, and the assignee summary footer. The EDIT section is excluded.

### 5.7 Assignee View Rendering

When toggled to "By Assignee", the chart re-renders with rows grouped by assignee:

```
┌──────────────────────────────────────────────────────────┐
│ 📊 Gantt — OKR-10 + 7 issues  ⚠️3  [By Assignee] [✕][📥]│
├──────────────────────────────────────────────────────────┤
│  View: ○ DAG  ● By Assignee   Assignee: [All ▾]          │
│                                                          │
│  Jul 1      Jul 3      Jul 5      Jul 7     Jul 9        │
│  ──┬─────────┬─────────┬─────────┬─────────┬──────       │
│    │                                 │                   │
│  K │█████████████████████████████████│                   │  ← Kevin Chin
│  e │               │█████████████████│                   │
│  v │               │█████████████████│                   │  ← ⚠️ overlap with above
│  i │               │                 │                   │
│  n │               │                 │███████████████│   │
│  ──┤               │                 │███████████████│   │
│  A │               │        │████████│                   │  ← Alice
│  l │               │        │████████│                   │
│  i │               │        │        │                   │
│  c │               │        │        │                   │
│  e │               │        │        │                   │
│  ──┤               │        │        │                   │
│  — │               │        │        │████████│          │  ← Unassigned
│    │               │        │        │████████│          │
│                                                          │
│  ██ = Kevin (4)  ██ = Alice (2)  ██ = Unassigned (1)    │
│  Red tint = overlapping (overallocated)                  │
└──────────────────────────────────────────────────────────┘
```

**Assignee color coding:**
- Each assignee gets a distinct row background tint (subtle, alternating)
- Bar colors still reflect issue type (so you can see Epics vs Stories within an assignee's row)
- Overlapping bars for the same assignee get a red tint overlay (rgba red 0.15) with a ⚠️ icon in the bar label
- The assignee summary footer highlights conflicting assignees in amber

**Assignee filter dropdown:**
- "All" shows all assignees
- Selecting a specific person filters to only show their bars
- When filtered, only that person's row is shown, and the summary still shows totals for context

### 5.8 Drag-to-Reschedule

Bars are directly manipulable by dragging. Three distinct gestures produce three different field edits:

```
        ←─── drag middle ───→          ←─ drag left edge ─→    drag right edge ─→
        (move whole bar)               (change start + duration)  (change duration)

  before:  |████████████|              |    ████████████|        |████████████    |
  after:       |████████████|          |████████████████|        |████████████████|

  start:   later  ↕                   earlier ↕                fixed
  end:     later  ↕                   fixed                    later  ↕
  duration: fixed                     longer ↕                 longer ↕
```

#### Gesture → Field Mapping

| Gesture | Mouse cursor | What changes | JIRA field(s) written |
|---------|-------------|-------------|----------------------|
| **Drag right edge** | `↔` (east-west resize) | Duration | `Original Estimate` |
| **Drag middle** (bar body) | `↔` (move) | Start Date | `Start Date` |
| **Drag left edge** | `↔` (west-east resize) | Start Date **+** Duration | Both fields |

#### Constraints During Drag

| Constraint | Behavior |
|-----------|----------|
| **Blockers (DAG view)** | A bar cannot be dragged earlier than `max(end_time of all blockers)`. If the user drags past this boundary, the bar snaps to the constraint line with a red flash. |
| **Minimum duration** | Bars cannot shrink below 1 hour (configurable). |
| **Day snapping** | Holding `Shift` snaps drag deltas to whole-day increments (8h for edges, midnight boundaries for start dates). |
| **Weekend awareness** | If working-hours calendar is enabled (Phase 4), the snap grid skips weekends. |
| **Assignee view** | Same constraints apply. In assignee view, dragging a bar's start date may introduce or resolve overlaps — the red tint updates live. |

#### Visual Feedback During Drag

1. **Ghost bar**: The original position remains as a translucent outline.
2. **Active bar**: Moves with the cursor, slightly translucent.
3. **Tooltip**: Shows the proposed new values in real time:
   ```
   OKR-10: Jul 5 → Jul 8  (3d)
   Start: Jul 5 · End: Jul 8 · Duration: 3d
   ```
4. **Constraint line**: If the bar hits a blocker boundary, a red dashed vertical line appears at the earliest allowed start with the label `"blocked until Jul 6 (OKR-4)"`.
5. **Cascade preview**: Dependent bars (those blocked by the dragged bar) show as ghosted outlines at their projected new positions.

#### On Drop — Commit Flow

```javascript
function onBarDrop(barKey, newStart, newEnd) {
    const bar = findBar(barKey);
    const oldStart = bar.start;
    const oldEnd = bar.end;
    const oldDuration = bar.original_estimate_seconds;

    // Determine what changed
    const startChanged = newStart !== oldStart;
    const durationChanged = (newEnd - newStart) !== oldDuration;

    // 1. Optimistic update
    if (startChanged) updateIssueField(barKey, "start_date", newStart);
    if (durationChanged) updateIssueField(barKey, "original_estimate", newEnd - newStart);

    // 2. Recompute & re-render (cascade dependent bars)
    refreshGanttChart();

    // 3. Queue edits for commit
    if (startChanged) queueFieldEdit(barKey, "start_date", oldStart, newStart);
    if (durationChanged) queueFieldEdit(barKey, "original_estimate", oldDuration, newEnd - newStart);

    // 4. Server-validate
    apiPost("/api/gantt/apply-edits", { edits: buildEditsPayload() })
        .then(resp => refreshGanttFromServer(resp.updated_bars))
        .catch(err => { revertBar(barKey, oldStart, oldEnd); showError(err); });
}
```

#### Drag Undo

Each drag operation is pushed onto an undo stack. `Ctrl+Z` reverts the last drag (restoring the previous start/end and removing the queued field edit). The undo stack is per-session and cleared when the dialog closes.

#### Interaction with Explicit vs. Derived Dates

- If a bar had an **explicit** `start_date` and the user drags the middle, the new start date is written. The bar stays "explicit."
- If a bar had a **derived** `start_date` (no explicit date, positioned by blocker end), dragging the middle **promotes** it to explicit — the dragged position becomes the new `start_date`, and the bar's styling changes from hatched to solid fill.

---

## 6. Implementation Plan

### Phase 1: Backend — GanttBuilder + Parsers + API

| Step | File | Description |
|------|------|-------------|
| 1a | `jira_viz/models.py` | Add `original_estimate`, `start_date`, `assignee` to `JiraIssue` |
| 1b | `jira_viz/config.py` | Add `JIRA_START_DATE_FIELD`, effort conversion constants |
| 1c | `jira_viz/fetcher.py` | Expand `fetch_issues()` fields + add `update_issue_field()` method |
| 1d | `jira_tree/tree_builder.py` | Expand `_fetch_single_issue()` fields (include assignee) |
| 1e | `jira_viz/gantt.py` | **NEW** — `GanttBuilder` + `parse_effort_to_seconds()` + `format_seconds_to_effort()` + data quality classifier + assignee summary |
| 1f | `jira_viz/server.py` | Add `/api/gantt` (GET/POST, `?view=dag|assignee`, `?assignee=`) + `/api/gantt/apply-edits` POST |
| 1g | `jira_tree/server.py` | Add same endpoints |
| 1h | `jira_viz/server.py` | Extend `CommitQueue`/`CommitPlanner` to handle `FieldEditEntry` |
| 1i | `jira_tree/server.py` | Same commit queue extension |

### Phase 2: Frontend — Connections Panel + Gantt Dialog Shell

| Step | File | Description |
|------|------|-------------|
| 2a | `static/index.html` | Add "📊 View Gantt" button + `<div id="gantt-dialog">` + html2canvas CDN |
| 2b | `static_tree/index.html` | Same |
| 2c | `static/app.js` | Add `showGanttForNode()` + `collectBlocksDag()` + dialog open/close |
| 2d | `static_tree/app.js` | Same |

### Phase 3: Frontend — Gantt Rendering + EDIT + Export + Assignee View

| Step | File | Description |
|------|------|-------------|
| 3a | `static/index.html` | Vis-timeline CDN + EDIT section + view toggle + assignee dropdown + summary footer HTML |
| 3b | `static_tree/index.html` | Same |
| 3c | `static/app.js` | `renderGanttChart()` + `onBarClick()` + EDIT form + `applyGanttEdit()` + `parseEffort()` + `formatEffort()` + `exportGanttPNG()` + `toggleGanttView()` + assignee filter + **drag-to-reschedule handlers** |
| 3d | `static_tree/app.js` | Same |
| 3e | `static/app.js` | `ganttCommitQueue` management + commit dialog integration |
| 3f | `static_tree/app.js` | Same |

### Phase 4: Polish

| Step | Description |
|------|-------------|
| 4a | Add "📊 Gantt" global header button (generates Gantt for entire visible set) |
| 4b | Bar click → focus corresponding node in main graph canvas |
| 4c | Commit review dialog shows field edits grouped separately from relationship edits |
| 4d | Working-hours-aware time axis (skip weekends, configurable) |
| 4e | Dependency arrows between bars |
| 4f | Color legend for issue types |
| 4g | Undo last edit (per-bar Reset button in EDIT section) |
| 4h | Data quality badge in dialog header — clickable, scrolls to first flagged bar |
| 4i | Assignee conflict highlighting polish (red tint, ⚠️ icons, tooltip explains overlap) |

---

## 7. Key Design Decisions

### 7.1 Why Only "Blocks"?

- The "Blocks" relationship carries scheduling semantics — A blocks B means B cannot start until A finishes.
- "Relates", "Clones", "Duplicates" don't imply temporal ordering.
- The user explicitly requested the Blocks-based DAG.

### 7.2 What About Cycles?

Cycles in a Blocks DAG are semantically invalid (A blocks B blocks A ⇒ deadlock), but JIRA allows them. The GanttBuilder:
1. Detects cycles during topological sort
2. Breaks an arbitrary edge in each cycle to linearize
3. Warns: `"⚠️ Cycle detected: OKR-4 ↔ OKR-7 — broke OKR-7 → OKR-4"`

### 7.3 Where Does the Gantt Open?

**Modal dialog** (overlay) centered over the canvas:
- Non-intrusive: doesn't rearrange the layout
- Easy to close and return to graph
- Can be large (80% viewport width/height) for complex DAGs
- Shares the Catppuccin-Mocha theme
- Contains the Gantt chart (top 65%) and EDIT section (bottom 35%), separated by a divider

### 7.4 Gantt Data Source

The Gantt reuses the **already-fetched tree/graph data** (issues + relationships in memory). No additional JIRA calls needed unless the user's tree was filtered. The backend endpoint accepts a list of keys to allow filtered subsets.

### 7.5 Editing Flow — Optimistic + Server-Validated

Edits work in two passes:
1. **Optimistic (frontend):** On Apply, the frontend updates the local issue object and re-renders the Gantt immediately. The bar shifts in real time.
2. **Server-validated (POST /api/gantt/apply-edits):** The edit is sent to the backend, which validates it, updates the in-memory model, re-computes the full Gantt (to catch cascading effects), and returns updated bars. The frontend refreshes from this authoritative response. If validation fails, the error is shown and the bar reverts.

This avoids flicker while ensuring the cascade (e.g., extending A's duration pushes B and C right) is computed correctly.

### 7.6 Commit Queue Integration

Field edits (`FieldEditEntry`) coexist with relationship edits (`CommitEntry`) in the same queue. The commit dialog shows them in two grouped tables:

```
┌─────────────────────────────────────────┐
│ Commit Changes              [Cancel] [Commit] │
├─────────────────────────────────────────┤
│ Field Edits (3):                        │
│   ✏️ OKR-10 Start Date → 2026-07-05     │
│   ✏️ OKR-12 Effort → 5d                 │
│   ✏️ OKR-7  Start Date → (cleared)      │
│                                         │
│ Relationship Changes (1):               │
│   + Add: OKR-4 → OKR-10 (Blocks)        │
│                                         │
│ [🔍 Dry Run]                            │
└─────────────────────────────────────────┘
```

On commit, field edits call `fetcher.update_issue_field()` and relationship edits call the existing create/delete methods.

### 7.7 Why Human-Readable Effort?

JIRA stores `timeoriginalestimate` in seconds (e.g., 28800 for 1 day). Direct second-entry is error-prone. The shorthand `3d`, `2.5w`, `4h` matches how JIRA itself displays estimates. The parser handles fractional values (`2.5w`), multi-unit strings (`1d 4h`), and plain-number-as-hours fallback (`8`).

### 7.8 Multi-Blocker Rule: `max(blocker_end_times)`

An issue blocked by N parents starts at the latest end time among them. This is the only logically sound rule: the issue cannot begin until **every** blocker is done. The alternative (earliest blocker, or average) would violate the "blocks" contract. Example: if B ends Jul 3 and C ends Jul 5, D blocked by both B and C starts Jul 5.

### 7.9 Data Quality: Flag, Don't Block

Missing `start_date` or `original_estimate` never prevents rendering. The Gantt defaults to reasonable values (8h, today at 09:00) and flags the bar visually. This keeps the chart useful while surfacing data gaps. The warnings and data-quality summary help users identify which JIRA issues need attention.

### 7.10 Assignee View: One Row Per Person

The assignee view answers "who is overloaded?" by placing all of a person's work on a single timeline row. Overlapping bars are the primary signal — they indicate the person is expected to work on two things simultaneously. The red tint + conflict count makes this instantly visible without reading a report.

### 7.11 Export PNG: html2canvas

html2canvas captures the rendered DOM as a PNG. It's loaded on demand (not bundled in the main page) to avoid bloating load time. The export button only appears when the Gantt dialog is open. The PNG matches the Catppuccin Mocha theme and includes the legend and summary footer.

---

## 8. File Change Summary

| File | Action | Est. Lines |
|------|--------|-------|
| `jira_viz/models.py` | Edit — +3 fields on `JiraIssue` | +5 |
| `jira_viz/config.py` | Edit — +start date field ID + effort constants | +6 |
| `jira_viz/fetcher.py` | Edit — expand fields + `update_issue_field()` | +45 |
| `jira_viz/gantt.py` | **NEW** — GanttBuilder + parsers + data quality + assignee summaries | ~200 |
| `jira_viz/server.py` | Edit — 2 endpoints + commit queue extension | +70 |
| `jira_tree/tree_builder.py` | Edit — expand single-issue field list | +8 |
| `jira_tree/server.py` | Edit — 2 endpoints + commit queue extension | +70 |
| `static/index.html` | Edit — Gantt button + dialog HTML + CDN scripts + view toggle + assignee dropdown | +80 |
| `static_tree/index.html` | Edit — same | +80 |
| `static/app.js` | Edit — Gantt functions + parser + EDIT + export + assignee + **drag** + commit | ~450 |
| `static_tree/app.js` | Edit — same | ~450 |
| `tests/test_gantt.py` | **NEW** — unit tests | ~170 |

**Total:** ~1,614 lines across 12 files.

---

## 9. Testing

### 9.1 Unit Tests

```python
# tests/test_gantt.py (new)
def test_topological_sort_linear_chain(): ...
def test_topological_sort_diamond(): ...
def test_topological_sort_multiple_blockers(): ...  # NEW
def test_cycle_detection_and_break(): ...
def test_missing_estimate_fallback(): ...
def test_missing_start_date_root_anchor(): ...
def test_missing_both_fields_data_quality_flag(): ...  # NEW
def test_start_date_overrides_blocker_end(): ...
def test_blocker_end_overrides_start_date(): ...
def test_max_of_multiple_blockers(): ...  # NEW
def test_level_assignment_no_overlap(): ...
def test_empty_set_returns_empty(): ...
def test_single_issue_no_blockers(): ...
def test_assignee_summary_grouping(): ...  # NEW
def test_assignee_overlap_detection(): ...  # NEW
def test_assignee_view_row_assignment(): ...  # NEW
```

### 9.2 Manual Integration Test

1. Fetch tree: `project = OKR AND issuetype = Epic`
2. Double-click an Epic with Blocks relationships → Connections panel opens
3. Click "📊 View Gantt" → Gantt dialog appears in DAG view
4. Verify bars are ordered by topological level, colored by issue type
5. **Check multi-blocker:** Find an issue blocked by multiple parents → verify it starts at max(parent end times)
6. **Check data quality:** Find a bar with ⚠️ orange border → verify it has neither date nor estimate
7. **Click bar OKR-10** → EDIT section populates
8. **Change Effort** to `5d` → Apply → bar stretches, dependent bars shift right
9. **Toggle to Assignee view** → bars re-group by person; overlapping bars tinted red
10. **Filter assignee** to "Kevin Chin" → only Kevin's bars shown
11. **Check assignee summary** footer → verify hour totals and conflict counts
12. **Export PNG** → click 📥 → PNG downloads; open it to verify
13. Verify commit queue badge updates with field edit count
14. Close dialog → graph restored

### 9.3 Effort Parser Test Cases

```python
def test_parse_effort():
    assert parse_effort_to_seconds("3d") == 86400
    assert parse_effort_to_seconds("2.5w") == 360000
    assert parse_effort_to_seconds("4h") == 14400
    assert parse_effort_to_seconds("30m") == 1800
    assert parse_effort_to_seconds("1d 4h") == 43200
    assert parse_effort_to_seconds("8") == 28800
    assert parse_effort_to_seconds("abc") is None
    assert parse_effort_to_seconds("") is None

def test_format_effort():
    assert format_seconds_to_effort(86400) == "3d"
    assert format_seconds_to_effort(360000) == "2.5w"
    assert format_seconds_to_effort(14400) == "4h"
    assert format_seconds_to_effort(43200) == "1.5d"
```

---

## 10. Future Enhancements

- [ ] **Working-hours calendar**: 8h/day, skip weekends, respect holidays
- [ ] **Milestone markers**: Special styling for issues with fixed dates
- [ ] **Critical path highlighting**: Longest path through the DAG
- [ ] **Bulk edit mode**: Select multiple bars and apply same effort/date change
- [ ] **SVG export**: Vector export in addition to PNG
- [ ] **Multi-select entry**: Generate Gantt for multiple selected nodes
- [ ] **Undo stack**: Undo/redo for Gantt edits (currently per-bar Reset only)
- [ ] **Assignee workload histogram**: Bar chart of hours per assignee over time
- [ ] **Sprint/version overlay**: Vertical bands showing sprint boundaries on the time axis

---

**End of Design Document**
