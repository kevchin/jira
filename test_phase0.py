#!/usr/bin/env python3
"""
Phase 0 test script — fetch JIRA issues, build relationships, log everything.

Usage:
    python test_phase0.py

This script demonstrates:
1. Connecting to JIRA
2. Fetching issues via JQL
3. Fetching available link types
4. Building relationships between issues
5. Logging all operations (including HTTP errors)
6. Graceful shutdown on Ctrl+C
"""

import sys
from pathlib import Path

# Add parent dir to path so we can import jira_viz
sys.path.insert(0, str(Path(__file__).parent))

from jira_viz import get_logger, shutdown_logger, JIRAFetcher, JiraIssue, Relationship


def main() -> None:
    logger = get_logger()

    fetcher = JIRAFetcher(logger)

    try:
        # 1. Connect
        fetcher.connect()

        # 2. Fetch link types
        link_types = fetcher.fetch_link_types()
        for lt in link_types:
            logger.info(
                "  Link type: %s (inward: %s, outward: %s)",
                lt["name"], lt["inward"], lt["outward"],
            )

        # 3. Fetch issues — EDIT this JQL to match your project
        jql = "project = OKR AND status != Done ORDER BY key"
        issues = fetcher.fetch_issues(jql, max_results=20)

        if not issues:
            logger.warning("No issues returned. Try a different JQL query.")
            return

        # 4. Print summary
        logger.info("")
        logger.info("Fetched issues:")
        for i, iss in enumerate(issues, 1):
            logger.info("  %2d. %s — %s [%s] %s", i, iss.key, iss.summary, iss.issue_type, iss.status)

        # 5. Build relationships manually
        logger.info("")
        if len(issues) >= 3:
            r1 = Relationship(issues[2], issues[1], link_type="blocks")
            r2 = Relationship(issues[1], issues[0], link_type="relates")

            logger.info("Created relationships:")
            logger.info("  %s", r1)
            logger.info("  %s", r2)

            # Validate (Phase 1 will do this properly)
            if r1.source.key == r1.target.key:
                logger.warning("WARNING: Self-loop detected — %s", r1)

        elif len(issues) == 2:
            r1 = Relationship(issues[1], issues[0], link_type="relates")
            logger.info("Created relationship:")
            logger.info("  %s", r1)

        logger.info("")
        logger.info("Phase 0 test complete. Check jira_viz.log for full log.")

    except KeyboardInterrupt:
        logger.info("")
        logger.info("Interrupted by user (Ctrl+C). Shutting down gracefully.")

    except Exception as e:
        logger.error("Unhandled error: %s", e, exc_info=True)
        sys.exit(1)

    finally:
        # Graceful shutdown
        fetcher.close()
        shutdown_logger(logger)
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    main()
