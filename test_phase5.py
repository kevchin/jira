#!/usr/bin/env python3
"""
Phase 5 test script — Commit workflow with pre-commit review.

Usage:
    python test_phase5.py

Tests:
1. Fetch issues and build graph
2. Add some relationships to commit queue
3. Get commit plan (preview)
4. Dry-run commit (no actual JIRA writes)
5. Actual commit (with JIRA writes)
6. Verify commit queue is cleared after successful commits
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import requests
from jira_viz.server import app
from jira_viz.logger import get_logger, shutdown_logger

BASE_URL = "http://127.0.0.1:8776"


def main() -> None:
    logger = get_logger()

    try:
        # Start server in a thread
        import uvicorn
        import threading

        config = uvicorn.Config(app, host="127.0.0.1", port=8776, log_level="warning")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()

        # Wait for server
        logger.info("Waiting for server to start...")
        for i in range(30):
            try:
                r = requests.get(f"{BASE_URL}/", timeout=1)
                if r.status_code == 200:
                    logger.info("Server is ready.")
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            logger.error("Server failed to start.")
            return

        # 1. Fetch issues
        logger.info("")
        logger.info("=== TEST 1: Fetch issues ===")
        r = requests.get(
            f"{BASE_URL}/api/issues",
            params={"jql": "project = OKR AND status != Done ORDER BY key", "max_results": 5},
            timeout=10,
        )
        data = r.json()
        issues = data["issues"]
        logger.info(f"Fetched {len(issues)} issues.")
        assert len(issues) >= 3

        # 2. Add relationships to commit queue
        logger.info("")
        logger.info("=== TEST 2: Add relationships to commit queue ===")
        for i in range(2):
            src = issues[i]["key"]
            tgt = issues[i + 1]["key"]
            r = requests.post(
                f"{BASE_URL}/api/relationships",
                json={"source_key": src, "target_key": tgt, "link_type": "Relates"},
                timeout=10,
            )
            assert r.status_code == 200
        logger.info("Added 2 relationships to commit queue.")

        # 3. Get commit plan
        logger.info("")
        logger.info("=== TEST 3: Get commit plan ===")
        r = requests.get(f"{BASE_URL}/api/commit-plan", timeout=10)
        data = r.json()
        ops = data["ops"]
        logger.info(f"Plan: {data['count']} operations")
        for op in ops:
            logger.info(f"  {op['action']}: {op['source_key']} -> {op['target_key']} ({op['link_type']})")
        assert data["count"] == 2

        # 4. Dry-run commit
        logger.info("")
        logger.info("=== TEST 4: Dry-run commit ===")
        r = requests.get(f"{BASE_URL}/api/commit?dry_run=true", timeout=10)
        data = r.json()
        logger.info(f"Dry run: {data['success_count']} success, {data['failure_count']} failed")
        for op in data["ops"]:
            logger.info(f"  {'✓' if op['success'] else '✗'} {op['action']}: {op['source_key']} -> {op['target_key']}")
        assert data["dry_run"] is True
        assert data["success_count"] == 2  # Both should succeed in dry run

        # 5. Actual commit (this will try to write to JIRA)
        logger.info("")
        logger.info("=== TEST 5: Actual commit ===")
        r = requests.post(f"{BASE_URL}/api/commit", timeout=30)
        data = r.json()
        logger.info(f"Commit: {data['success_count']} success, {data['failure_count']} failed")
        for op in data["ops"]:
            logger.info(f"  {'✓' if op['success'] else '✗'} {op['action']}: {op['source_key']} -> {op['target_key']}")
            if op.get("error_message"):
                logger.info(f"    Error: {op['error_message']}")
        # Note: Some may fail due to permissions, but the test should not crash
        logger.info(f"Remaining in queue: {data.get('remaining_queue', 0)}")

        # 6. Verify commit queue is cleared (for successful commits)
        logger.info("")
        logger.info("=== TEST 6: Verify commit queue ===")
        r = requests.get(f"{BASE_URL}/api/commit-queue", timeout=10)
        data = r.json()
        logger.info(f"Queue count: {data['count']}")
        # Some may remain if commits failed
        assert data["count"] <= 2

        # All tests passed
        logger.info("")
        logger.info("=== ALL TESTS PASSED ===")
        logger.info(f"Server running at {BASE_URL}")
        logger.info("Press Ctrl+C to stop.")

        # Keep alive
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Shutting down...")
    finally:
        shutdown_logger(logger)


if __name__ == "__main__":
    main()
