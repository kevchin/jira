"""
Warning dataclass for jira_viz validation results.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class Severity(Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


@dataclass
class Warning:
    """A validation warning with severity and context."""

    severity: Severity
    message: str
    source_key: Optional[str] = None  # JIRA key of the source issue
    target_key: Optional[str] = None  # JIRA key of the target issue
    link_type: Optional[str] = None  # Relationship type (if applicable)

    def __str__(self) -> str:
        parts = [f"[{self.severity.value}] {self.message}"]
        if self.source_key:
            parts.append(f"  source={self.source_key}")
        if self.target_key:
            parts.append(f"  target={self.target_key}")
        if self.link_type:
            parts.append(f"  type={self.link_type}")
        return "\n".join(parts)

    def to_dict(self) -> dict:
        return {
            "severity": self.severity.value,
            "message": self.message,
            "source_key": self.source_key,
            "target_key": self.target_key,
            "link_type": self.link_type,
        }
