#!/usr/bin/env python3
"""
Phase 1 test script — graph model, validation, layout, serialisation.

Usage:
    python test_phase1.py

This script demonstrates:
1. Building a graph from Phase 0 fetched issues
2. Adding relationships
3. Running validation (self-loops, duplicates, cycles, link type perms)
4. Computing force-directed layout
5. Saving and loading graph to/from JSON
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from jira_viz import (
    get_logger,
    shutdown_logger,
    JIRAFetcher,
    JiraIssue,
    Relationship,
)
from jira_viz.graph import GraphModel
from jira_viz.layout import force_directed_layout


def main() -> None:
    logger = get_logger()

    fetcher = JIRAFetcher(logger)

    try:
        # 1. Connect and fetch
        fetcher.connect()
        link_types = fetcher.fetch_link_types()
        allowed_types = [lt["name"] for lt in link_types]
        issues = fetcher.fetch_issues("project = OKR AND status != Done ORDER BY key", max_results=10)

        if not issues:
            logger.warning("No issues fetched. Nothing to do.")
            return

        # 2. Build graph
        graph = GraphModel(logger=logger)
        graph.add_issues(issues)
        graph.set_allowed_link_types(allowed_types)

        # 3. Add some relationships
        if len(issues) >= 3:
            r1 = Relationship(issues[2], issues[1], link_type="blocks")
            r2 = Relationship(issues[1], issues[0], link_type="relates")
            graph.add_relationship(r1)
            graph.add_relationship(r2)

        # Try to add a self-loop (should be caught by validation)
        if len(issues) >= 1:
            r_self = Relationship(issues[0], issues[0], link_type="relates")
            graph.add_relationship(r_self)

        # 4. Validate
        logger.info("")
        logger.info("=== VALIDATION ===")
        warnings = graph.validate()

        if warnings:
            logger.info("Warnings found:")
            for w in warnings:
                logger.info("  %s", w)
        else:
            logger.info("No warnings.")

        # 5. Print summary
        logger.info("")
        logger.info("=== GRAPH SUMMARY ===")
        logger.info(graph.summary())

        # 6. Run layout
        logger.info("")
        logger.info("=== LAYOUT ===")
        result = force_directed_layout(graph, logger=logger, seed=42)

        logger.info("Computed positions:")
        for pos in result.positions:
            logger.info("  %s: x=%.1f, y=%.1f", pos.key, pos.x, pos.y)

        # 7. Save to JSON
        save_path = Path("phase1_graph.json")
        graph.save(save_path)
        logger.info("")
        logger.info("Graph saved to %s", save_path)

        # 8. Load from JSON
        logger.info("")
        logger.info("=== LOADING FROM JSON ===")
        loaded = GraphModel.load(save_path, logger=logger)
        logger.info(loaded.summary())

        # 9. Validate loaded graph
        logger.info("")
        logger.info("=== VALIDATE LOADED GRAPH ===")
        loaded_warnings = loaded.validate()
        if loaded_warnings:
            for w in loaded_warnings:
                logger.info("  %s", w)
        else:
            logger.info("No warnings on loaded graph.")

        logger.info("")
        logger.info("Phase 1 test complete.")

    except KeyboardInterrupt:
        logger.info("\nInterrupted by user (Ctrl+C). Shutting down gracefully.")

    except Exception as e:
        logger.error("Unhandled error: %s", e, exc_info=True)
        sys.exit(1)

    finally:
        fetcher.close()
        shutdown_logger(logger)
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    main()
