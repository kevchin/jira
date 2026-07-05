"""
jira_tree — JIRA Linked Work Item Tree Visualizer

Given a JQL query for root issues, recursively fetches all linked work items
and displays them as an interactive tree graph. Supports editing links at
any level of the hierarchy with cycle detection.
"""

from jira_tree.config import (
    JIRA_BASE_URL,
    JIRA_EMAIL,
    JIRA_API_KEY_FILE,
    LOG_FILE,
    SERVER_PORT,
    STATIC_DIR,
)
from jira_tree.tree_builder import TreeBuilder, TreeResult

__all__ = [
    "TreeBuilder",
    "TreeResult",
]
