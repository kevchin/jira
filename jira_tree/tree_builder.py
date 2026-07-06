"""
Tree Builder — recursively traverse JIRA linked work items.

Given a JQL query for root issues, performs a BFS traversal following all
issue links (both inward and outward) to build the complete tree. Detects
cycles and tags them for special rendering.
"""

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from jira_viz.fetcher import JIRAFetcher, _extract_original_estimate, _extract_start_date
from jira_viz.models import JiraIssue, Relationship
from jira_viz.config import JIRA_BASE_URL
from jira_viz.graph import GraphModel
from jira_tree.config import DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES


@dataclass
class TreeResult:
    """Result of a tree build operation."""

    issues: Dict[str, JiraIssue] = field(default_factory=dict)
    relationships: List[dict] = field(default_factory=list)
    cycle_edges: List[dict] = field(default_factory=list)
    root_keys: List[str] = field(default_factory=list)
    max_depth_reached: int = 0
    total_nodes: int = 0
    cycle_count: int = 0
    nodes_at_depth_limit: int = 0
    warnings: List[str] = field(default_factory=list)


class TreeBuilder:
    """
    Builds a complete tree graph by recursively following JIRA issue links.

    Usage:
        builder = TreeBuilder(fetcher, logger)
        result = builder.build_tree("project = OKR AND issuetype = Epic")
        # result.issues, result.relationships, result.cycle_edges are ready
    """

    def __init__(
        self,
        fetcher: JIRAFetcher,
        logger: logging.Logger,
        max_depth: int = DEFAULT_MAX_DEPTH,
        max_nodes: int = DEFAULT_MAX_NODES,
    ):
        self.fetcher = fetcher
        self.logger = logger
        self.max_depth = max_depth
        self.max_nodes = max_nodes

    def build_tree(
        self,
        root_jql: str,
        max_results: int = 50,
        link_type_filter: Optional[List[str]] = None,
    ) -> TreeResult:
        """
        Build a full tree from root issues matching a JQL query.

        Args:
            root_jql: JQL query to find root issues
            max_results: Max number of root issues to fetch
            link_type_filter: Optional list of link type names to follow.
                              If None, follows ALL link types.

        Returns:
            TreeResult with all issues, relationships, and cycle information.
        """
        result = TreeResult()

        # --- Phase 1: Fetch root issues ---
        self.logger.info("Tree builder: fetching roots with JQL: %s", root_jql)
        try:
            roots = self.fetcher.fetch_issues(root_jql, max_results=max_results)
        except Exception as e:
            self.logger.error("Failed to fetch root issues: %s", e)
            result.warnings.append(f"Root fetch failed: {e}")
            return result

        if not roots:
            self.logger.warning("No root issues found for JQL: %s", root_jql)
            result.warnings.append("No root issues found.")
            return result

        self.logger.info("Found %d root issues.", len(roots))
        result.root_keys = [r.key for r in roots]

        # --- Phase 2: BFS traversal ---
        visited: Set[str] = set()
        to_visit: deque = deque()
        all_issues: Dict[str, JiraIssue] = {}
        all_rels: List[dict] = []
        cycle_edges: List[dict] = []
        depth_of: Dict[str, int] = {}  # Track depth of each node

        # Seed BFS with root issues (depth 0)
        for root in roots:
            to_visit.append((root, 0, None, None))

        link_filter_lower = None
        if link_type_filter:
            link_filter_lower = set(lt.lower() for lt in link_type_filter)

        while to_visit:
            if len(all_issues) >= self.max_nodes:
                self.logger.warning(
                    "Reached max_nodes limit (%d). %d items remain in queue.",
                    self.max_nodes, len(to_visit),
                )
                result.warnings.append(
                    f"Node limit reached ({self.max_nodes}). "
                    f"{len(to_visit)} items not traversed."
                )
                break

            issue, depth, parent_key, parent_link_type = to_visit.popleft()

            # Check if already visited (cycle or duplicate)
            if issue.key in visited:
                # Cycle detected: record edge but don't recurse
                if parent_key and parent_link_type:
                    self.logger.info(
                        "Cycle detected: %s -> %s (%s) [depth %d - already visited at depth %d]",
                        parent_key, issue.key, parent_link_type, depth,
                        depth_of.get(issue.key, "?"),
                    )
                    cycle_edges.append({
                        "source_key": parent_key,
                        "target_key": issue.key,
                        "link_type": parent_link_type,
                        "cycle": True,
                        "depth_at_cycle": depth,
                    })
                    result.cycle_count += 1
                continue

            # Mark visited and store
            visited.add(issue.key)
            all_issues[issue.key] = issue
            depth_of[issue.key] = depth
            result.max_depth_reached = max(result.max_depth_reached, depth)

            # Add relationship from parent (if this isn't a root)
            if parent_key and parent_link_type:
                rel_dict = {
                    "source_key": parent_key,
                    "target_key": issue.key,
                    "link_type": parent_link_type,
                    "direction": "source_to_target",
                    "depth": depth,
                }
                all_rels.append(rel_dict)

            # Stop recursing if we hit max depth
            if depth >= self.max_depth:
                result.nodes_at_depth_limit += 1
                self.logger.debug(
                    "Depth limit (%d) reached for %s — not following further links.",
                    self.max_depth, issue.key,
                )
                continue

            # --- Fetch links for this issue ---
            try:
                links = self.fetcher.fetch_issue_links(issue.key)
            except Exception as e:
                self.logger.warning(
                    "Failed to fetch links for %s: %s — skipping.", issue.key, e
                )
                continue

            self.logger.debug(
                "Issue %s [depth %d]: %d links found.", issue.key, depth, len(links)
            )

            for link in links:
                inward_key = link.get("inward_issue")
                outward_key = link.get("outward_issue")
                link_type = link.get("type", "Unknown")

                if not inward_key or not outward_key:
                    continue

                # Filter by link type if requested
                if link_filter_lower and link_type.lower() not in link_filter_lower:
                    continue

                # Determine which key is the "other" issue (not the current one)
                if outward_key == issue.key:
                    # Current issue is the outward (source) — follow inward
                    other_key = inward_key
                    source_key = issue.key
                    target_key = inward_key
                elif inward_key == issue.key:
                    # Current issue is the inward (target) — follow outward
                    other_key = outward_key
                    source_key = outward_key
                    target_key = issue.key
                else:
                    # Both issues are different from current (shouldn't happen)
                    # This means both outward and inward are other issues
                    # Follow the other that isn't the current issue
                    self.logger.debug(
                        "Link has both issues different from current %s: outward=%s, inward=%s",
                        issue.key, outward_key, inward_key,
                    )
                    # Default: follow outward as source, inward as target
                    other_key = outward_key if outward_key != issue.key else inward_key
                    source_key = outward_key
                    target_key = inward_key

                # If the other issue is already visited, record as cycle edge
                if other_key in visited:
                    cycle_edges.append({
                        "source_key": source_key,
                        "target_key": target_key,
                        "link_type": link_type,
                        "cycle": True,
                        "depth_at_cycle": depth + 1,
                    })
                    result.cycle_count += 1
                    self.logger.debug(
                        "Cross-edge/cycle: %s -> %s (%s) — already visited",
                        source_key, target_key, link_type,
                    )
                    continue

                # If the other issue is not yet fetched and not in queue, fetch it
                if other_key not in all_issues and other_key not in {item[0].key for item in to_visit}:
                    try:
                        other_issue = self._fetch_single_issue(other_key)
                        if other_issue:
                            to_visit.append((other_issue, depth + 1, issue.key, link_type))
                            self.logger.debug(
                                "Queued: %s [depth %d] linked from %s via %s",
                                other_key, depth + 1, issue.key, link_type,
                            )
                        else:
                            self.logger.warning(
                                "Could not fetch linked issue %s (from %s via %s) — may not exist or no permission.",
                                other_key, issue.key, link_type,
                            )
                            result.warnings.append(
                                f"Could not fetch {other_key} (linked from {issue.key})"
                            )
                    except Exception as e:
                        self.logger.error(
                            "Error fetching linked issue %s: %s", other_key, e
                        )
                        result.warnings.append(f"Error fetching {other_key}: {e}")
                else:
                    # Already queued — will be visited later
                    self.logger.debug(
                        "Issue %s already queued (from %s via %s) — skipping duplicate fetch.",
                        other_key, issue.key, link_type,
                    )

        # --- Phase 3: Build result ---
        result.issues = all_issues
        result.relationships = all_rels
        result.cycle_edges = cycle_edges
        result.total_nodes = len(all_issues)

        self.logger.info(
            "Tree build complete: %d nodes, %d relationships, %d cycles, max depth %d.",
            result.total_nodes,
            len(all_rels),
            result.cycle_count,
            result.max_depth_reached,
        )

        if result.nodes_at_depth_limit > 0:
            self.logger.info(
                "%d nodes at depth limit (%d) — deeper links not followed.",
                result.nodes_at_depth_limit, self.max_depth,
            )

        return result

    def build_graph(self, result: TreeResult) -> GraphModel:
        """
        Convert a TreeResult into a GraphModel suitable for layout and API responses.

        Combines regular relationships and cycle edges into the graph.
        """
        from jira_viz.graph import GraphModel

        graph = GraphModel(logger=self.logger)

        # Add all issues
        for iss in result.issues.values():
            graph.add_issue(iss)

        # Add regular relationships
        for rel_dict in result.relationships:
            source = graph.get_issue(rel_dict["source_key"])
            target = graph.get_issue(rel_dict["target_key"])
            if source and target:
                rel = Relationship(
                    source=source,
                    target=target,
                    link_type=rel_dict["link_type"],
                )
                graph.add_relationship(rel)

        # Add cycle edges as relationships too (they exist in JIRA)
        for ce in result.cycle_edges:
            source = graph.get_issue(ce["source_key"])
            target = graph.get_issue(ce["target_key"])
            if source and target:
                rel = Relationship(
                    source=source,
                    target=target,
                    link_type=ce["link_type"],
                )
                graph.add_relationship(rel)

        return graph

    def _fetch_single_issue(self, issue_key: str) -> Optional[JiraIssue]:
        """
        Fetch a single issue by key using the JIRA client.

        Returns None if the issue doesn't exist or can't be fetched.
        """
        if self.fetcher._jira is None:
            self.logger.error("JIRA client not connected.")
            return None

        try:
            raw_issue = self.fetcher._jira.issue(issue_key)
            fields = raw_issue.fields

            # Build JIRA web URL
            jira_web_url = f"{JIRA_BASE_URL}browse/{issue_key}"

            # Extract project
            project_key = None
            if raw_issue.raw and raw_issue.raw.get("fields"):
                project = raw_issue.raw["fields"].get("project", {})
                project_key = project.get("key") or project.get("name")

            issue = JiraIssue(
                key=raw_issue.key,
                summary=fields.summary or "",
                issue_type=fields.issuetype.name if fields.issuetype else "Unknown",
                status=fields.status.name if fields.status else "Unknown",
                priority=fields.priority.name if fields.priority else None,
                assignee=fields.assignee.displayName if fields.assignee else None,
                self_url=str(raw_issue.self) if raw_issue.self else None,
                jira_web_url=jira_web_url,
                project=project_key,
                original_estimate=_extract_original_estimate(raw_issue),
                start_date=_extract_start_date(raw_issue),
            )
            return issue

        except Exception as e:
            self.logger.warning("Failed to fetch issue %s: %s", issue_key, e)
            return None
