"""
Graph model for jira_viz Phase 1.

- GraphModel: holds issues + relationships, validates, serialises to JSON
- Warning system: self-loops, duplicate links, circular dependencies, impermissible types
"""

import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from jira_viz.models import JiraIssue, Relationship
from jira_viz.warning import Severity, Warning


class GraphModel:
    """
    A graph of JIRA issues connected by relationships.

    Usage:
        graph = GraphModel()
        graph.add_issues(issues)
        graph.add_relationship(r1)
        warnings = graph.validate()
        graph.save("my_graph.json")
    """

    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger
        self._issues: Dict[str, JiraIssue] = {}  # key -> JiraIssue
        self._relationships: List[Relationship] = []
        self._link_types_allowed: Optional[List[str]] = None  # set by caller

    # ------------------------------------------------------------------
    # Issue management
    # ------------------------------------------------------------------

    def add_issues(self, issues: List[JiraIssue]) -> int:
        """Add a list of issues. Returns count added (skips duplicates)."""
        added = 0
        for iss in issues:
            if iss.key not in self._issues:
                self._issues[iss.key] = iss
                added += 1
                if self.logger:
                    self.logger.debug("Added issue: %s — %s", iss.key, iss.summary)
            else:
                if self.logger:
                    self.logger.debug("Issue already in graph: %s", iss.key)
        if self.logger:
            self.logger.info("Added %d issues to graph (total: %d).", added, len(self._issues))
        return added

    def add_issue(self, issue: JiraIssue) -> bool:
        """Add a single issue. Returns True if added, False if already present."""
        if issue.key in self._issues:
            return False
        self._issues[issue.key] = issue
        if self.logger:
            self.logger.debug("Added issue: %s", issue.key)
        return True

    def get_issue(self, key: str) -> Optional[JiraIssue]:
        """Get an issue by key."""
        return self._issues.get(key)

    def remove_issue(self, key: str) -> bool:
        """Remove an issue and all its relationships. Returns True if removed."""
        if key not in self._issues:
            return False
        del self._issues[key]
        # Also remove relationships involving this issue
        self._relationships = [
            r for r in self._relationships
            if r.source.key != key and r.target.key != key
        ]
        if self.logger:
            self.logger.info("Removed issue: %s and all its relationships.", key)
        return True

    @property
    def issues(self) -> List[JiraIssue]:
        return list(self._issues.values())

    @property
    def issue_keys(self) -> Set[str]:
        return set(self._issues.keys())

    # ------------------------------------------------------------------
    # Relationship management
    # ------------------------------------------------------------------

    def add_relationship(self, relationship: Relationship) -> bool:
        """
        Add a relationship. Returns True if added, False if duplicate.

        Duplicate = same source, target, and link_type already exist.
        """
        # Check for duplicate
        for existing in self._relationships:
            if (existing.source.key == relationship.source.key
                    and existing.target.key == relationship.target.key
                    and existing.link_type == relationship.link_type):
                if self.logger:
                    self.logger.warning(
                        "Duplicate relationship already exists: %s", relationship
                    )
                return False

        # Check that both issues exist in the graph
        if relationship.source.key not in self._issues:
            if self.logger:
                self.logger.error(
                    "Source issue %s not in graph. Cannot add relationship.",
                    relationship.source.key,
                )
            return False
        if relationship.target.key not in self._issues:
            if self.logger:
                self.logger.error(
                    "Target issue %s not in graph. Cannot add relationship.",
                    relationship.target.key,
                )
            return False

        self._relationships.append(relationship)
        if self.logger:
            self.logger.info("Added relationship: %s", relationship)
        return True

    def remove_relationship(self, relationship: Relationship) -> bool:
        """Remove a relationship. Returns True if removed."""
        try:
            self._relationships.remove(relationship)
            if self.logger:
                self.logger.info("Removed relationship: %s", relationship)
            return True
        except ValueError:
            if self.logger:
                self.logger.warning("Relationship not found: %s", relationship)
            return False

    def remove_relationship_by_keys(
        self, source_key: str, target_key: str, link_type: str
    ) -> bool:
        """Remove a relationship identified by keys and type."""
        for i, r in enumerate(self._relationships):
            if r.source.key == source_key and r.target.key == target_key and r.link_type == link_type:
                del self._relationships[i]
                if self.logger:
                    self.logger.info("Removed relationship: %s --[%s]--> %s", source_key, link_type, target_key)
                return True
        if self.logger:
            self.logger.warning(
                "Relationship not found: %s --[%s]--> %s", source_key, link_type, target_key
            )
        return False

    @property
    def relationships(self) -> List[Relationship]:
        return list(self._relationships)

    def get_relationships_for_issue(self, key: str) -> List[Tuple[str, Relationship]]:
        """
        Get all relationships involving a given issue key.

        Returns list of (direction, relationship) where direction is
        'incoming' or 'outgoing'.
        """
        result = []
        for r in self._relationships:
            if r.source.key == key:
                result.append(("outgoing", r))
            if r.target.key == key:
                result.append(("incoming", r))
        return result

    # ------------------------------------------------------------------
    # Link type management
    # ------------------------------------------------------------------

    def set_allowed_link_types(self, link_types: List[str]) -> None:
        """Set the list of allowed link types (from JIRA API discovery).

        Stored in lowercase for case-insensitive comparison, since JIRA
        returns types like 'Blocks' but users may refer to them as 'blocks'.
        """
        self._link_types_allowed = [lt.lower() for lt in link_types]
        if self.logger:
            self.logger.info("Set allowed link types (lowercased): %s", self._link_types_allowed)

    def is_link_type_allowed(self, link_type: str) -> bool:
        """Check if a link type is in the allowed set (case-insensitive)."""
        if self._link_types_allowed is None:
            return True  # If not set, allow everything
        return link_type.lower() in self._link_types_allowed

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate(self) -> List[Warning]:
        """
        Run all validation checks on the graph.

        Returns a list of Warning objects.
        """
        warnings: List[Warning] = []

        warnings.extend(self._check_self_loops())
        warnings.extend(self._check_duplicate_links())
        warnings.extend(self._check_circular_dependencies())
        warnings.extend(self._check_link_type_permissions())

        if self.logger:
            info_count = sum(1 for w in warnings if w.severity == Severity.INFO)
            warn_count = sum(1 for w in warnings if w.severity == Severity.WARNING)
            error_count = sum(1 for w in warnings if w.severity == Severity.ERROR)
            self.logger.info(
                "Validation complete: %d info, %d warnings, %d errors.",
                info_count, warn_count, error_count,
            )
            for w in warnings:
                log_fn = {
                    Severity.INFO: self.logger.info,
                    Severity.WARNING: self.logger.warning,
                    Severity.ERROR: self.logger.error,
                }.get(w.severity, self.logger.warning)
                log_fn("%s", w)

        return warnings

    def _check_self_loops(self) -> List[Warning]:
        """Check for self-loops (A → A)."""
        warnings = []
        for r in self._relationships:
            if r.source.key == r.target.key:
                warnings.append(Warning(
                    severity=Severity.ERROR,
                    message=f"Self-loop detected: {r.source.key} links to itself",
                    source_key=r.source.key,
                    target_key=r.target.key,
                    link_type=r.link_type,
                ))
        return warnings

    def _check_duplicate_links(self) -> List[Warning]:
        """Check for duplicate links (same source, target, type)."""
        warnings = []
        seen: Dict[Tuple[str, str, str], int] = {}
        for r in self._relationships:
            key = (r.source.key, r.target.key, r.link_type)
            seen[key] = seen.get(key, 0) + 1
            if seen[key] > 1:
                warnings.append(Warning(
                    severity=Severity.WARNING,
                    message=f"Duplicate link: {r.source.key} --[{r.link_type}]--> {r.target.key}",
                    source_key=r.source.key,
                    target_key=r.target.key,
                    link_type=r.link_type,
                ))
        return warnings

    def _check_circular_dependencies(self) -> List[Warning]:
        """
        Check for circular dependency chains (A → B → C → A).

        Uses DFS to detect cycles. Reports each cycle found.
        """
        warnings = []
        # Build adjacency list
        adj: Dict[str, List[Tuple[str, str]]] = {}  # key -> [(target, link_type)]
        for r in self._relationships:
            adj.setdefault(r.source.key, []).append((r.target.key, r.link_type))

        # DFS cycle detection
        visited: Set[str] = set()
        rec_stack: Set[str] = set()
        path: List[str] = []

        def _dfs(node: str) -> None:
            visited.add(node)
            rec_stack.add(node)
            path.append(node)

            for neighbour, link_type in adj.get(node, []):
                if neighbour not in visited:
                    _dfs(neighbour)
                elif neighbour in rec_stack:
                    # Found a cycle — extract it
                    cycle_start = path.index(neighbour)
                    cycle = path[cycle_start:] + [neighbour]
                    cycle_str = " → ".join(cycle)
                    warnings.append(Warning(
                        severity=Severity.WARNING,
                        message=f"Circular dependency detected: {cycle_str}",
                        source_key=node,
                        target_key=neighbour,
                    ))

            path.pop()
            rec_stack.discard(node)

        for key in list(self._issues.keys()):
            if key not in visited:
                _dfs(key)

        return warnings

    def _check_link_type_permissions(self) -> List[Warning]:
        """Check if link types are permitted (based on discovered types)."""
        warnings = []
        if self._link_types_allowed is None:
            return warnings  # Not set, skip check

        for r in self._relationships:
            if r.link_type not in self._link_types_allowed:
                warnings.append(Warning(
                    severity=Severity.WARNING,
                    message=f"Link type '{r.link_type}' not in discovered JIRA link types",
                    source_key=r.source.key,
                    target_key=r.target.key,
                    link_type=r.link_type,
                ))
        return warnings

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(self, query: str) -> List[dict]:
        """Search nodes by key or summary (case-insensitive)."""
        if not query:
            return []
        q = query.lower()
        matches = []
        for iss in self._issues.values():
            if q in iss.key.lower() or (iss.summary and q in iss.summary.lower()):
                matches.append(iss.to_dict())
        return matches

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def save(self, path: Path) -> None:
        """Save the graph to a JSON file."""
        data = {
            "issues": [iss.to_dict() for iss in self._issues.values()],
            "relationships": [r.to_dict() for r in self._relationships],
            "link_types_allowed": self._link_types_allowed,
        }
        path.write_text(json.dumps(data, indent=2))
        if self.logger:
            self.logger.info("Graph saved to %s (%d issues, %d relationships).",
                             path, len(self._issues), len(self._relationships))

    @classmethod
    def load(cls, path: Path, logger: Optional[logging.Logger] = None) -> "GraphModel":
        """Load a graph from a JSON file."""
        import logging as _logging
        log = logger or _logging.getLogger("jira_viz")

        graph = cls(logger=log)
        data = json.loads(path.read_text())

        # Rebuild issues
        issue_dicts = data.get("issues", [])
        for d in issue_dicts:
            iss = JiraIssue.from_dict(d)
            graph._issues[iss.key] = iss

        # Rebuild relationships (need issues to exist first)
        rel_dicts = data.get("relationships", [])
        for d in rel_dicts:
            source = graph.get_issue(d["source_key"])
            target = graph.get_issue(d["target_key"])
            if source and target:
                rel = Relationship.from_dict(d, source, target)
                graph._relationships.append(rel)
            else:
                log.warning(
                    "Relationship references missing issue: %s -> %s (%s)",
                    d["source_key"], d["target_key"], d.get("link_type"),
                )

        # Restore allowed link types
        graph._link_types_allowed = data.get("link_types_allowed")

        if log:
            log.info("Graph loaded from %s (%d issues, %d relationships).",
                     path, len(graph._issues), len(graph._relationships))

        return graph

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------

    def summary(self) -> str:
        """Return a human-readable summary of the graph."""
        lines = [
            f"Graph: {len(self._issues)} issues, {len(self._relationships)} relationships",
        ]
        if self._link_types_allowed:
            lines.append(f"Allowed link types: {self._link_types_allowed}")
        lines.append("Issues:")
        for iss in self._issues.values():
            lines.append(f"  {iss.key} — {iss.summary} [{iss.issue_type}] {iss.status}")
        lines.append("Relationships:")
        for r in self._relationships:
            lines.append(f"  {r}")
        return "\n".join(lines)
