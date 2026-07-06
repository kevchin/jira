"""
FastAPI server for jira_viz Phase 2.

Endpoints:
- GET /          — serve the main page
- GET /api/issues   — fetch issues via JQL
- GET /api/layout   — compute layout for issues + relationships
- GET /api/link-types — fetch available link types
- GET /log          — tail the log file

Lifespan context manager handles graceful startup/shutdown.
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.responses import HTMLResponse, JSONResponse

from jira_viz.config import (
    JIRA_BASE_URL,
    JIRA_EMAIL,
    JIRA_API_KEY_FILE,
    LOG_FILE,
    SERVER_PORT,
    STATIC_DIR,
)
from jira_viz.fetcher import JIRAFetcher
from jira_viz.graph import GraphModel
from jira_viz.layout import force_directed_layout
from jira_viz.gantt import GanttBuilder, parse_effort_to_seconds
from jira_viz.logger import get_logger, shutdown_logger


class IssuesRequest(BaseModel):
    jql: str
    max_results: int = 50


class LayoutRequest(BaseModel):
    issues: list  # list of issue dicts
    relationships: list = []  # list of relationship dicts


class RelationshipCreateRequest(BaseModel):
    source_key: str
    target_key: str
    link_type: str


class RelationshipDeleteRequest(BaseModel):
    source_key: str
    target_key: str
    link_type: str


class ValidateRequest(BaseModel):
    relationships: list  # list of relationship dicts


# ---------------------------------------------------------------------------
# Commit Queue
# ---------------------------------------------------------------------------


class CommitEntry:
    """A single relationship entry in the commit queue."""

    def __init__(self, source_key: str, target_key: str, link_type: str, action: str = "create"):
        self.source_key = source_key
        self.target_key = target_key
        self.link_type = link_type
        self.action = action  # "create" or "delete"
        self.entry_type = "relationship"

    def to_dict(self) -> dict:
        return {
            "source_key": self.source_key,
            "target_key": self.target_key,
            "link_type": self.link_type,
            "action": self.action,
            "entry_type": self.entry_type,
        }


class FieldEditEntry:
    """A single field edit entry in the commit queue."""

    def __init__(self, issue_key: str, field_name: str, old_value, new_value, display_name: str = ""):
        self.issue_key = issue_key
        self.field_name = field_name  # "start_date" or "original_estimate"
        self.old_value = old_value
        self.new_value = new_value
        self.display_name = display_name or field_name
        self.entry_type = "field_edit"

    def to_dict(self) -> dict:
        return {
            "issue_key": self.issue_key,
            "field_name": self.field_name,
            "old_value": str(self.old_value) if self.old_value is not None else None,
            "new_value": str(self.new_value) if self.new_value is not None else None,
            "display_name": self.display_name,
            "entry_type": self.entry_type,
        }


class CommitOp:
    """A single commit operation to be sent to JIRA."""

    def __init__(self, source_key: str, target_key: str, link_type: str, action: str = "create"):
        self.source_key = source_key
        self.target_key = target_key
        self.link_type = link_type
        self.action = action  # "create" or "delete"
        self.success = False
        self.error_message = None
        self.http_status = None
        self.http_response = None

    def to_dict(self) -> dict:
        return {
            "source_key": self.source_key,
            "target_key": self.target_key,
            "link_type": self.link_type,
            "action": self.action,
            "success": self.success,
            "error_message": self.error_message,
            "http_status": self.http_status,
            "http_response": self.http_response,
            "validation_status": getattr(self, "validation_status", None),
            "validation_message": getattr(self, "validation_message", None),
        }


class CommitQueue:
    """Tracks uncommitted relationship changes and field edits."""

    def __init__(self, logger: logging.Logger):
        self.logger = logger
        self._entries: List[CommitEntry] = []
        self._field_edits: List[FieldEditEntry] = []
        self.live_log: List[str] = []  # Track all live changes

    def add_create(self, source_key: str, target_key: str, link_type: str) -> None:
        """Add a relationship to be created."""
        # Remove any existing delete for the same relationship (edit scenario)
        self._entries = [
            e for e in self._entries
            if not (e.source_key == source_key and e.target_key == target_key and e.link_type == link_type and e.action == "delete")
        ]
        self._entries.append(CommitEntry(source_key, target_key, link_type, "create"))
        self.logger.info("Queued for commit: %s -> %s (%s)", source_key, target_key, link_type)
        self.live_log.append(f"INFO: Relationship added: {source_key} → {target_key} ({link_type})")

    def add_delete(self, source_key: str, target_key: str, link_type: str) -> None:
        """Add a relationship to be deleted."""
        # Remove any existing create for the same relationship
        self._entries = [
            e for e in self._entries
            if not (e.source_key == source_key and e.target_key == target_key and e.link_type == link_type and e.action == "create")
        ]
        self._entries.append(CommitEntry(source_key, target_key, link_type, "delete"))
        self.logger.info("Queued for commit (delete): %s -> %s (%s)", source_key, target_key, link_type)
        self.live_log.append(f"INFO: Relationship deleted: {source_key} → {target_key} ({link_type})")

    def remove_create(self, source_key: str, target_key: str, link_type: str) -> bool:
        """Remove a pending create (e.g. user undoes). Returns True if removed."""
        for i, e in enumerate(self._entries):
            if e.source_key == source_key and e.target_key == target_key and e.link_type == link_type and e.action == "create":
                del self._entries[i]
                self.logger.info("Removed from commit queue: %s -> %s (%s)", source_key, target_key, link_type)
                return True
        return False

    def remove_delete(self, source_key: str, target_key: str, link_type: str) -> bool:
        """Remove a pending delete (e.g. user undoes). Returns True if removed."""
        for i, e in enumerate(self._entries):
            if e.source_key == source_key and e.target_key == target_key and e.link_type == link_type and e.action == "delete":
                del self._entries[i]
                return True
        return False

    @property
    def entries(self) -> List[CommitEntry]:
        return list(self._entries)

    @property
    def field_edits(self) -> List[FieldEditEntry]:
        return list(self._field_edits)

    @property
    def count(self) -> int:
        return len(self._entries) + len(self._field_edits)

    def clear(self) -> None:
        self._entries.clear()
        self._field_edits.clear()
        self.logger.info("Commit queue cleared.")

    def add_field_edit(self, issue_key: str, field_name: str, old_value, new_value, display_name: str = "") -> None:
        """Queue a field edit for commit."""
        # Remove any existing edit for the same issue + field
        self._field_edits = [
            e for e in self._field_edits
            if not (e.issue_key == issue_key and e.field_name == field_name)
        ]
        entry = FieldEditEntry(issue_key, field_name, old_value, new_value, display_name)
        self._field_edits.append(entry)
        self.logger.info("Queued field edit: %s.%s: %s → %s", issue_key, field_name, old_value, new_value)
        self.live_log.append(
            f"INFO: Field edit: {issue_key} {display_name or field_name}: {old_value} → {new_value}"
        )

    def remove_field_edit(self, issue_key: str, field_name: str) -> bool:
        """Remove a pending field edit. Returns True if removed."""
        for i, e in enumerate(self._field_edits):
            if e.issue_key == issue_key and e.field_name == field_name:
                del self._field_edits[i]
                return True
        return False


class CommitPlanner:
    """Builds a list of CommitOp from the CommitQueue."""

    def __init__(self, logger: logging.Logger, graph: "GraphModel", fetcher: "JIRAFetcher"):
        self.logger = logger
        self.graph = graph
        self.fetcher = fetcher

    def build_plan(self, commit_queue: "CommitQueue") -> List["CommitOp"]:
        """Build a list of CommitOp from the CommitQueue."""
        ops = []
        for entry in commit_queue.entries:
            op = CommitOp(
                source_key=entry.source_key,
                target_key=entry.target_key,
                link_type=entry.link_type,
                action=entry.action,
            )

            # Validate client-side
            if op.source_key == op.target_key:
                op.validation_status = "error"
                op.validation_message = "Self-loop not allowed"
                self.logger.warning("Commit plan: self-loop detected %s -> %s", op.source_key, op.target_key)
            elif self.graph.is_link_type_allowed(op.link_type) is False:
                op.validation_status = "error"
                op.validation_message = f"Link type '{op.link_type}' not permitted"
                self.logger.warning("Commit plan: link type '%s' not permitted", op.link_type)
            elif entry.action == "create":
                # Check if relationship already exists
                exists = any(
                    r.source.key == op.source_key
                    and r.target.key == op.target_key
                    and r.link_type.lower() == op.link_type.lower()
                    for r in self.graph.relationships
                )
                if exists:
                    op.validation_status = "warning"
                    op.validation_message = "Relationship already exists"
                    self.logger.info("Commit plan: relationship already exists %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
                else:
                    op.validation_status = "ok"
                    op.validation_message = None
            else:
                op.validation_status = "ok"
                op.validation_message = None

            ops.append(op)
        return ops


# ---------------------------------------------------------------------------
# Lifespan: startup / shutdown
# ---------------------------------------------------------------------------

_logger: Optional[logging.Logger] = None
_fetcher: Optional[JIRAFetcher] = None
_commit_queue: Optional["CommitQueue"] = None
_active_graph: Optional[GraphModel] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown hooks."""
    global _logger, _fetcher

    # --- STARTUP ---
    _logger = get_logger(log_file=LOG_FILE)
    _logger.info("FastAPI server starting up.")
    _logger.info("Static files served from: static/")
    global _commit_queue, _fetcher
    _commit_queue = CommitQueue(_logger)
    _logger.info("Commit queue initialised.")
    
    # Initialize JIRA fetcher
    _fetcher = JIRAFetcher(
        logger=_logger,
        server=JIRA_BASE_URL,
        email=JIRA_EMAIL,
        key_file=JIRA_API_KEY_FILE,
    )
    _fetcher.connect()
    _logger.info("JIRA fetcher initialised.")

    # --- SHUTDOWN ---
    yield
    _logger.info("FastAPI server shutting down.")
    if _fetcher is not None:
        _fetcher.close()
    if _commit_queue is not None:
        _commit_queue.clear()
    shutdown_logger(_logger)
    _logger = None
    _fetcher = None
    _commit_queue = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="jira_viz",
    description="JIRA Relationship Visualizer",
    version="0.1.0",
    lifespan=lifespan,
)

# Serve static files
_static_dir = STATIC_DIR
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_fetcher() -> JIRAFetcher:
    """Lazy-init the JIRA fetcher."""
    global _fetcher
    if _fetcher is None:
        _fetcher = JIRAFetcher(
            logger=_logger,
            server=JIRA_BASE_URL,
            email=JIRA_EMAIL,
            key_file=JIRA_API_KEY_FILE,
        )
        _fetcher.connect()
    return _fetcher


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    """Serve the main page."""
    return HTMLResponse(content=Path("static/index.html").read_text())


@app.get("/api/issues")
async def api_issues(
    jql: str = Query(..., description="JQL query string"),
    max_results: int = Query(50, description="Max results"),
):
    """Fetch issues matching a JQL query and build the active graph."""
    global _active_graph

    fetcher = _get_fetcher()
    issues = fetcher.fetch_issues(jql, max_results=max_results)

    # Build graph from fetched issues and fetch their links
    graph = GraphModel(logger=_logger)
    for iss in issues:
        graph.add_issue(iss)

    # Fetch links for each issue and add to graph
    relationships = []
    seen_links = set()  # Track seen links to avoid duplicates
    for iss in issues:
        try:
            links = fetcher.fetch_issue_links(iss.key)
            for link in links:
                inward_key = link.get("inward_issue")
                outward_key = link.get("outward_issue")
                link_type = link.get("type", "Unknown")

                if not inward_key or not outward_key:
                    continue

                # Create a canonical key for deduplication (sort the issue keys)
                link_key = tuple(sorted([inward_key, outward_key])) + (link_type.lower(),)
                if link_key in seen_links:
                    continue
                seen_links.add(link_key)

                # Find the source and target issues
                source = graph.get_issue(outward_key)  # outward is the source (blocker, etc.)
                target = graph.get_issue(inward_key)   # inward is the target (blocked, etc.)

                # If source/target not in our graph, skip
                if not source or not target:
                    _logger.debug("Skipping link: %s (source=%s, target=%s not in graph)",
                                  link_type, outward_key, inward_key)
                    continue

                from jira_viz.models import Relationship
                rel = Relationship(source=source, target=target, link_type=link_type)
                graph.add_relationship(rel)
                relationships.append(rel.to_dict())
        except Exception as e:
            _logger.warning("Failed to fetch links for %s: %s", iss.key, e)

    _active_graph = graph

    return {
        "issues": [iss.to_dict() for iss in issues],
        "relationships": relationships,
        "count": len(issues),
    }


@app.get("/api/layout")
async def api_layout(
    issues_json: str = Query(..., description="JSON string of issue list"),
    relationships_json: str = Query("", description="JSON string of relationship list"),
    width: int = Query(1200, description="Canvas width"),
    height: int = Query(800, description="Canvas height"),
    seed: int = Query(42, description="Random seed for reproducibility"),
):
    """Compute force-directed layout for given issues + relationships."""
    import json

    issues_data = json.loads(issues_json)
    rels_data = json.loads(relationships_json) if relationships_json else []

    # Build graph
    graph = GraphModel(logger=_logger)
    for d in issues_data:
        from jira_viz.models import JiraIssue
        iss = JiraIssue.from_dict(d)
        graph.add_issue(iss)

    # Add relationships if provided
    for d in rels_data:
        from jira_viz.models import JiraIssue, Relationship
        source = graph.get_issue(d["source_key"])
        target = graph.get_issue(d["target_key"])
        if source and target:
            rel = Relationship.from_dict(d, source, target)
            graph.add_relationship(rel)

    # Compute layout
    result = force_directed_layout(
        graph,
        logger=_logger,
        width=float(width),
        height=float(height),
        seed=seed,
    )

    return {
        "positions": [p.to_dict() for p in result.positions],
        "iterations": result.iterations,
        "final_energy": result.final_energy,
    }


@app.get("/api/link-types")
async def api_link_types():
    """Fetch available link types from JIRA."""
    fetcher = _get_fetcher()
    link_types = fetcher.fetch_link_types()
    return {"link_types": link_types, "count": len(link_types)}


@app.get("/api/default-jql")
async def api_default_jql():
    """Return the default JQL query from config."""
    from jira_viz.config import DEFAULT_JQL_QUERY
    return {"default_jql": DEFAULT_JQL_QUERY or ""}


@app.get("/api/search")
async def api_search(q: str = Query(..., description="Search query")):
    """Search for nodes matching the query (key or summary)."""
    global _active_graph

    if _active_graph is None:
        return {"matches": [], "count": 0}

    matches = _active_graph.search(q)
    return {"matches": matches, "count": len(matches)}


@app.get("/log")
async def api_log(
    lines: int = Query(100, description="Number of tail lines"),
):
    """Tail the log file for the live log panel."""
    log_path = LOG_FILE
    if not log_path.exists():
        return {"entries": []}

    try:
        text = log_path.read_text(encoding="utf-8")
        all_lines = text.strip().split("\n")
        tail = all_lines[-lines:] if len(all_lines) > lines else all_lines
        return {"entries": tail, "total_lines": len(all_lines)}
    except Exception as e:
        return {"entries": [], "error": str(e)}


@app.post("/api/relationships")
async def api_create_relationship(req: RelationshipCreateRequest):
    """Create a relationship between two issues."""
    global _active_graph, _commit_queue

    if _active_graph is None:
        return JSONResponse(content={"error": "No active graph. Fetch issues first."}, status_code=400)

    # Client-side validation
    if req.source_key == req.target_key:
        return JSONResponse(content={"error": "Self-loop not allowed", "validation": ["self-loop"]}, status_code=400)

    if _active_graph.is_link_type_allowed(req.link_type) is False:
        return JSONResponse(content={"error": f"Link type '{req.link_type}' not permitted", "validation": ["link-type-not-allowed"]}, status_code=400)

    # Add to graph
    source = _active_graph.get_issue(req.source_key)
    target = _active_graph.get_issue(req.target_key)
    if not source or not target:
        return JSONResponse(content={"error": "Source or target issue not in graph"}, status_code=400)

    from jira_viz.models import Relationship
    rel = Relationship(source, target, link_type=req.link_type)
    if not _active_graph.add_relationship(rel):
        return JSONResponse(content={"error": "Relationship already exists or invalid issues"}, status_code=400)

    # Add to commit queue
    if _commit_queue is not None:
        _commit_queue.add_create(req.source_key, req.target_key, req.link_type)

    return {
        "created": True,
        "relationship": {"source": req.source_key, "target": req.target_key, "type": req.link_type},
        "queue_count": _commit_queue.count if _commit_queue else 0,
    }


@app.delete("/api/relationships")
async def api_delete_relationship(req: RelationshipDeleteRequest):
    """Delete a relationship between two issues."""
    global _active_graph, _commit_queue

    if _logger:
        _logger.info("DELETE request: %s --[%s]--> %s", req.source_key, req.link_type, req.target_key)

    if _active_graph is None:
        return JSONResponse(content={"error": "No active graph"}, status_code=400)

    # Remove from graph
    if not _active_graph.remove_relationship_by_keys(req.source_key, req.target_key, req.link_type):
        if _logger:
            _logger.warning("DELETE failed: relationship not found %s --[%s]--> %s", req.source_key, req.link_type, req.target_key)
        return JSONResponse(content={"error": "Relationship not found"}, status_code=404)

    # Update commit queue
    if _commit_queue is not None:
        _commit_queue.add_delete(req.source_key, req.target_key, req.link_type)

    return {
        "deleted": True,
        "relationship": {"source": req.source_key, "target": req.target_key, "type": req.link_type},
        "queue_count": _commit_queue.count if _commit_queue else 0,
    }


@app.get("/api/relationships/{key}")
async def api_get_relationships_for_node(key: str):
    """Get all relationships for a given issue key."""
    global _active_graph

    if _active_graph is None:
        return JSONResponse(content={"error": "No active graph"}, status_code=400)

    rels = _active_graph.get_relationships_for_issue(key)
    result = []
    for direction, rel in rels:
        result.append({
            "direction": direction,
            "source": rel.source.key,
            "target": rel.target.key,
            "type": rel.link_type,
        })
    return {"key": key, "relationships": result}


@app.post("/api/validate")
async def api_validate(req: ValidateRequest):
    """Client-side validation of relationships."""
    global _active_graph

    warnings = []

    # Check self-loops
    for rel in req.relationships:
        if rel["source_key"] == rel["target_key"]:
            warnings.append({
                "severity": "ERROR",
                "message": f"Self-loop: {rel['source_key']} links to itself",
                "source_key": rel["source_key"],
                "target_key": rel["target_key"],
                "link_type": rel["link_type"],
            })

    # Check link type permissions
    if _active_graph is not None:
        for rel in req.relationships:
            if not _active_graph.is_link_type_allowed(rel["link_type"]):
                warnings.append({
                    "severity": "WARNING",
                    "message": f"Link type '{rel['link_type']}' not in discovered JIRA link types",
                    "source_key": rel["source_key"],
                    "target_key": rel["target_key"],
                    "link_type": rel["link_type"],
                })

    # Check duplicates
    seen = {}
    for rel in req.relationships:
        key = (rel["source_key"], rel["target_key"], rel["link_type"])
        seen[key] = seen.get(key, 0) + 1
        if seen[key] > 1:
            warnings.append({
                "severity": "WARNING",
                "message": f"Duplicate: {rel['source_key']} -> {rel['target_key']} ({rel['link_type']})",
                "source_key": rel["source_key"],
                "target_key": rel["target_key"],
                "link_type": rel["link_type"],
            })

    # Check circular dependencies (simplified)
    # Build adjacency and check for cycles
    adj: dict = {}
    for rel in req.relationships:
        adj.setdefault(rel["source_key"], []).append(rel["target_key"])

    visited = set()
    rec_stack = set()

    def _check_cycle(node: str) -> bool:
        visited.add(node)
        rec_stack.add(node)
        for neighbour in adj.get(node, []):
            if neighbour not in visited:
                if _check_cycle(neighbour):
                    return True
            elif neighbour in rec_stack:
                warnings.append({
                    "severity": "WARNING",
                    "message": f"Circular dependency: ... -> {node} -> {neighbour} -> ...",
                    "source_key": node,
                    "target_key": neighbour,
                })
                return True
        rec_stack.discard(node)
        return False

    for key in adj:
        if key not in visited:
            _check_cycle(key)

    return {"warnings": warnings, "valid": len([w for w in warnings if w["severity"] == "ERROR"]) == 0}


@app.get("/api/commit-queue")
async def api_commit_queue():
    """Get the current commit queue state."""
    global _commit_queue
    if _commit_queue is None:
        return {"entries": [], "field_edits": [], "count": 0}
    return {
        "entries": [e.to_dict() for e in _commit_queue.entries],
        "field_edits": [e.to_dict() for e in _commit_queue.field_edits],
        "count": _commit_queue.count,
    }


@app.delete("/api/commit-queue")
async def api_clear_commit_queue():
    """Clear the entire commit queue."""
    global _commit_queue
    if _commit_queue is None:
        return {"cleared": True, "count": 0}
    
    count = _commit_queue.count
    _commit_queue.clear()
    
    if _logger:
        _logger.info("Commit queue cleared by user (%d entries removed)", count)
    
    return {"cleared": True, "count": count}


@app.get("/api/commit-plan")
async def api_commit_plan():
    """Get the planned commit operations (for review before commit)."""
    global _commit_queue, _active_graph, _fetcher

    if _commit_queue is None or _commit_queue.count == 0:
        return {"ops": [], "count": 0}

    if _active_graph is None or _fetcher is None:
        return {"error": "No active graph or fetcher"}, 400

    planner = CommitPlanner(logger=_logger, graph=_active_graph, fetcher=_fetcher)
    ops = planner.build_plan(_commit_queue)
    field_ops = [e.to_dict() for e in _commit_queue.field_edits]
    return {
        "ops": [op.to_dict() for op in ops],
        "field_ops": field_ops,
        "count": len(ops) + len(field_ops),
    }


@app.get("/api/commit")
async def api_commit_get(dry_run: bool = Query(False, description="Dry run mode (no actual commit)")):
    """Dry-run the commit queue to preview operations."""
    return await _api_commit(dry_run=dry_run)


@app.post("/api/commit")
async def api_commit_post(dry_run: bool = Query(False, description="Dry run mode (no actual commit)")):
    """Commit the queue to JIRA."""
    return await _api_commit(dry_run=dry_run)


async def _api_commit(dry_run: bool = False):
    """Internal commit handler."""
    global _commit_queue, _active_graph, _fetcher

    if _commit_queue is None or _commit_queue.count == 0:
        return {"success": True, "message": "Nothing to commit."}

    if _active_graph is None or _fetcher is None:
        return {"error": "No active graph or fetcher"}, 400

    planner = CommitPlanner(logger=_logger, graph=_active_graph, fetcher=_fetcher)
    ops = planner.build_plan(_commit_queue)

    if dry_run:
        # Return the planned operations without executing
        result_ops = []
        for op in ops:
            # Validate client-side
            if op.source_key == op.target_key:
                op.success = False
                op.error_message = "Self-loop not allowed"
            elif _active_graph.is_link_type_allowed(op.link_type) is False:
                op.success = False
                op.error_message = f"Link type '{op.link_type}' not permitted"
            else:
                op.success = True  # Would succeed
            result_ops.append(op.to_dict())

        # Field edits are always "ok" in dry run
        field_result = []
        for fe in _commit_queue.field_edits:
            d = fe.to_dict()
            d["success"] = True
            field_result.append(d)

        return {
            "dry_run": True,
            "ops": result_ops,
            "field_ops": field_result,
            "count": len(result_ops) + len(field_result),
            "success_count": sum(1 for op in result_ops if op["success"]) + len(field_result),
            "failure_count": sum(1 for op in result_ops if not op["success"]),
        }

    # Execute the commit (relationship ops)
    result_ops = []
    for op in ops:
        try:
            if op.action == "create":
                result = _fetcher.create_issue_link(op.source_key, op.target_key, op.link_type)
                op.success = result.get("success", False)
                op.http_status = result.get("status")
                op.http_response = result.get("response", "")
                if op.success:
                    _logger.info("COMMIT SUCCESS: %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
                else:
                    _logger.error("COMMIT FAILED: %s -> %s (%s) - %s", op.source_key, op.target_key, op.link_type, op.error_message)

            elif op.action == "delete":
                result = _fetcher.delete_issue_link(op.source_key, op.target_key, op.link_type)
                op.success = result.get("success", False)
                op.http_status = result.get("status")
                op.http_response = result.get("response", "")
                if op.success:
                    _logger.info("COMMIT SUCCESS (delete): %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
                else:
                    _logger.error("COMMIT FAILED (delete): %s -> %s (%s) - %s", op.source_key, op.target_key, op.link_type, op.error_message)

        except Exception as e:
            op.success = False
            op.error_message = str(e)
            _logger.error("COMMIT EXCEPTION: %s -> %s (%s) - %s", op.source_key, op.target_key, op.link_type, e)

        result_ops.append(op.to_dict())

    # Execute field edits
    field_results = []
    for fe in list(_commit_queue._field_edits):
        try:
            result = _fetcher.update_issue_field(fe.issue_key, fe.field_name, fe.new_value)
            d = fe.to_dict()
            d["success"] = result.get("success", False)
            d["http_status"] = result.get("status")
            d["http_response"] = result.get("response", "")
            field_results.append(d)
            if d["success"]:
                _logger.info("COMMIT FIELD OK: %s.%s = %s", fe.issue_key, fe.field_name, fe.new_value)
                _commit_queue.remove_field_edit(fe.issue_key, fe.field_name)
            else:
                _logger.error("COMMIT FIELD FAIL: %s.%s - %s", fe.issue_key, fe.field_name, result.get("response", ""))
        except Exception as e:
            d = fe.to_dict()
            d["success"] = False
            d["error_message"] = str(e)
            field_results.append(d)
            _logger.error("COMMIT FIELD EXCEPTION: %s.%s - %s", fe.issue_key, fe.field_name, e)

    # Remove successful relationship ops from commit queue
    successful_keys = set()
    for op in result_ops:
        if op["success"]:
            successful_keys.add((op["source_key"], op["target_key"], op["link_type"], op["action"]))

    if _commit_queue is not None:
        _commit_queue._entries = [
            e for e in _commit_queue._entries
            if (e.source_key, e.target_key, e.link_type, e.action) not in successful_keys
        ]

    success_count = sum(1 for op in result_ops if op["success"]) + sum(1 for f in field_results if f.get("success"))
    failure_count = sum(1 for op in result_ops if not op["success"]) + sum(1 for f in field_results if not f.get("success"))

    return {
        "dry_run": False,
        "ops": result_ops,
        "field_ops": field_results,
        "count": len(result_ops) + len(field_results),
        "success_count": success_count,
        "failure_count": failure_count,
        "remaining_queue": _commit_queue.count if _commit_queue else 0,
    }


# ---------------------------------------------------------------------------
# Gantt chart endpoints
# ---------------------------------------------------------------------------

class GanttRequest(BaseModel):
    keys: Optional[List[str]] = None
    focus_key: Optional[str] = None
    view: str = "dag"
    assignee: Optional[str] = None


class GanttEditRequest(BaseModel):
    edits: List[dict]
    focus_key: Optional[str] = None
    keys: Optional[List[str]] = None
    view: str = "dag"


@app.get("/api/gantt")
async def api_gantt_get(
    keys: Optional[str] = Query(None, description="Comma-separated issue keys"),
    focus_key: Optional[str] = Query(None),
    view: str = Query("dag"),
    assignee: Optional[str] = Query(None),
):
    """Build a Gantt chart from the active graph."""
    global _active_graph

    if _active_graph is None:
        return JSONResponse(content={"error": "No active graph. Fetch issues first."}, status_code=400)

    source_issues = {iss.key: iss for iss in _active_graph.issues}
    source_rels = [r.to_dict() for r in _active_graph.relationships]

    # Filter by keys if provided
    if keys:
        key_list = [k.strip() for k in keys.split(",")]
        filtered_issues = {k: source_issues[k] for k in key_list if k in source_issues}
    else:
        filtered_issues = source_issues

    builder = GanttBuilder(logger=_logger)
    result = builder.build(
        issues=filtered_issues,
        relationships=source_rels,
        focus_key=focus_key,
        view=view,
        assignee_filter=assignee,
    )
    return result.to_dict()


@app.post("/api/gantt")
async def api_gantt_post(req: GanttRequest):
    """Build a Gantt chart from the active graph (POST)."""
    global _active_graph

    if _active_graph is None:
        return JSONResponse(content={"error": "No active graph. Fetch issues first."}, status_code=400)

    source_issues = {iss.key: iss for iss in _active_graph.issues}
    source_rels = [r.to_dict() for r in _active_graph.relationships]

    if req.keys:
        filtered_issues = {k: source_issues[k] for k in req.keys if k in source_issues}
    else:
        filtered_issues = source_issues

    builder = GanttBuilder(logger=_logger)
    result = builder.build(
        issues=filtered_issues,
        relationships=source_rels,
        focus_key=req.focus_key,
        view=req.view,
        assignee_filter=req.assignee,
    )
    return result.to_dict()


@app.post("/api/gantt/apply-edits")
async def api_gantt_apply_edits(req: GanttEditRequest):
    """Apply field edits to in-memory issues, re-compute Gantt, and queue for commit."""
    global _active_graph, _commit_queue

    if _active_graph is None:
        return JSONResponse(content={"error": "No active graph."}, status_code=400)

    all_issues = {iss.key: iss for iss in _active_graph.issues}

    applied = 0
    warnings = []

    for edit in req.edits:
        issue_key = edit.get("issue_key", "")
        field = edit.get("field", "")
        value = edit.get("value")

        iss = all_issues.get(issue_key)
        if not iss:
            warnings.append(f"Issue {issue_key} not found — skipped.")
            continue

        old_value = None
        if field == "start_date":
            old_value = iss.start_date
            iss.start_date = value if value else None
        elif field == "original_estimate":
            old_value = iss.original_estimate
            try:
                iss.original_estimate = int(value) if value else None
            except (ValueError, TypeError):
                warnings.append(f"Invalid estimate value for {issue_key}: {value} — skipped.")
                continue
        else:
            warnings.append(f"Unknown field '{field}' for {issue_key} — skipped.")
            continue

        # Queue for commit
        if _commit_queue:
            display = "Start Date" if field == "start_date" else "Effort"
            _commit_queue.add_field_edit(issue_key, field, old_value, value, display)

        applied += 1
        _logger.info("Applied edit: %s.%s: %s → %s", issue_key, field, old_value, value)

    # Re-compute Gantt
    source_rels = [r.to_dict() for r in _active_graph.relationships]

    builder = GanttBuilder(logger=_logger)
    result = builder.build(
        issues=all_issues,
        relationships=source_rels,
        focus_key=req.focus_key,
        view=req.view,
        assignee_filter=None,
    )
    # Filter bars by keys if provided
    if req.keys:
        key_set = set(req.keys)
        result.bars = [b for b in result.bars if b.key in key_set]

    response = result.to_dict()
    response["applied"] = applied
    response["edit_warnings"] = warnings
    return response


# ---------------------------------------------------------------------------
# Run directly (for testing)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    _logger = get_logger()
    _logger.info("Starting jira_viz server at http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
