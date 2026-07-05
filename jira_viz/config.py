"""
Central configuration for jira_viz.

All constants (JIRA URL, email, file paths) are defined here
to avoid hardcoding in multiple modules.
"""

from pathlib import Path

# JIRA connection
JIRA_BASE_URL = "https://kevchin.atlassian.net/"
JIRA_EMAIL = "kevchin365@gmail.com"
JIRA_API_KEY_FILE = Path("JIRA_API.key")

# Logging
LOG_FILE = Path("jira_viz.log")

# Server
SERVER_PORT = 8000
STATIC_DIR = Path("static")

# Default JQL query (can be blank for empty start)
DEFAULT_JQL_QUERY = "project = OKR AND status != Done ORDER BY key"

# JIRA custom field ID for "Start Date" — adjust to your instance
JIRA_START_DATE_FIELD = "customfield_10015"

# Effort conversion constants (human-readable → seconds)
SECONDS_PER_MINUTE = 60
SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 28800    # 8 hours
SECONDS_PER_WEEK = 144000  # 5 days × 8 hours

# Defaults for missing Gantt data
DEFAULT_ESTIMATE_SECONDS = 28800  # 8h / 1 day
DEFAULT_START_HOUR = 9  # 09:00 local time when anchoring a root issue
