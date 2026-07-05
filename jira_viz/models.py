"""
Data models for jira_viz Phase 0.

- JiraIssue: represents a JIRA issue fetched from the API
- Relationship: represents a link between two issues
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class JiraIssue:
    """A JIRA issue with core fields."""

    key: str
    summary: str
    issue_type: str  # e.g. "Bug", "Story", "Task", "Epic"
    status: str  # e.g. "To Do", "In Progress", "Done"
    priority: Optional[str] = None  # e.g. "High", "Medium", "Low"
    assignee: Optional[str] = None  # Display name or None
    project: Optional[str] = None  # e.g. "OKR", "SNOW"
    self_url: Optional[str] = None  # JIRA REST URL for this issue
    jira_web_url: Optional[str] = None  # JIRA web URL (e.g., https://.../browse/OKR-1)
    original_estimate: Optional[int] = None  # seconds (JIRA timeoriginalestimate)
    start_date: Optional[str] = None  # ISO date string (JIRA custom field)

    def __str__(self) -> str:
        return f"{self.key}: {self.summary}"

    def to_dict(self) -> dict:
        """Serialize to a plain dict (JSON-safe)."""
        return {
            "key": self.key,
            "summary": self.summary,
            "issue_type": self.issue_type,
            "status": self.status,
            "priority": self.priority,
            "assignee": self.assignee,
            "project": self.project,
            "self_url": self.self_url,
            "jira_web_url": self.jira_web_url,
            "original_estimate": self.original_estimate,
            "start_date": self.start_date,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "JiraIssue":
        """Deserialize from a plain dict."""
        return cls(
            key=data["key"],
            summary=data["summary"],
            issue_type=data.get("issue_type", "Unknown"),
            status=data.get("status", "Unknown"),
            priority=data.get("priority"),
            assignee=data.get("assignee"),
            project=data.get("project"),
            self_url=data.get("self_url"),
            jira_web_url=data.get("jira_web_url"),
            original_estimate=data.get("original_estimate"),
            start_date=data.get("start_date"),
        )


@dataclass
class Relationship:
    """A directed relationship (link) between two JIRA issues."""

    source: JiraIssue  # The issue that originates the link
    target: JiraIssue  # The issue that the link points to
    link_type: str  # e.g. "blocks", "relates", "duplicates"
    direction: str = "source_to_target"  # Always "source_to_target" in our model

    def __str__(self) -> str:
        return f"{self.source.key} --[{self.link_type}]--> {self.target.key}"

    def to_dict(self) -> dict:
        """Serialize to a plain dict (JSON-safe)."""
        return {
            "source_key": self.source.key,
            "target_key": self.target.key,
            "link_type": self.link_type,
            "direction": self.direction,
        }

    @classmethod
    def from_dict(cls, data: dict, source_issue: JiraIssue, target_issue: JiraIssue) -> "Relationship":
        """Deserialize from a plain dict (requires pre-fetched issues)."""
        return cls(
            source=source_issue,
            target=target_issue,
            link_type=data["link_type"],
            direction=data.get("direction", "source_to_target"),
        )
