#!/usr/bin/env python3
"""
Phase 2 test script — start the FastAPI server and verify endpoints.

Usage:
    python test_phase2.py

This script:
1. Starts the FastAPI server
2. Verifies each endpoint responds
3. Tests the /api/issues endpoint with a real JQL query
4. Tests the /api/layout endpoint
5. Tests the /log endpoint

Press Ctrl+C to stop the server.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import requests
from jira_viz.server import app
from jira_viz.logger import get_logger, shutdown_logger

BASE_URL = "http://127.0.0.1:8765"


def main() -> None:
    logger = get_logger()

    try:
        # Start server in a thread
        import uvicorn
        import threading

        config = uvicorn.Config(app, host="127.0.0.1", port=8765, log_level="warning")
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()

        # Wait for server to be ready
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

        # Test 1: Root page
        logger.info("")
        logger.info("=== TEST 1: GET / ===")
        r = requests.get(f"{BASE_URL}/", timeout=5)
        logger.info(f"Status: {r.status_code}, Content-Type: {r.headers.get('content-type')}")
        assert r.status_code == 200
        assert "vis-network" in r.text
        logger.info("PASS: Root page serves HTML with vis-network.")

        # Test 2: Link types
        logger.info("")
        logger.info("=== TEST 2: GET /api/link-types ===")
        r = requests.get(f"{BASE_URL}/api/link-types", timeout=10)
        data = r.json()
        logger.info(f"Status: {r.status_code}, Link types: {data['count']}")
        for lt in data["link_types"]:
            logger.info(f"  {lt['name']} (inward: {lt['inward']}, outward: {lt['outward']})")
        assert data["count"] > 0
        logger.info("PASS: Link types fetched.")

        # Test 3: Fetch issues
        logger.info("")
        logger.info("=== TEST 3: GET /api/issues ===")
        r = requests.get(
            f"{BASE_URL}/api/issues",
            params={"jql": "project = OKR AND status != Done ORDER BY key", "max_results": 10},
            timeout=10,
        )
        data = r.json()
        logger.info(f"Status: {r.status_code}, Issues: {data['count']}")
        for iss in data["issues"]:
            logger.info(f"  {iss['key']} — {iss['summary'][:50]} [{iss['issue_type']}]")
        assert data["count"] > 0
        logger.info("PASS: Issues fetched.")

        # Test 4: Layout
        logger.info("")
        logger.info("=== TEST 4: GET /api/layout ===")
        issues_json = __import__("json").dumps(data["issues"])
        r = requests.get(
            f"{BASE_URL}/api/layout",
            params={
                "issues_json": issues_json,
                "relationships_json": "[]",
                "width": 1200,
                "height": 800,
                "seed": 42,
            },
            timeout=10,
        )
        layout_data = r.json()
        logger.info(f"Status: {r.status_code}, Iterations: {layout_data['iterations']}, Energy: {layout_data['final_energy']:.2f}")
        for pos in layout_data["positions"][:5]:
            logger.info(f"  {pos['key']}: x={pos['x']:.1f}, y={pos['y']:.1f}")
        assert len(layout_data["positions"]) == data["count"]
        logger.info("PASS: Layout computed.")

        # Test 5: Log endpoint
        logger.info("")
        logger.info("=== TEST 5: GET /log ===")
        r = requests.get(f"{BASE_URL}/log?lines=5", timeout=5)
        log_data = r.json()
        logger.info(f"Status: {r.status_code}, Total lines: {log_data['total_lines']}, Returned: {len(log_data['entries'])}")
        for entry in log_data["entries"]:
            logger.info(f"  {entry}")
        assert log_data["total_lines"] > 0
        logger.info("PASS: Log endpoint works.")

        logger.info("")
        logger.info("=== ALL TESTS PASSED ===")
        logger.info(f"Server running at {BASE_URL}")
        logger.info("Open http://127.0.0.1:8765 in your browser.")
        logger.info("Press Ctrl+C to stop.")

        # Keep the server running until Ctrl+C
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("\nServer stopped by user.")

    except KeyboardInterrupt:
        logger.info("\nInterrupted. Shutting down.")
    except Exception as e:
        logger.error("Unhandled error: %s", e, exc_info=True)
    finally:
        shutdown_logger(logger)
        logger.info("Shutdown complete.")


if __name__ == "__main__":
    main()
