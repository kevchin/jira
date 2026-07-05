"""
Gantt chart builder for jira_viz.

Given a set of JIRA issues connected by 'Blocks' relationships,
produces time-scaled bar data for rendering a Gantt chart.

Features:
- Topological sort of the Blocks DAG
- Time assignment: explicit start_dates > blocker end times > today
- Multi-blocker support: issue starts at max(end_time of all blockers)
- Data quality classification (missing estimate, missing start date, missing both)
- Assignee utilization summaries (overlap detection, per-person stats)
- Human-readable effort parsing ('3d', '2.5w', '4h', etc.)
"""

import logging
import re
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Set, Tuple

from jira_viz.config import (
    DEFAULT_ESTIMATE_SECONDS,
    DEFAULT_START_HOUR,
    SECONDS_PER_DAY,
    SECONDS_PER_HOUR,
    SECONDS_PER_MINUTE,
    SECONDS_PER_WEEK,
)
from jira_viz.models import JiraIssue


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class GanttBar:
    """A single bar in the Gantt chart."""
    key: str
    summary: str
    assignee: Optional[str]
    start: str                     # ISO datetime
    end: str                       # ISO datetime
    duration_hours: float
    duration_seconds: int
    level: int                     # row position (0 = root)
    blockers: List[str]            # keys that block this issue
    has_start_date: bool
    has_estimate: bool
    original_estimate_seconds: Optional[int]
    effort_display: str            # human-readable: "3d", "2.5w", etc.
    data_quality: str              # "complete", "missing_estimate", "missing_start_date", "missing_both"

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "summary": self.summary,
            "assignee": self.assignee,
            "start": self.start,
            "end": self.end,
            "duration_hours": self.duration_hours,
            "duration_seconds": self.duration_seconds,
            "level": self.level,
            "blockers": self.blockers,
            "has_start_date": self.has_start_date,
            "has_estimate": self.has_estimate,
            "original_estimate_seconds": self.original_estimate_seconds,
            "effort_display": self.effort_display,
            "data_quality": self.data_quality,
        }


@dataclass
class AssigneeSummary:
    """Per-assignee utilization statistics."""
    assignee: str
    issue_count: int
    total_hours: float
    total_seconds: int
    overlapping_pairs: int
    bar_keys: List[str]

    def to_dict(self) -> dict:
        return {
            "assignee": self.assignee,
            "issue_count": self.issue_count,
            "total_hours": self.total_hours,
            "total_seconds": self.total_seconds,
            "overlapping_pairs": self.overlapping_pairs,
            "bar_keys": self.bar_keys,
        }


@dataclass
class GanttResult:
    """Complete Gantt computation result."""
    bars: List[GanttBar] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    data_quality: dict = field(default_factory=dict)
    assignee_summaries: List[AssigneeSummary] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "bars": [b.to_dict() for b in self.bars],
            "total_duration_hours": sum(b.duration_hours for b in self.bars),
            "warnings": self.warnings,
            "data_quality": self.data_quality,
            "assignee_summaries": [a.to_dict() for a in self.assignee_summaries],
        }


# ---------------------------------------------------------------------------
# Effort parsing
# ---------------------------------------------------------------------------

def parse_effort_to_seconds(input_str: str) -> Optional[int]:
    """Parse human-readable effort string to seconds.

    Examples:
        '3d'    → 86400
        '2.5w'  → 360000
        '4h'    → 14400
        '30m'   → 1800
        '1d 4h' → 43200
        '8'     → 28800 (plain number → hours)

    Returns None if unparseable.
    """
    if not input_str or not input_str.strip():
        return None

    input_str = input_str.strip()

    # Multi-unit: "1d 4h", "2w 3d", etc.
    pattern = r'(\d+\.?\d*)\s*(w|wk|weeks?|d|days?|h|hr|hrs?|hours?|m|min|mins?|minutes?)'
    regex = re.compile(pattern, re.IGNORECASE)

    total = 0
    found = False
    pos = 0

    for match in regex.finditer(input_str):
        val = float(match.group(1))
        unit = match.group(2).lower()[0]  # first char: w/d/h/m
        multipliers = {
            'w': SECONDS_PER_WEEK,
            'd': SECONDS_PER_DAY,
            'h': SECONDS_PER_HOUR,
            'm': SECONDS_PER_MINUTE,
        }
        total += val * multipliers.get(unit, 0)
        found = True
        pos = match.end()

    if not found:
        # Plain number → assume hours
        try:
            val = float(input_str)
            return round(val * SECONDS_PER_HOUR)
        except ValueError:
            return None

    # Check if there's leftover unparsed text (other than whitespace)
    remainder = input_str[pos:].strip()
    if remainder:
        return None

    return round(total)


def format_seconds_to_effort(seconds: Optional[int]) -> str:
    """Format seconds to human-readable effort string.

    Examples:
        86400  → "3d"
        360000 → "2.5w"
        14400  → "4h"
        1800   → "30m"
        43200  → "1.5d"
        None   → "—"
    """
    if seconds is None or seconds <= 0:
        return "—"

    # Try whole weeks
    if seconds >= SECONDS_PER_WEEK and seconds % SECONDS_PER_WEEK == 0:
        return f"{seconds // SECONDS_PER_WEEK}w"

    # Try whole days
    if seconds >= SECONDS_PER_DAY and seconds % SECONDS_PER_DAY == 0:
        return f"{seconds // SECONDS_PER_DAY}d"

    # Try fractional weeks (0.5w increments)
    if seconds >= SECONDS_PER_WEEK:
        weeks = seconds / SECONDS_PER_WEEK
        if weeks == round(weeks * 2) / 2:  # nearest 0.5
            return f"{weeks:.1f}w"

    # Try fractional days (0.5d increments)
    if seconds >= SECONDS_PER_DAY:
        days = seconds / SECONDS_PER_DAY
        if days == round(days * 2) / 2:
            return f"{days:.1f}d"

    # Hours
    if seconds >= SECONDS_PER_HOUR:
        hours = seconds / SECONDS_PER_HOUR
        if hours == round(hours):
            return f"{round(hours)}h"
        return f"{hours:.1f}h"

    # Minutes
    if seconds % SECONDS_PER_MINUTE == 0:
        return f"{seconds // SECONDS_PER_MINUTE}m"

    return f"{seconds / SECONDS_PER_HOUR:.1f}h"


# ---------------------------------------------------------------------------
# GanttBuilder
# ---------------------------------------------------------------------------

class GanttBuilder:
    """Builds Gantt chart data from issues and relationships."""

    def __init__(self, logger: Optional[logging.Logger] = None):
        self.logger = logger

    def _log(self, msg: str, *args):
        if self.logger:
            self.logger.info(msg, *args)

    def build(
        self,
        issues: Dict[str, JiraIssue],
        relationships: List[dict],
        focus_key: Optional[str] = None,
        view: str = "dag",
        assignee_filter: Optional[str] = None,
    ) -> GanttResult:
        """
        Build Gantt chart data.

        Args:
            issues: Dict of issue_key → JiraIssue
            relationships: List of relationship dicts with source_key, target_key, link_type
            focus_key: Optional key to center the chart around
            view: "dag" (topological) or "assignee" (by person)
            assignee_filter: If set, only include bars for this assignee

        Returns:
            GanttResult with bars, warnings, data quality, and assignee summaries.
        """
        result = GanttResult()

        # --- Filter to Blocks relationships only ---
        blocks_rels = [r for r in relationships if r.get("link_type", "").lower() == "blocks"]
        self._log("Gantt: %d Blocks relationships out of %d total.", len(blocks_rels), len(relationships))

        # --- Build adjacency ---
        blockers: Dict[str, Set[str]] = defaultdict(set)   # key → keys that block it
        blocks_forward: Dict[str, Set[str]] = defaultdict(set)  # key → keys it blocks

        for rel in blocks_rels:
            src = rel.get("source_key", "")
            tgt = rel.get("target_key", "")
            if src and tgt and src in issues and tgt in issues:
                blockers[tgt].add(src)
                blocks_forward[src].add(tgt)

        # --- If focus_key provided, restrict to its DAG subset ---
        relevant_keys: Set[str] = set()
        if focus_key and focus_key in issues:
            # BFS from focus_key: collect all ancestors (blockers) and descendants (blocks)
            visited: Set[str] = set()
            queue: deque = deque([focus_key])
            while queue:
                k = queue.popleft()
                if k in visited:
                    continue
                visited.add(k)
                # Follow blockers (ancestors)
                for b in blockers.get(k, set()):
                    if b not in visited:
                        queue.append(b)
                # Follow forward blocks (descendants)
                for f in blocks_forward.get(k, set()):
                    if f not in visited:
                        queue.append(f)
            relevant_keys = visited
            self._log("Gantt: focus_key=%s → %d issues in sub-DAG.", focus_key, len(relevant_keys))
        else:
            relevant_keys = set(issues.keys())

        # --- Topological sort (Kahn's algorithm) ---
        in_degree: Dict[str, int] = {}
        for k in relevant_keys:
            in_degree[k] = len(blockers.get(k, set()) & relevant_keys)

        queue = deque([k for k in relevant_keys if in_degree[k] == 0])
        topo_order: List[str] = []

        while queue:
            k = queue.popleft()
            topo_order.append(k)
            for child in blocks_forward.get(k, set()) & relevant_keys:
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)

        # Cycle detection: if any node remains with in_degree > 0
        cycle_nodes = [k for k in relevant_keys if k not in topo_order]
        if cycle_nodes:
            # Break cycles arbitrarily — add remaining nodes in any order
            self._log("Gantt: %d cycle nodes detected — breaking arbitrarily.", len(cycle_nodes))
            result.warnings.append(
                f"⚠️ Cycle detected among: {', '.join(sorted(cycle_nodes)[:5])}"
                + ("..." if len(cycle_nodes) > 5 else "")
                + " — broke arbitrarily for Gantt."
            )
            topo_order.extend(cycle_nodes)

        # --- Assign times ---
        end_times: Dict[str, datetime] = {}
        today = datetime.now(timezone.utc).replace(
            hour=DEFAULT_START_HOUR, minute=0, second=0, microsecond=0
        )

        bars_temp: Dict[str, dict] = {}

        for key in topo_order:
            iss = issues.get(key)
            if iss is None:
                continue

            # Parse start_date
            proposed_start = None
            has_start_date = False
            if iss.start_date:
                try:
                    s = iss.start_date.replace("Z", "+00:00")
                    proposed_start = datetime.fromisoformat(s)
                    # Ensure UTC-aware
                    if proposed_start.tzinfo is None:
                        proposed_start = proposed_start.replace(tzinfo=timezone.utc)
                    has_start_date = True
                except (ValueError, TypeError):
                    result.warnings.append(f"⚠️ {key}: unparseable start_date '{iss.start_date}' — ignored.")

            # Earliest start from blockers
            blocker_keys = blockers.get(key, set()) & relevant_keys
            earliest_from_blockers = None
            for bk in blocker_keys:
                if bk in end_times:
                    if earliest_from_blockers is None or end_times[bk] > earliest_from_blockers:
                        earliest_from_blockers = end_times[bk]

            # Determine actual start
            if proposed_start and earliest_from_blockers:
                start = max(proposed_start, earliest_from_blockers)
                if proposed_start < earliest_from_blockers:
                    result.warnings.append(
                        f"ℹ️ {key}: start_date {proposed_start.date()} is earlier than "
                        f"blockers' end ({earliest_from_blockers.date()}) — pushed forward."
                    )
            elif proposed_start:
                start = proposed_start
            elif earliest_from_blockers:
                start = earliest_from_blockers
            else:
                start = today
                if not has_start_date:
                    result.warnings.append(
                        f"⚠️ {key}: root issue with no start_date — anchored to {today.date()}."
                    )

            # Duration
            has_estimate = iss.original_estimate is not None and iss.original_estimate > 0
            duration_seconds = iss.original_estimate if has_estimate else DEFAULT_ESTIMATE_SECONDS
            if not has_estimate:
                result.warnings.append(f"⚠️ {key}: no original_estimate — defaulted to {DEFAULT_ESTIMATE_SECONDS // 3600}h.")

            end = start + timedelta(seconds=duration_seconds)
            end_times[key] = end

            # Data quality
            if has_start_date and has_estimate:
                data_quality = "complete"
            elif not has_start_date and not has_estimate:
                data_quality = "missing_both"
            elif not has_start_date:
                data_quality = "missing_start_date"
            else:
                data_quality = "missing_estimate"

            bars_temp[key] = {
                "key": key,
                "summary": (iss.summary or "")[:60],
                "assignee": iss.assignee,
                "start": start,
                "end": end,
                "duration_seconds": duration_seconds,
                "blockers": sorted(blocker_keys),
                "has_start_date": has_start_date,
                "has_estimate": has_estimate,
                "original_estimate_seconds": iss.original_estimate if has_estimate else None,
                "data_quality": data_quality,
            }

        # --- Assign levels (greedy non-overlap for DAG view) ---
        if view == "dag":
            sorted_by_start = sorted(
                bars_temp.values(),
                key=lambda b: (b["start"], b["key"])
            )
            levels: Dict[str, int] = {}
            level_occupied_until: List[datetime] = []

            for bar in sorted_by_start:
                key = bar["key"]
                # Find the lowest level where this bar fits
                assigned = False
                for lvl, occupied_until in enumerate(level_occupied_until):
                    if bar["start"] >= occupied_until:
                        levels[key] = lvl
                        level_occupied_until[lvl] = bar["end"]
                        assigned = True
                        break
                if not assigned:
                    levels[key] = len(level_occupied_until)
                    level_occupied_until.append(bar["end"])

        # --- Assignee view: group by assignee ---
        elif view == "assignee":
            assignee_order: Dict[str, int] = {}
            assignee_list = sorted(
                set(
                    b.get("assignee") or "Unassigned"
                    for b in bars_temp.values()
                )
            )
            # Put "Unassigned" last
            if "Unassigned" in assignee_list:
                assignee_list.remove("Unassigned")
                assignee_list.append("Unassigned")
            for idx, name in enumerate(assignee_list):
                assignee_order[name] = idx

            levels = {}
            for bar in bars_temp.values():
                name = bar.get("assignee") or "Unassigned"
                levels[bar["key"]] = assignee_order.get(name, len(assignee_list))

        else:
            levels = {k: 0 for k in bars_temp}

        # --- Build GanttBar list ---
        bars: List[GanttBar] = []
        for key, b in bars_temp.items():
            duration_hours = b["duration_seconds"] / SECONDS_PER_HOUR
            bar = GanttBar(
                key=b["key"],
                summary=b["summary"],
                assignee=b["assignee"],
                start=b["start"].isoformat(),
                end=b["end"].isoformat(),
                duration_hours=round(duration_hours, 2),
                duration_seconds=b["duration_seconds"],
                level=levels.get(key, 0),
                blockers=b["blockers"],
                has_start_date=b["has_start_date"],
                has_estimate=b["has_estimate"],
                original_estimate_seconds=b["original_estimate_seconds"],
                effort_display=format_seconds_to_effort(b["duration_seconds"]),
                data_quality=b["data_quality"],
            )
            bars.append(bar)

        # Sort bars by start time for determinism
        bars.sort(key=lambda b: (b.start, b.key))
        result.bars = bars

        # --- Data quality summary ---
        dq = {"total": len(bars), "complete": 0, "missing_estimate": 0,
              "missing_start_date": 0, "missing_both": 0}
        for bar in bars:
            dq[bar.data_quality] = dq.get(bar.data_quality, 0) + 1
        result.data_quality = dq

        # --- Assignee summaries ---
        assignee_groups: Dict[str, List[GanttBar]] = defaultdict(list)
        for bar in bars:
            name = bar.assignee or "Unassigned"
            if assignee_filter and name.lower() != assignee_filter.lower():
                continue
            assignee_groups[name].append(bar)

        summaries: List[AssigneeSummary] = []
        for name in sorted(assignee_groups.keys()):
            group_bars = assignee_groups.get(name, [])
            total_hours = sum(b.duration_hours for b in group_bars)
            total_seconds = sum(b.duration_seconds for b in group_bars)

            # Detect overlapping pairs
            overlapping = 0
            sorted_group = sorted(group_bars, key=lambda b: b.start)
            for i in range(len(sorted_group)):
                for j in range(i + 1, len(sorted_group)):
                    a = sorted_group[i]
                    b_bar = sorted_group[j]
                    a_end = datetime.fromisoformat(a.end)
                    b_start = datetime.fromisoformat(b_bar.start)
                    if b_start < a_end:
                        overlapping += 1
                    else:
                        break  # Since sorted by start, if this doesn't overlap, later ones won't either

            summaries.append(AssigneeSummary(
                assignee=name,
                issue_count=len(group_bars),
                total_hours=round(total_hours, 1),
                total_seconds=total_seconds,
                overlapping_pairs=overlapping,
                bar_keys=[b.key for b in group_bars],
            ))

        result.assignee_summaries = summaries

        return result
