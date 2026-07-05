"""
Configuration for jira_tree.

Imports shared settings from jira_viz.config and adds tree-specific settings.
"""

from pathlib import Path

# Re-use JIRA connection settings from jira_viz
from jira_viz.config import (
    JIRA_BASE_URL,
    JIRA_EMAIL,
    JIRA_API_KEY_FILE,
)

# Tree-specific settings
LOG_FILE = Path("jira_tree.log")
SERVER_PORT = 8001  # Different port to avoid conflict
STATIC_DIR = Path("static_tree")

# Default JQL for root issues
DEFAULT_ROOT_JQL = "project = OKR AND status != Done ORDER BY key"

# Tree traversal limits
DEFAULT_MAX_DEPTH = 15     # Maximum recursion depth
DEFAULT_MAX_NODES = 200    # Maximum total nodes to fetch
