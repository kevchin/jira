#!/usr/bin/env python3
"""
Phase 4 test script — Find / Search feature.

Usage:
    python test_phase4.py

Tests:
1. Fetch issues
2. Search by key (exact match)
3. Search by key (partial match)
4. Search by summary (partial match)
5. Search with no results
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import requests
from jira_viz.server import app
from jira_viz.logger import get_logger, shutdown_logger

BASE_URL = "http://127.0.0.1:8767"


def main() -> None:
    logger = get_logger()

    try:
        # Start server in a thread
        import uvicorn
        import threading

        config = uvicorn.Config(app, host="127.0.0.1", port=8767, log_level="warning")
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
            params={"jql": "project = OKR AND status != Done ORDER BY key", "max_results": 10},
            timeout=10,
        )
        data = r.json()
        issues = data["issues"]
        logger.info(f"Fetched {len(issues)} issues.")
        assert len(issues) >= 5
        for iss in issues[:5]:
            logger.info(f"  {iss['key']} — {iss['summary'][:40]}")

        # 2. Search by key (exact match)
        logger.info("")
        logger.info("=== TEST 2: Search by key (exact) ===")
        r = requests.get(f"{BASE_URL}/api/search", params={"q": "OKR-1"}, timeout=10)
        data = r.json()
        matches = data["matches"]
        logger.info(f"Status: {r.status_code}, Matches: {data['count']}")
        for m in matches:
            logger.info(f"  {m['key']}")
        assert r.status_code == 200
        assert data["count"] >= 1
        assert matches[0]["key"] == "OKR-1"

        # 3. Search by key (partial match)
        logger.info("")
        logger.info("=== TEST 3: Search by key (partial) ===")
        r = requests.get(f"{BASE_URL}/api/search", params={"q": "KR"}, timeout=10)
        data = r.json()
        matches = data["matches"]
        logger.info(f"Status: {r.status_code}, Matches: {data['count']}")
        for m in matches:
            logger.info(f"  {m['key']}")
        assert r.status_code == 200
        assert data["count"] >= 3  # OKR-4, OKR-5, OKR-6, etc.

        # 4. Search by summary (partial match)
        logger.info("")
        logger.info("=== TEST 4: Search by summary (partial) ===")
        r = requests.get(f"{BASE_URL}/api/search", params={"q": "security"}, timeout=10)
        data = r.json()
        matches = data["matches"]
        logger.info(f"Status: {r.status_code}, Matches: {data['count']}")
        for m in matches:
            logger.info(f"  {m['key']} — {m['summary'][:50]}")
        assert r.status_code == 200
        assert data["count"] >= 1

        # 5. Search with no results
        logger.info("")
        logger.info("=== TEST 5: Search with no results ===")
        r = requests.get(f"{BASE_URL}/api/search", params={"q": "ZZZZNONEXISTENT"}, timeout=10)
        data = r.json()
        matches = data["matches"]
        logger.info(f"Status: {r.status_code}, Matches: {data['count']}")
        assert r.status_code == 200
        assert data["count"] == 0
        assert len(matches) == 0

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
