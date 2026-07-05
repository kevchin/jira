#!/usr/bin/env python3
"""
Phase 3 test script — relationship CRUD, validation, commit queue.

Usage:
    python test_phase3.py

Tests:
1. Fetch issues and build a graph
2. Create a relationship via API
3. Validate a self-loop (should fail)
4. Get relationships for a node
5. Delete a relationship via API
6. Check commit queue state
7. Client-side validation endpoint
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import requests
from jira_viz.server import app
from jira_viz.logger import get_logger, shutdown_logger

BASE_URL = "http://127.0.0.1:8766"


def main() -> None:
    logger = get_logger()

    try:
        # Start server in a thread
        import uvicorn
        import threading

        config = uvicorn.Config(app, host="127.0.0.1", port=8766, log_level="warning")
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

        # 1. Fetch issues (builds the active graph)
        logger.info("")
        logger.info("=== TEST 1: Fetch issues ===")
        r = requests.get(
            f"{BASE_URL}/api/issues",
            params={"jql": "project = OKR AND status != Done ORDER BY key", "max_results": 5},
            timeout=10,
        )
        logger.info(f"Status: {r.status_code}")
        data = r.json()
        issues = data["issues"]
        logger.info(f"Fetched {len(issues)} issues.")
        assert len(issues) >= 3, f"Expected >=3 issues, got {len(issues)}"
        for iss in issues[:3]:
            logger.info(f"  {iss['key']}")

        # 2. Create a relationship
        logger.info("")
        logger.info("=== TEST 2: Create relationship ===")
        src = issues[2]["key"]
        tgt = issues[1]["key"]
        r = requests.post(
            f"{BASE_URL}/api/relationships",
            json={"source_key": src, "target_key": tgt, "link_type": "Relates"},
            timeout=10,
        )
        logger.info(f"Raw response: status={r.status_code}, body={r.text[:200]}")
        result = r.json()
        if isinstance(result, dict):
            logger.info(f"Status: {r.status_code}, Created: {result.get('created')}, Queue: {result.get('queue_count')}")
            assert r.status_code == 200
            assert result["created"] is True
            assert result["queue_count"] == 1
        else:
            logger.error(f"Expected dict, got {type(result)}: {result}")
            raise AssertionError(f"Unexpected response format: {type(result)}")

        # 3. Validate self-loop (should fail)
        logger.info("")
        logger.info("=== TEST 3: Self-loop validation ===")
        self_src = issues[0]["key"]
        r = requests.post(
            f"{BASE_URL}/api/relationships",
            json={"source_key": self_src, "target_key": self_src, "link_type": "Relates"},
            timeout=10,
        )
        result = r.json()
        logger.info(f"Status: {r.status_code}, Error: {result.get('error')}, Validation: {result.get('validation')}")
        assert r.status_code == 400
        assert "self-loop" in result.get("validation", [])

        # 4. Get relationships for a node
        logger.info("")
        logger.info("=== TEST 4: Get relationships for node ===")
        r = requests.get(f"{BASE_URL}/api/relationships/{tgt}", timeout=10)
        result = r.json()
        rels = result.get("relationships", [])
        logger.info(f"Status: {r.status_code}, Relationships: {len(rels)}")
        for rel in rels:
            logger.info(f"  {rel['direction']}: {rel['type']} {rel.get('source', '?')} -> {rel.get('target', '?')}")
        assert r.status_code == 200

        # 5. Delete the relationship
        logger.info("")
        logger.info("=== TEST 5: Delete relationship ===")
        r = requests.delete(
            f"{BASE_URL}/api/relationships",
            json={"source_key": src, "target_key": tgt, "link_type": "Relates"},
            timeout=10,
        )
        result = r.json()
        logger.info(f"Status: {r.status_code}, Deleted: {result.get('deleted')}, Queue: {result.get('queue_count')}")
        assert r.status_code == 200
        assert result["deleted"] is True
        assert result["queue_count"] == 1

        # 6. Check commit queue
        logger.info("")
        logger.info("=== TEST 6: Commit queue ===")
        r = requests.get(f"{BASE_URL}/api/commit-queue", timeout=10)
        result = r.json()
        logger.info(f"Queue entries: {result['count']}")
        for e in result["entries"]:
            logger.info(f"  {e['action']}: {e['source_key']} -> {e['target_key']} ({e['link_type']})")
        assert r.status_code == 200
        assert result["count"] == 1
        assert result["entries"][0]["action"] == "delete"

        # 7. Client-side validation endpoint
        logger.info("")
        logger.info("=== TEST 7: Validation endpoint ===")
        r = requests.post(
            f"{BASE_URL}/api/validate",
            json={
                "relationships": [
                    {"source_key": "OKR-1", "target_key": "OKR-1", "link_type": "Relates"},
                    {"source_key": "OKR-2", "target_key": "OKR-3", "link_type": "FooBar"},
                    {"source_key": "OKR-4", "target_key": "OKR-5", "link_type": "Relates"},
                    {"source_key": "OKR-4", "target_key": "OKR-5", "link_type": "Relates"},
                ]
            },
            timeout=10,
        )
        result = r.json()
        warnings = result.get("warnings", [])
        logger.info(f"Status: {r.status_code}, Valid: {result['valid']}, Warnings: {len(warnings)}")
        for w in warnings:
            logger.info(f"  [{w['severity']}] {w['message']}")
        assert r.status_code == 200
        assert result["valid"] is False  # has errors
        assert len(warnings) >= 3  # self-loop + link type + duplicate

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
