#!/bin/bash
# Run the JIRA Linked Work Item Tree Visualizer server
# Usage: ./run_tree_server.sh [port]

PORT=${1:-8001}
echo "🌳 Starting JIRA Tree Visualizer on http://localhost:$PORT"
echo "Press Ctrl+C to stop."
echo ""

cd "$(dirname "$0")"
python -m uvicorn jira_tree.server:app --reload --port "$PORT"
