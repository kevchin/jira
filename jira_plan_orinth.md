# JIRA Relationship Visualizer — Project Plan

**Status:** Draft v2 — updated per review  
**Date:** 2026-07-04  
**Stack:** Python (FastAPI backend), `jira` library (`pip install jira`), API token, HTML5 + JS (frontend, served from `/static/`)  

---

## 1. Overview

A web-based application that lets you:

1. **Query** JIRA issues via a JQL query.
2. **Visualise** them as a node graph on an interactive canvas.
3. **Drag and drop** to create, modify, and delete relationships (child links) between issues.
4. **Search** (find) issue keys or text within the visible result set.
5. **Zoom** in/out of the canvas.
6. **Validate** relationships with warnings for impermissible combinations.
7. **Write back** committed relationships to JIRA, with a pre-commit log review step.
8. **Warn** on impermissible relationships and failed write-backs.
9. **Log** all JIRA HTTP errors with full context (method, URL, status code, response body) so the session log is pasteable for debugging.

---

## 2. Answers to Clarifying Questions

The following are **resolved** based on your feedback.

### 2.1. UI Framework — **Web-based** ✓

**Decision:** FastAPI backend + HTML5 frontend served from `/static/`. Use **vis.js** (`vis-network`) for graph rendering, drag-and-drop, zoom, and layout.

**Rationale:** Richest drag-and-drop, browser-native zoom, easy to iterate on styling, no native GUI toolkit to learn. vis.js handles node/edge rendering, force-layout, zoom, and drag-and-drop out of the box.

### 2.2. Relationship types — **Discover + Allow All** ✓

**Decision:** On application start, query JIRA's REST API for the list of available issue link types (`/rest/api/2/issueLinkType`). Present those to the user as the selectable set. Warn if a user attempts a link type that JIRA does not recognise or is not permitted in their project/permission context.

- All discovered link types are **allowed**.
- Relationships are **directed** (A → B) — matching your example.
- Multiple link types between the same pair are **permitted** (e.g. both "blocks" and "relates" on the same pair).

### 2.3. Persistence — **Write-back to JIRA** ✓

**Decision:** Relationships are **committed back to JIRA** as real issue links. The local graph state is a working view, not a standalone annotation.

- Changes are written to JIRA via the API after a **pre-commit log review**.
- The tool does **not** maintain a separate local JSON save/load for graph state (local persistence is secondary to JIRA as the source of truth).
- A "sync reload" button re-fetches from JIRA to merge remote changes.

### 2.4. Warnings — **Impermissible + Failed Commits** ✓

**Decision:** Two warning tiers:

1. **Pre-validation warnings** (client-side): shown immediately on the canvas when a user attempts an impermissible operation:
   - Self-loops (A → A)
   - Link type not in the discovered JIRA link type set
   - Circular dependency chains (A → B → C → A)
   - Link type restrictions (e.g. a type that JIRA marks as invalid for the given issue types)
2. **Post-commit failure warnings**: shown when a write-back to JIRA fails:
   - HTTP error from JIRA API (4xx / 5xx)
   - Permission denied
   - Link type rejected by server
   - Rate limiting

Both tiers are logged to `jira_viz.log` and displayed in a live log panel in the UI.

### 2.5. Displayed information per node

**Decision:**

- JIRA key (`PROJ-123`) — prominent
- Summary / title — **truncated to ~60 characters** (elided with `…` if longer; full text available on hover/tooltip)
- Status (colour-coded background or badge)
- Issue type icon (bug/story/task/epic)
- Assignee name (small text)
- **No priority badge** (removed per feedback)

### 2.6. Initial layout algorithm

**Decision:** Force-directed graph (Fruchterman-Reingold). Simple, handles arbitrary graph shapes, works well for ~50 nodes.

### 2.7. Find/search behaviour

**Decision:**

- Highlight matching nodes
- Zoom + pan to first match
- Cycle through matches (Next / Previous)
- Search by **key fragment** and **issue key substring** (e.g. `'Z'` or `'Z-123'`)
- Search by **issue summary / title text** (also)

### 2.8. Running environment

**Confirmed:** Linux desktop with a browser available. FastAPI runs on `localhost:8000`. No headless mode needed for v1.

---

## 3. Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Browser (Frontend)                          │
│  vis.js network  ·  Drag-Drop  ·  Zoom  ·  Find             │
│  Live Log Panel  ·  Commit Queue Panel                      │
├─────────────────────────────────────────────────────────────┤
│  REST API (FastAPI) — JSON requests/responses               │
├─────────────────────────────────────────────────────────────┤
│               Application Layer                              │
│  GraphModel · RelationshipValidator · LayoutEngine          │
│  CommitPlanner · FindEngine · LiveChangeTracker             │
├─────────────────────────────────────────────────────────────┤
│                 Data Layer                                   │
│  JIRAFetcher (jira library)                                 │
│  JIRAWriter (link create/update/delete via API)             │
│  Logger (structured: file + console)                        │
└─────────────────────────────────────────────────────────────┘
```

- **Browser (Frontend):** vis.js graph rendering, drag-and-drop, zoom, find, double-click, live log panel, commit queue panel.
- **FastAPI REST layer:** Thin JSON API — receives requests, delegates to application layer, returns results.
- **Application Layer:** Graph model, validation, force-directed layout, commit planning (builds a log of what will be written), find logic, live change tracker.
- **Data Layer:** Fetches issues from JIRA, writes/updates/deletes links via JIRA REST API, logs everything.

---

## 4. Phases

### Phase 0 — Logging & JIRA Fetcher (NO UI)

**Goal:** Prove you can fetch and work with issues without touching the GUI.

| Task | Details |
|------|---------|
| JQL query executor | Takes JQL + API key → returns list of issues with key, summary, type, status, priority, assignee |
| Issue data class | `JiraIssue` dataclass with all relevant fields |
| Structured logger | `logging` module with file + console handlers; log every fetch, every operation, every error |
| HTTP error logging | Any JIRA API HTTP error (4xx/5xx) logged with full context: method, URL, status code, response body snippet, and what action triggered it |
| Relationship data class | `Relationship(source, target, type, direction)` |
| Manual relationship builder | In a Python script, you can create relationships between fetched issues manually |
| Graceful shutdown (Phase 0) | `try / except KeyboardInterrupt` with `finally` to flush logs and close JIRA connection |

**Test approach:**
```python
# test_phase0.py
issues = fetch_issues("project = PROJ AND status != Done")
for iss in issues:
    log.info(f"Fetched: {iss.key} — {iss.summary}")

# Create relationships manually
r1 = Relationship(issues[2], issues[1], type="blocks", direction="source_to_target")
r2 = Relationship(issues[1], issues[0], type="relates", direction="source_to_target")
log.info(f"Created {len(r1)} relationships")
```

**Deliverable:** A CLI script that fetches issues, prints them, and lets you define relationships in code. Full log output to `jira_viz.log`.

---

### Phase 1 — Graph Model & Validation (NO UI)

**Goal:** Pure Python graph with validation logic, still no GUI.

| Task | Details |
|------|---------|
| `GraphModel` class | Holds `Set[JiraIssue]` and `List[Relationship]` |
| Validation rules | Self-loops, duplicate links, circular dependencies, impermissible type combos |
| Warning system | `List[Warning]` — each with severity (info / warning / error) and message |
| JSON serialise/deserialise | Save/load graph state to/from JSON |
| Force-directed layout engine (Python) | Compute (x, y) positions for each node; return as `List[Point]` |

**Test approach:**
```python
# test_phase1.py
graph = GraphModel()
graph.add_issues(issues)
graph.add_relationship(r1)
graph.add_relationship(r2)
warnings = graph.validate()
for w in warnings:
    log.warning(w.message)

positions = force_directed_layout(graph)
log.info(f"Node {issues[0].key} at ({positions[0].x:.1f}, {positions[0].y:.1f})")

graph.save("my_graph.json")
```

**Deliverable:** Python module that can build a graph, validate it, compute layout positions, and serialise to JSON.

---

### Phase 2 — Canvas Rendering & FastAPI Skeleton (Minimal UI)

**Goal:** Render the graph on an HTML5 canvas served by FastAPI — static, no interaction yet.

| Task | Details |
|------|---------|
| FastAPI server | Minimal server with `/static/`, `/api/issues`, `/api/layout`, `/api/link-types` endpoints |
| Frontend HTML/JS | Single-page app served by FastAPI |
| vis.js network | Render nodes and edges; receive position data from Phase 1 layout |
| Node styling | Rounded rectangles with key + truncated summary + status colour + type icon + assignee (via vis.js node options) |
| Edge styling | Directed arrows, coloured by relationship type, labels on edges (via vis.js edge options) |
| Zoom / pan | Browser-native via vis.js |
| Auto-layout applied | Use Phase 1 Python layout, send JSON coordinates to vis.js as initial positions |
| Live log panel | Show `jira_viz.log` entries in a side panel (useful for debugging) |

**Test approach:** Start the server, open in browser, load a Phase 1 JSON graph, verify nodes and edges render correctly. Check the log panel for render events.

---

### Phase 3 — Drag & Drop + Validate-on-Drop + Live Logging

**Goal:** Interactively create, modify, and delete relationships with **real-time client-side validation** and **live logging** of every change.

| Task | Details |
|------|---------|
| Drag node B onto node A | Opens a small popup/menu: pick from discovered link types, confirm |
| Relationship line appears | Immediate, coloured by type, label on edge |
| Double-click a node | Shows a side panel with **all** incoming and outgoing relationships |
| Edit a relationship | Right-click edge → change type / delete |
| Delete a relationship | Right-click → Delete |
| Validation on drop (client) | If impermissible, show warning overlay on the canvas **before** sending to server:
  - Self-loops
  - Link type not in discovered set
  - Circular dependency chains |
| Re-layout on change | After adding/removing, optionally re-run force-directed layout |
| **Live log** | Every relationship change is logged immediately:
  - `INFO: Relationship added: PROJ-5 → PROJ-3 (blocks)`
  - `INFO: Relationship deleted: PROJ-2 → PROJ-1 (relates)`
  - `WARNING: Validation rejected: self-loop — PROJ-5 → PROJ-5`
| **Commit queue** | Uncommitted relationships are collected into a **CommitQueue** (visible in UI):
  - Adding a relationship appends it to the queue
  - **Deleting a relationship removes it from the queue** (if it was previously added and not yet committed)
  - The queue is the source of truth for what Phase 5 will commit |

**Test approach:** Same JSON load + step-by-step interaction log:
```
log.info("User dragged PROJ-5 onto PROJ-3")
log.info("User selected relationship type: blocks")
log.info("Relationship added: PROJ-5 → PROJ-3 (blocks)")
log.info("Queued for commit: PROJ-5 → PROJ-3 (blocks)")
log.warning("Validation: self-loop rejected — PROJ-5 cannot link to itself")
```

**Note:** At this phase, relationships are held **locally in the frontend state** only — no JIRA write-back yet (that comes in Phase 5). The CommitQueue is built up as the user works.

---

### Phase 4 — Find / Search Feature

**Goal:** Search within the canvas result set.

| Task | Details |
|------|---------|
| Find bar / dialog | Input field at top of window |
| Partial key match | Typing `'Z'` highlights all nodes with `Z` in the key |
| Exact key match | Typing `'PROJ-123'` zooms to and highlights that node |
| Cycle through matches | Next / Previous buttons |
| Clear / reset | Button to clear highlights |

---

### Phase 5 — Write-Back to JIRA with Pre-Commit Log Review

**Goal:** Commit the **CommitQueue** contents to JIRA with a **review-before-commit** step.

| Task | Details |
|------|---------|
| Commit planner | Build a `List[CommitOp]` from the CommitQueue: create / update / delete links |
| Pre-commit log | Display the full log of operations that **will** be attempted, with severities:
  - `INFO`: operations that will succeed
  - `WARNING`: operations that may fail (e.g. type not in discovered set, permission concerns)
  - `ERROR`: operations that will definitely fail (e.g. link type rejected, permission denied) |
| **Live log context** | The pre-commit log also includes **all prior live changes** (from Phase 3+) so the user can see the full audit trail: what was added, what was deleted, and what is about to be committed |
| User confirmation | User must click "Commit" to proceed, or "Cancel" to abort |
| JIRA write-back | Send batch commit to JIRA REST API (create/update/delete issue links) |
| Commit result log | Log each result — success or failure — with HTTP status code, response body snippet, and what action triggered it |
| **HTTP error detail** | Every JIRA HTTP error (4xx/5xx) logged with: method, URL, status code, response body, and context of what the user was trying to do |
| Failed commit warnings | Show red warning on canvas for each failed write-back, with reason; **remove successful items from the CommitQueue** |
| Reload from JIRA | Button to re-fetch issues and merge remote state |
| **Pasteable log** | The full session log (`jira_viz.log`) is structured to be copy-pasteable as plain text — no HTML, no console-only output. User can paste it here for debugging. |

**Test approach (Phase 0/1 simulation):**
```python
# test_phase5_simulation.py
# Use a JIRA test instance or a dry-run mode:
commit_plan = commit_planner.build_plan(commit_queue)
log.info("=== LIVE LOG (all changes so far) ===")
for entry in commit_queue.live_log:
    log.info(f"  {entry}")
log.info("=== PRE-COMMIT LOG ===")
for op in commit_plan.operations:
    log.info(f"  {op.action}: {op.source} → {op.target} ({op.link_type})")
    if op.will_fail:
        log.warning(f"  WILL FAIL: {op.reason}")
print("=== END PRE-COMMIT LOG ===")
# In dry-run mode, no actual API call is made — user can review before committing.
```

**Example pasteable log entry (what `jira_viz.log` looks like for an HTTP error):**
```
2026-07-04 14:32:01  ERROR   POST https://company.atlassian.net/rest/api/3/issue/OKR-5/links
    Status: 403 Forbidden
    Action: Creating link "blocks" between OKR-5 and OKR-3
    Response: {"errorMessages":["You do not have permission to create issue links of type 'blocks'."]}
    Context: User dragged PROJ-5 onto PROJ-3, selected "blocks", clicked Commit
```
This plain-text format can be copy-pasted directly into this chat for debugging.

**Key design:** The pre-commit log is the **primary debugging surface** for write-back. It is shown in both:
1. The live log panel in the UI (Phase 2+).
2. The console/file logger (`jira_viz.log`) for headless/scripted testing.

**CommitQueue behaviour:**
- Built up incrementally as the user works (Phase 3).
- **Adding** a relationship → appended to queue.
- **Deleting** a relationship → removed from queue (if it was previously added and uncommitted).
- **Editing** a relationship → removed old entry, appended new entry.
- When "Commit" is clicked, only the queue's contents are sent to JIRA.

---

### Phase 6 — Polish + Graceful Shutdown

| Task | Details |
|------|---------|
| Keyboard shortcuts | Ctrl+F for find, Delete key for selected edge, etc. |
| Colour theme options | Dark mode / light mode |
| Export image | PNG / SVG snapshot of the canvas |
| Performance with 50 nodes | Ensure smooth zoom/pan |
| Error handling polish | User-friendly error messages |
| **Graceful shutdown on Ctrl+C** | Handle `SIGINT` / `KeyboardInterrupt`: flush logs, close JIRA connections, release ports, clean up temp files, print a "shutdown complete" message | |

---

## 5. Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| GUI framework | **Web-based** (FastAPI + HTML5) | Best drag-and-drop, browser zoom, easy iteration |
| Frontend rendering | **vis.js** (`vis-network`) | Drag-and-drop, zoom, layout, edges out of the box |
| Node per issue | Rounded rect, key + truncated summary + status + type icon + assignee | Compact, long summaries elided with `…` |
| Edges | Directed arrows, colour by type, label on edge | Clear visual language |
| Layout | Force-directed (Fruchterman-Reingold) | Handles arbitrary graph shapes, ~50 nodes |
| Validation | Per-drop, client-side (immediate) | Immediate feedback before write-back |
| Logging | `logging` module, file + console + live UI panel + live audit trail in UI | Debuggable before GUI; persists after GUI |
| Log format | **Plain text, pasteable** | No HTML/console-only output. Every HTTP error includes method, URL, status, response body, and context. User can paste `jira_viz.log` here for debugging. |
| Persistence | **JIRA as source of truth** (write-back) | No local JSON save/load as primary |
| JIRA sync | **Committed back to JIRA** (Phase 5) | With pre-commit log review + live audit trail |
| Link types | **Discover + allow all** | Query JIRA API at startup, warn if not permitted |
| Failed commits | **Warn + log** | Show on canvas + in log panel + `jira_viz.log` |
| Commit queue | **Live, updatable** | Deletions remove from queue, edits replace entries |
| Graceful shutdown | **SIGINT handler + finally block** | Flush logs, close JIRA connection, release ports, clean up temp files |

---

## 6. Recommended Development Order

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
  │            │            │            │            │            │            │
  ▼            ▼            ▼            ▼            ▼            ▼            ▼
 CLI fetch    Graph model  Web canvas   Drag & drop  Find/search  JIRA write   Polish
 + logging    + validation + FastAPI     + validate   + cycle      + log review (shortcuts,
              + layout     + static      + warn       + highlight   + failed warn  themes, export)
```

Each phase is **self-contained and testable** without needing the next phase's work.

---

## 7. Graceful Shutdown (Ctrl+C / SIGINT)

The app must clean up cleanly on every exit — you will frequently start and stop it.

| Resource | Cleanup action |
|----------|---------------|
| **Network port** (FastAPI / uvicorn) | Close uvicorn server; confirm port is released (no `Address already in use`) |
| **JIRA connection** (`jira.JIRA` object) | Call `jira.close()` or let session clean up |
| **Logger** (`jira_viz.log`) | Flush and close file handler so no log entries are lost |
| **Any temp files** | Remove if created during the session |
| **Console output** | Print `"Shutdown complete. Port <N> released."` on clean exit |

**Implementation:** Wrap the `main()` entry point in a `try / except KeyboardInterrupt` with a `finally` block that runs all cleanup. FastAPI's `lifespan` context manager can also handle shutdown hooks if preferred.

---

## 8. Open for Iteration

This plan is now updated per your feedback (web framework with vis.js, discover link types, write-back to JIRA, pre-commit logging, warn on failures, live audit trail, CommitQueue with deletions removing entries). Please review and let me know:

1. Any features you want added or removed?
2. Any concerns about the phased approach?
3. Any other adjustments before I start on Phase 0.

I'll update this document and lock in the final plan.
