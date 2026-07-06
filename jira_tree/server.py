"""
FastAPI server for jira_tree — JIRA Linked Work Item Tree Visualizer.

Key endpoint:
- GET  /api/tree        — fetch root issues via JQL, recursively traverse linked
                          items, compute layout, return full tree with cycle info

Also reuses all the editing endpoints from jira_viz for consistency.
"""

import json
import logging
import math
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.responses import HTMLResponse, JSONResponse

from jira_viz.fetcher import JIRAFetcher
from jira_viz.graph import GraphModel
from jira_viz.layout import force_directed_layout
from jira_viz.logger import get_logger, shutdown_logger
from jira_viz.models import JiraIssue, Relationship

from jira_tree.config import (
    JIRA_BASE_URL,
    JIRA_EMAIL,
    JIRA_API_KEY_FILE,
    LOG_FILE,
    STATIC_DIR,
    DEFAULT_ROOT_JQL,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_NODES,
)
from jira_tree.tree_builder import TreeBuilder, TreeResult
from jira_viz.gantt import GanttBuilder, parse_effort_to_seconds


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class TreeRequest(BaseModel):
    jql: str
    max_root_results: int = 50
    max_depth: int = DEFAULT_MAX_DEPTH
    max_nodes: int = DEFAULT_MAX_NODES
    link_type_filter: Optional[List[str]] = None


class RelationshipCreateRequest(BaseModel):
    source_key: str
    target_key: str
    link_type: str


class RelationshipDeleteRequest(BaseModel):
    source_key: str
    target_key: str
    link_type: str


class ValidateRequest(BaseModel):
    relationships: list


# ---------------------------------------------------------------------------
# Commit Queue & Planner (adapted from jira_viz)
# ---------------------------------------------------------------------------

class CommitEntry:
    def __init__(self, source_key, target_key, link_type, action="create"):
        self.source_key = source_key
        self.target_key = target_key
        self.link_type = link_type
        self.action = action
        self.entry_type = "relationship"

    def to_dict(self):
        return {
            "source_key": self.source_key,
            "target_key": self.target_key,
            "link_type": self.link_type,
            "action": self.action,
            "entry_type": self.entry_type,
        }


class FieldEditEntry:
    def __init__(self, issue_key, field_name, old_value, new_value, display_name=""):
        self.issue_key = issue_key
        self.field_name = field_name
        self.old_value = old_value
        self.new_value = new_value
        self.display_name = display_name or field_name
        self.entry_type = "field_edit"

    def to_dict(self):
        return {
            "issue_key": self.issue_key,
            "field_name": self.field_name,
            "old_value": str(self.old_value) if self.old_value is not None else None,
            "new_value": str(self.new_value) if self.new_value is not None else None,
            "display_name": self.display_name,
            "entry_type": self.entry_type,
        }


class CommitOp:
    def __init__(self, source_key, target_key, link_type, action="create"):
        self.source_key = source_key
        self.target_key = target_key
        self.link_type = link_type
        self.action = action
        self.success = False
        self.error_message = None
        self.http_status = None
        self.http_response = None

    def to_dict(self):
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
    def __init__(self, logger):
        self.logger = logger
        self._entries: List[CommitEntry] = []
        self._field_edits: List[FieldEditEntry] = []
        self.live_log: List[str] = []

    def add_create(self, source_key, target_key, link_type):
        self._entries = [
            e for e in self._entries
            if not (
                e.source_key == source_key
                and e.target_key == target_key
                and e.link_type == link_type
                and e.action == "delete"
            )
        ]
        self._entries.append(CommitEntry(source_key, target_key, link_type, "create"))
        self.logger.info("Queued for commit: %s -> %s (%s)", source_key, target_key, link_type)
        self.live_log.append(f"INFO: Relationship added: {source_key} → {target_key} ({link_type})")

    def add_delete(self, source_key, target_key, link_type):
        self._entries = [
            e for e in self._entries
            if not (
                e.source_key == source_key
                and e.target_key == target_key
                and e.link_type == link_type
                and e.action == "create"
            )
        ]
        self._entries.append(CommitEntry(source_key, target_key, link_type, "delete"))
        self.logger.info("Queued for commit (delete): %s -> %s (%s)", source_key, target_key, link_type)
        self.live_log.append(f"INFO: Relationship deleted: {source_key} → {target_key} ({link_type})")

    def remove_create(self, source_key, target_key, link_type):
        for i, e in enumerate(self._entries):
            if e.source_key == source_key and e.target_key == target_key and e.link_type == link_type and e.action == "create":
                del self._entries[i]
                return True
        return False

    def remove_delete(self, source_key, target_key, link_type):
        for i, e in enumerate(self._entries):
            if e.source_key == source_key and e.target_key == target_key and e.link_type == link_type and e.action == "delete":
                del self._entries[i]
                return True
        return False

    @property
    def entries(self):
        return list(self._entries)

    @property
    def field_edits(self):
        return list(self._field_edits)

    @property
    def count(self):
        return len(self._entries) + len(self._field_edits)

    def clear(self):
        self._entries.clear()
        self._field_edits.clear()
        self.logger.info("Commit queue cleared.")

    def add_field_edit(self, issue_key, field_name, old_value, new_value, display_name=""):
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

    def remove_field_edit(self, issue_key, field_name):
        for i, e in enumerate(self._field_edits):
            if e.issue_key == issue_key and e.field_name == field_name:
                del self._field_edits[i]
                return True
        return False


class CommitPlanner:
    def __init__(self, logger, graph, fetcher):
        self.logger = logger
        self.graph = graph
        self.fetcher = fetcher

    def build_plan(self, commit_queue):
        ops = []
        for entry in commit_queue.entries:
            op = CommitOp(
                source_key=entry.source_key,
                target_key=entry.target_key,
                link_type=entry.link_type,
                action=entry.action,
            )
            if op.source_key == op.target_key:
                op.validation_status = "error"
                op.validation_message = "Self-loop not allowed"
            elif self.graph.is_link_type_allowed(op.link_type) is False:
                op.validation_status = "error"
                op.validation_message = f"Link type '{op.link_type}' not permitted"
            elif entry.action == "create":
                exists = any(
                    r.source.key == op.source_key
                    and r.target.key == op.target_key
                    and r.link_type.lower() == op.link_type.lower()
                    for r in self.graph.relationships
                )
                if exists:
                    op.validation_status = "warning"
                    op.validation_message = "Relationship already exists"
                else:
                    op.validation_status = "ok"
                    op.validation_message = None
            else:
                op.validation_status = "ok"
                op.validation_message = None
            ops.append(op)
        return ops


# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

_logger: Optional[logging.Logger] = None
_fetcher: Optional[JIRAFetcher] = None
_commit_queue: Optional[CommitQueue] = None
_active_graph: Optional[GraphModel] = None
_tree_result: Optional[TreeResult] = None


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _logger, _fetcher, _commit_queue

    _logger = get_logger(log_file=LOG_FILE, name="jira_tree")
    _logger.info("jira_tree server starting up.")
    _commit_queue = CommitQueue(_logger)

    _fetcher = JIRAFetcher(
        logger=_logger,
        server=JIRA_BASE_URL,
        email=JIRA_EMAIL,
        key_file=JIRA_API_KEY_FILE,
    )
    _fetcher.connect()
    _logger.info("JIRA fetcher initialised.")

    yield

    _logger.info("jira_tree server shutting down.")
    if _fetcher:
        _fetcher.close()
    if _commit_queue:
        _commit_queue.clear()
    shutdown_logger(_logger)
    _logger = None
    _fetcher = None
    _commit_queue = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="jira_tree",
    description="JIRA Linked Work Item Tree Visualizer",
    version="0.1.0",
    lifespan=lifespan,
)

_static_dir = STATIC_DIR
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


def _get_fetcher():
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
# Core Tree Endpoint
# ---------------------------------------------------------------------------

@app.get("/")
async def root():
    """Serve the main page."""
    return HTMLResponse(content=Path("static_tree/index.html").read_text())


@app.get("/api/tree")
async def api_tree(
    jql: str = Query(..., description="JQL query for root issues"),
    max_root_results: int = Query(50, description="Max root issues to fetch"),
    max_depth: int = Query(DEFAULT_MAX_DEPTH, description="Max recursion depth"),
    max_nodes: int = Query(DEFAULT_MAX_NODES, description="Max total nodes to fetch"),
    width: int = Query(1200, description="Canvas width for layout"),
    height: int = Query(800, description="Canvas height for layout"),
    seed: int = Query(42, description="Random seed for layout"),
):
    """
    Build a complete tree from root issues.

    1. Fetch root issues matching the JQL query.
    2. Recursively follow all linked work items (both inward and outward).
    3. Detect cycles and mark them.
    4. Compute force-directed layout positions.
    5. Return everything needed for rendering.
    """
    global _active_graph, _tree_result

    fetcher = _get_fetcher()
    builder = TreeBuilder(
        fetcher=fetcher,
        logger=_logger,
        max_depth=max_depth,
        max_nodes=max_nodes,
    )

    # Build the tree
    result = builder.build_tree(root_jql=jql, max_results=max_root_results)
    _tree_result = result

    # Convert to GraphModel
    graph = builder.build_graph(result)
    _active_graph = graph

    # Compute layout with tree-aware spacing
    if result.issues:
        n = len(result.issues)
        area = float(width) * float(height)
        # Ideal edge length: at least 350px to prevent node overlap
        # (nodes are up to 250px wide + 100px padding)
        # Scale up slightly for deeper trees to spread the hierarchy
        tree_k = max(
            math.sqrt(area / max(n, 1)) * 1.5,
            350.0,
        )
        # More iterations and higher initial temp for larger graphs
        tree_iterations = 500 if n > 20 else 300
        tree_temp = 200.0 if n > 20 else 100.0

        _logger.info(
            "Tree layout: n=%d, k=%.0f, iterations=%d, temp=%.0f",
            n, tree_k, tree_iterations, tree_temp,
        )

        layout_result = force_directed_layout(
            graph,
            logger=_logger,
            width=float(width),
            height=float(height),
            k=tree_k,
            max_iterations=tree_iterations,
            initial_temp=tree_temp,
            seed=seed,
        )
        positions = [p.to_dict() for p in layout_result.positions]
    else:
        positions = []

    # Build response
    return {
        "issues": [iss.to_dict() for iss in result.issues.values()],
        "relationships": result.relationships,
        "cycle_edges": result.cycle_edges,
        "positions": positions,
        "tree_metadata": {
            "root_keys": result.root_keys,
            "total_nodes": result.total_nodes,
            "relationship_count": len(result.relationships),
            "cycle_count": result.cycle_count,
            "max_depth_reached": result.max_depth_reached,
            "nodes_at_depth_limit": result.nodes_at_depth_limit,
            "warnings": result.warnings,
        },
        "layout_metadata": {
            "iterations": layout_result.iterations if result.issues else 0,
            "final_energy": layout_result.final_energy if result.issues else 0.0,
        },
    }


@app.get("/api/default-jql")
async def api_default_jql():
    return {"default_jql": DEFAULT_ROOT_JQL or ""}


# ---------------------------------------------------------------------------
# Link Types
# ---------------------------------------------------------------------------

@app.get("/api/link-types")
async def api_link_types():
    fetcher = _get_fetcher()
    link_types = fetcher.fetch_link_types()
    return {"link_types": link_types, "count": len(link_types)}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

@app.get("/api/search")
async def api_search(q: str = Query(..., description="Search query")):
    global _active_graph
    if _active_graph is None:
        return {"matches": [], "count": 0}
    matches = _active_graph.search(q)
    return {"matches": matches, "count": len(matches)}


# ---------------------------------------------------------------------------
# Log tail
# ---------------------------------------------------------------------------

@app.get("/log")
async def api_log(lines: int = Query(100)):
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


# ---------------------------------------------------------------------------
# Relationship CRUD
# ---------------------------------------------------------------------------

@app.post("/api/relationships")
async def api_create_relationship(req: RelationshipCreateRequest):
    global _active_graph, _commit_queue

    if _active_graph is None:
        return JSONResponse(content={"error": "No active tree. Fetch a tree first."}, status_code=400)

    if req.source_key == req.target_key:
        return JSONResponse(
            content={"error": "Self-loop not allowed", "validation": ["self-loop"]},
            status_code=400,
        )

    if _active_graph.is_link_type_allowed(req.link_type) is False:
        return JSONResponse(
            content={"error": f"Link type '{req.link_type}' not permitted"},
            status_code=400,
        )

    source = _active_graph.get_issue(req.source_key)
    target = _active_graph.get_issue(req.target_key)
    if not source or not target:
        return JSONResponse(
            content={"error": "Source or target issue not in tree"},
            status_code=400,
        )

    rel = Relationship(source, target, link_type=req.link_type)
    if not _active_graph.add_relationship(rel):
        return JSONResponse(
            content={"error": "Relationship already exists or invalid"},
            status_code=400,
        )

    if _commit_queue is not None:
        _commit_queue.add_create(req.source_key, req.target_key, req.link_type)

    return {
        "created": True,
        "relationship": {
            "source": req.source_key,
            "target": req.target_key,
            "type": req.link_type,
        },
        "queue_count": _commit_queue.count if _commit_queue else 0,
    }


@app.delete("/api/relationships")
async def api_delete_relationship(req: RelationshipDeleteRequest):
    global _active_graph, _commit_queue

    if _logger:
        _logger.info(
            "DELETE: %s --[%s]--> %s", req.source_key, req.link_type, req.target_key
        )

    if _active_graph is None:
        return JSONResponse(content={"error": "No active tree"}, status_code=400)

    if not _active_graph.remove_relationship_by_keys(
        req.source_key, req.target_key, req.link_type
    ):
        return JSONResponse(content={"error": "Relationship not found"}, status_code=404)

    if _commit_queue is not None:
        _commit_queue.add_delete(req.source_key, req.target_key, req.link_type)

    return {
        "deleted": True,
        "relationship": {
            "source": req.source_key,
            "target": req.target_key,
            "type": req.link_type,
        },
        "queue_count": _commit_queue.count if _commit_queue else 0,
    }


@app.get("/api/relationships/{key}")
async def api_get_relationships_for_node(key: str):
    global _active_graph
    if _active_graph is None:
        return JSONResponse(content={"error": "No active tree"}, status_code=400)

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


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

@app.post("/api/validate")
async def api_validate(req: ValidateRequest):
    global _active_graph
    warnings_list = []

    for rel in req.relationships:
        if rel["source_key"] == rel["target_key"]:
            warnings_list.append({
                "severity": "ERROR",
                "message": f"Self-loop: {rel['source_key']} links to itself",
                "source_key": rel["source_key"],
                "target_key": rel["target_key"],
                "link_type": rel["link_type"],
            })

    if _active_graph is not None:
        for rel in req.relationships:
            if not _active_graph.is_link_type_allowed(rel["link_type"]):
                warnings_list.append({
                    "severity": "WARNING",
                    "message": f"Link type '{rel['link_type']}' not in discovered JIRA link types",
                    "source_key": rel["source_key"],
                    "target_key": rel["target_key"],
                    "link_type": rel["link_type"],
                })

    # Cycle detection (simplified)
    adj: dict = {}
    for rel in req.relationships:
        adj.setdefault(rel["source_key"], []).append(rel["target_key"])

    visited = set()
    rec_stack = set()

    def _check_cycle(node):
        visited.add(node)
        rec_stack.add(node)
        for neighbour in adj.get(node, []):
            if neighbour not in visited:
                if _check_cycle(neighbour):
                    return True
            elif neighbour in rec_stack:
                warnings_list.append({
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

    has_errors = any(w["severity"] == "ERROR" for w in warnings_list)
    return {"warnings": warnings_list, "valid": not has_errors}


# ---------------------------------------------------------------------------
# Commit workflow
# ---------------------------------------------------------------------------

@app.get("/api/commit-queue")
async def api_commit_queue():
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
    global _commit_queue
    if _commit_queue is None:
        return {"cleared": True, "count": 0}
    count = _commit_queue.count
    _commit_queue.clear()
    if _logger:
        _logger.info("Commit queue cleared (%d entries removed)", count)
    return {"cleared": True, "count": count}


@app.get("/api/commit-plan")
async def api_commit_plan():
    global _commit_queue, _active_graph, _fetcher
    if _commit_queue is None or _commit_queue.count == 0:
        return {"ops": [], "field_ops": [], "count": 0}
    if _active_graph is None or _fetcher is None:
        return {"error": "No active tree or fetcher"}, 400
    planner = CommitPlanner(logger=_logger, graph=_active_graph, fetcher=_fetcher)
    ops = planner.build_plan(_commit_queue)
    field_ops = [e.to_dict() for e in _commit_queue.field_edits]
    return {
        "ops": [op.to_dict() for op in ops],
        "field_ops": field_ops,
        "count": len(ops) + len(field_ops),
    }


@app.get("/api/commit")
async def api_commit_get(dry_run: bool = Query(False)):
    return await _do_commit(dry_run=dry_run)


@app.post("/api/commit")
async def api_commit_post(dry_run: bool = Query(False)):
    return await _do_commit(dry_run=dry_run)


async def _do_commit(dry_run: bool = False):
    global _commit_queue, _active_graph, _fetcher

    if _commit_queue is None or _commit_queue.count == 0:
        return {"success": True, "message": "Nothing to commit."}

    if _active_graph is None or _fetcher is None:
        return {"error": "No active tree or fetcher"}, 400

    planner = CommitPlanner(logger=_logger, graph=_active_graph, fetcher=_fetcher)
    ops = planner.build_plan(_commit_queue)

    if dry_run:
        result_ops = []
        for op in ops:
            if op.source_key == op.target_key:
                op.success = False
                op.error_message = "Self-loop not allowed"
            elif _active_graph.is_link_type_allowed(op.link_type) is False:
                op.success = False
                op.error_message = f"Link type '{op.link_type}' not permitted"
            else:
                op.success = True
            result_ops.append(op.to_dict())
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
            "success_count": sum(1 for o in result_ops if o["success"]) + len(field_result),
            "failure_count": sum(1 for o in result_ops if not o["success"]),
        }

    # Execute relationship ops
    result_ops = []
    for op in ops:
        try:
            if op.action == "create":
                result = _fetcher.create_issue_link(
                    op.source_key, op.target_key, op.link_type
                )
                op.success = result.get("success", False)
                op.http_status = result.get("status")
                op.http_response = result.get("response", "")
                if op.success:
                    _logger.info("COMMIT OK: %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
                else:
                    _logger.error("COMMIT FAIL: %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
            elif op.action == "delete":
                result = _fetcher.delete_issue_link(
                    op.source_key, op.target_key, op.link_type
                )
                op.success = result.get("success", False)
                op.http_status = result.get("status")
                op.http_response = result.get("response", "")
                if op.success:
                    _logger.info("COMMIT OK (delete): %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
                else:
                    _logger.error("COMMIT FAIL (delete): %s -> %s (%s)", op.source_key, op.target_key, op.link_type)
        except Exception as e:
            op.success = False
            op.error_message = str(e)
            _logger.error("COMMIT EXCEPTION: %s -> %s (%s): %s", op.source_key, op.target_key, op.link_type, e)
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
                _logger.error("COMMIT FIELD FAIL: %s.%s", fe.issue_key, fe.field_name)
        except Exception as e:
            d = fe.to_dict()
            d["success"] = False
            d["error_message"] = str(e)
            field_results.append(d)
            _logger.error("COMMIT FIELD EXCEPTION: %s.%s: %s", fe.issue_key, fe.field_name, e)

    successful_keys = set()
    for op_data in result_ops:
        if op_data["success"]:
            successful_keys.add((
                op_data["source_key"], op_data["target_key"],
                op_data["link_type"], op_data["action"],
            ))

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
    keys: Optional[str] = Query(None),
    focus_key: Optional[str] = Query(None),
    view: str = Query("dag"),
    assignee: Optional[str] = Query(None),
):
    global _tree_result, _active_graph
    if _tree_result is None and _active_graph is None:
        return JSONResponse(content={"error": "No active tree. Fetch a tree first."}, status_code=400)
    return _build_gantt(keys, focus_key, view, assignee)


@app.post("/api/gantt")
async def api_gantt_post(req: GanttRequest):
    global _tree_result, _active_graph
    if _tree_result is None and _active_graph is None:
        return JSONResponse(content={"error": "No active tree. Fetch a tree first."}, status_code=400)
    return _build_gantt(req.keys, req.focus_key, req.view, req.assignee)


def _build_gantt(keys, focus_key, view, assignee):
    global _tree_result, _active_graph
    if _tree_result is not None:
        source_issues = _tree_result.issues
        source_rels = _tree_result.relationships + _tree_result.cycle_edges
    else:
        source_issues = {iss.key: iss for iss in _active_graph.issues}
        source_rels = [r.to_dict() for r in _active_graph.relationships]

    if keys:
        filtered = {k: source_issues[k] for k in keys if k in source_issues}
    else:
        filtered = source_issues

    builder = GanttBuilder(logger=_logger)
    result = builder.build(
        issues=filtered,
        relationships=source_rels,
        focus_key=focus_key,
        view=view,
        assignee_filter=assignee,
    )
    return result.to_dict()


@app.post("/api/gantt/apply-edits")
async def api_gantt_apply_edits(req: GanttEditRequest):
    global _tree_result, _active_graph, _commit_queue

    if _tree_result is not None:
        all_issues = _tree_result.issues
        source_rels = _tree_result.relationships + _tree_result.cycle_edges
    elif _active_graph is not None:
        all_issues = {iss.key: iss for iss in _active_graph.issues}
        source_rels = [r.to_dict() for r in _active_graph.relationships]
    else:
        return JSONResponse(content={"error": "No active tree or graph."}, status_code=400)

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
                warnings.append(f"Invalid estimate for {issue_key}: {value} — skipped.")
                continue
        else:
            warnings.append(f"Unknown field '{field}' for {issue_key} — skipped.")
            continue

        if _commit_queue:
            display = "Start Date" if field == "start_date" else "Effort"
            _commit_queue.add_field_edit(issue_key, field, old_value, value, display)
        applied += 1

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
# Run directly
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    _logger = get_logger(name="jira_tree")
    _logger.info("Starting jira_tree server at http://localhost:8001")
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")
