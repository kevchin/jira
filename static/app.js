/*
 * jira_viz frontend — Phase 2 (static canvas rendering)
 *
 * Uses vis.js for graph rendering.
 * Communicates with FastAPI backend via JSON API.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let issues = [];          // Array of issue objects from API
let relationships = [];   // Array of relationship objects
let network = null;       // vis.js Network instance
let linkTypes = [];       // Available link types from JIRA
let commitQueueCount = 0; // Number of uncommitted changes
const MAX_ISSUES_TO_DISPLAY = 50;  // Warn if more issues than this

// Drag-and-drop state
let dragSourceNode = null;
let dragTargetNode = null;
let pendingDrag = null;   // { source: nodeId, pos: {x,y} }

// Context menu state
let selectedEdge = null;  // { from, to }
let contextMenuPos = { x: 0, y: 0 };

// Connections panel state
let connectionsPanelOpen = false;
let connectionsPanelNode = null;

// ---------------------------------------------------------------------------
// Colour palette for relationship types
// ---------------------------------------------------------------------------
const LINK_TYPE_COLORS = {
    "blocks":        "#e74c3c",  // Red
    "is blocked by": "#e74c3c",
    "relates":       "#3498db",  // Blue
    "is related to": "#3498db",
    "duplicates":    "#9b59b6",  // Purple
    "is duplicated by": "#9b59b6",
    "clones":        "#2ecc71",  // Green
    "is cloned by":  "#2ecc71",
    "requires":      "#f39c12",  // Orange
    "is required by": "#f39c12",
    "causes":        "#1abc9c",  // Teal
    "is caused by":  "#1abc9c",
};

function getLinkTypeColor(type) {
    return LINK_TYPE_COLORS[type] || "#95a5a6";  // Grey default
}

// Get darker link type color for light mode
function getLinkTypeColorLight(type) {
    const darker = {
        "blocks":        "#c0392b",
        "is blocked by": "#c0392b",
        "relates":       "#2980b9",
        "is related to": "#2980b9",
        "duplicates":    "#8e44ad",
        "is duplicated by": "#8e44ad",
        "clones":        "#27ae60",
        "is cloned by":  "#27ae60",
        "requires":      "#d68910",
        "is required by": "#d68910",
        "causes":        "#16a085",
        "is caused by":  "#16a085",
    };
    return darker[type] || "#7f8c8d";
}

// ---------------------------------------------------------------------------
// Issue type colours (node background)
// ---------------------------------------------------------------------------
const ISSUE_TYPE_COLORS = {
    "Epic":     "#8e44ad",
    "Story":    "#2980b9",
    "Task":     "#27ae60",
    "Bug":      "#c0392b",
    "Sub-task": "#7f8c8d",
    "Key Result": "#d35400",
};

function getIssueTypeColor(type) {
    return ISSUE_TYPE_COLORS[type] || "#34495e";
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function apiGet(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
}

async function apiPost(url, body) {
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`API error ${resp.status}: ${text}`);
    }
    return resp.json();
}

// ---------------------------------------------------------------------------
// Fetch issues
// ---------------------------------------------------------------------------
async function fetchIssues() {
    const jql = document.getElementById("jql-input").value.trim();
    if (!jql) {
        setStatus("Please enter a JQL query.", "warn");
        return;
    }

    setStatus("Fetching issues and relationships...", "info");
    document.getElementById("btn-fetch").disabled = true;

    try {
        const data = await apiGet(`/api/issues?jql=${encodeURIComponent(jql)}&max_results=50`);
        issues = data.issues || [];
        relationships = data.relationships || [];
        document.getElementById("issue-count").textContent = `${issues.length} issues, ${relationships.length} relationships`;
        document.getElementById("btn-layout").disabled = issues.length === 0;

        // Check if too many issues to display
        if (issues.length > MAX_ISSUES_TO_DISPLAY) {
            const confirmMsg = `⚠️ Your query returned ${issues.length} issues (max recommended: ${MAX_ISSUES_TO_DISPLAY}).\n\nDisplaying this many issues may make the canvas cluttered and slow.\n\nContinue anyway?`;
            if (!confirm(confirmMsg)) {
                setStatus(`Cancelled. ${issues.length} issues fetched but not displayed.`, "warn");
                issues = [];
                relationships = [];
                document.getElementById("issue-count").textContent = "0 issues";
                document.getElementById("btn-layout").disabled = true;
                return;
            }
        }

        // Prepopulate filter dropdowns
        updateFilterOptions();

        setStatus(`Fetched ${issues.length} issues, ${relationships.length} relationships.`, "info");
        renderGraph();
    } catch (err) {
        setStatus(`Error fetching issues: ${err.message}`, "error");
        console.error(err);
    } finally {
        document.getElementById("btn-fetch").disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Update filter dropdown options from current issue set
// ---------------------------------------------------------------------------
function updateFilterOptions() {
    const fieldSelect = document.getElementById("filter-field");
    if (!fieldSelect) return;

    const currentField = fieldSelect.value;
    const fieldValues = {};

    // Handle relationship types separately
    if (currentField === "link_type") {
        const types = new Set();
        for (const rel of relationships) {
            if (rel.link_type) types.add(rel.link_type);
        }
        fieldValues["link_type"] = [...types].sort();
    } else {
        const fields = ["issue_type", "status", "project", "assignee"];
        for (const field of fields) {
            const values = new Set();
            for (const iss of issues) {
                const val = iss[field];
                if (val !== undefined && val !== null && val !== "") {
                    values.add(typeof val === "string" ? val : String(val));
                }
            }
            fieldValues[field] = [...values].sort();
        }
    }

    // Update the value dropdown based on selected field
    const valueSelect = document.getElementById("filter-value");
    if (!valueSelect) return;

    // If current field has values, populate the value dropdown
    if (currentField && fieldValues[currentField]) {
        const options = fieldValues[currentField];
        valueSelect.innerHTML = "";
        for (const opt of options) {
            const option = document.createElement("option");
            option.value = opt;
            option.textContent = opt;
            valueSelect.appendChild(option);
        }
    } else {
        // Reset to text input if no predefined values
        valueSelect.innerHTML = "";
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Enter value...";
        valueSelect.appendChild(placeholder);
        valueSelect.disabled = false;
        valueSelect.type = "text";
    }

    // Change field selector to dropdown if it has predefined values
    if (currentField && fieldValues[currentField] && fieldValues[currentField].length > 0) {
        // Keep as dropdown
    } else {
        // Convert to text input
        fieldSelect.type = "text";
        fieldSelect.placeholder = "Enter field name...";
    }
}

// ---------------------------------------------------------------------------
// Fetch link types
// ---------------------------------------------------------------------------
async function fetchLinkTypes() {
    try {
        const data = await apiGet("/api/link-types");
        linkTypes = data.link_types || [];
        const names = linkTypes.map(lt => lt.name).join(", ");
        document.getElementById("link-types-display").textContent =
            `Link types: ${names || "none"}`;
        console.log(`Loaded ${linkTypes.length} link types: ${names}`);
    } catch (err) {
        setStatus(`Error fetching link types: ${err.message}`, "error");
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Compute layout
// ---------------------------------------------------------------------------
async function computeLayout() {
    if (issues.length === 0) {
        setStatus("No issues to layout.", "warn");
        return;
    }

    setStatus("Computing layout...", "info");

    try {
        const issuesJson = JSON.stringify(issues);
        const relsJson = JSON.stringify(relationships);
        const url = `/api/layout?issues_json=${encodeURIComponent(issuesJson)}&relationships_json=${encodeURIComponent(relsJson)}&width=1200&height=800&seed=42`;
        const data = await apiGet(url);

        console.log(`Layout: ${data.iterations} iterations, energy=${data.final_energy.toFixed(2)}`);
        renderGraph(data.positions);
        setStatus(`Layout complete: ${data.iterations} iterations.`, "info");
    } catch (err) {
        setStatus(`Error computing layout: ${err.message}`, "error");
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Render graph with vis.js
// ---------------------------------------------------------------------------
function renderGraph(positions) {
    // Build vis.js data
    const visNodes = [];
    for (const iss of issues) {
        const typeColor = getIssueTypeColor(iss.issue_type);
        // Truncate summary to ~60 chars
        let summary = iss.summary && iss.summary.length > 60
            ? iss.summary.substring(0, 57) + "..."
            : (iss.summary || "");

        visNodes.push({
            id: iss.key,
            label: `${iss.key}\n${summary}`,
            title: buildNodeTooltip(iss),
            color: {
                background: typeColor,
                border: darkenColor(typeColor, 30),
                highlight: { background: lightenColor(typeColor, 30), border: typeColor },
                hover: { background: lightenColor(typeColor, 15), border: typeColor },
            },
            font: {
                color: "#ffffff",
                size: 14,
                face: "monospace",
            },
            shape: "box",
            borderWidth: 2,
            shadow: true,
            widthConstraint: { maximum: 250 },
            margin: { top: 8, bottom: 8, left: 10, right: 10 },
        });
    }

    const visEdges = [];
    const isLight = !isDarkTheme;
    for (const rel of relationships) {
        const color = isLight ? getLinkTypeColorLight(rel.link_type) : getLinkTypeColor(rel.link_type);
        const strokeColor = isLight ? "#d5d8dc" : "#ffffff";
        visEdges.push({
            from: rel.source_key,
            to: rel.target_key,
            label: rel.link_type,
            arrows: "to",
            color: { color: color, highlight: lightenColor(color, 20), hover: lightenColor(color, 10) },
            font: {
                color: color,
                size: 11,
                face: "sans-serif",
                strokeWidth: 0,
                strokeColor: strokeColor,
            },
            width: 2,
            smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.4 },
        });
    }

    const data = { nodes: visNodes, edges: visEdges };

    // vis.js options: disable physics (we supply positions), enable zoom/pan
    const options = {
        nodes: {
            fixed: positions ? { x: true, y: true } : false,
        },
        edges: {
            smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.4 },
        },
        physics: {
            enabled: positions === undefined,  // Use physics only if no positions supplied
            stabilization: { iterations: 150 },
        },
        interaction: {
            zoomView: true,
            dragView: true,
            hover: true,
            navigationButtons: true,
        },
        layout: {
            improvedLayout: issues.length <= 50,
        },
    };

    // If we have positions from the backend, apply them
    if (positions) {
        for (const pos of positions) {
            const node = data.nodes.find(n => n.id === pos.key);
            if (node) {
                node.x = pos.x;
                node.y = pos.y;
            }
        }
    }

    const container = document.getElementById("mynetwork");

    // Destroy previous network if it exists
    if (network) {
        network.destroy();
        network = null;
    }

    network = new vis.Network(container, data, options);

    // Log the render event
    appendToLogPanel(`RENDER: ${data.nodes.length} nodes, ${data.edges.length} edges, positions=${positions ? "yes" : "no (physics)"}`);
    console.log(`Rendered graph: ${data.nodes.length} nodes, ${data.edges.length} edges`);

    // Re-init interactions for the new network
    initDragAndDrop();
    initDoubleClick();
    initContextMenu();
}

// ---------------------------------------------------------------------------
// Tooltip builder
// ---------------------------------------------------------------------------
function buildNodeTooltip(iss) {
    let t = `${iss.key} — ${iss.summary || "(no summary)"}`;
    t += `\nType: ${iss.issue_type || "?"}`;
    t += `\nStatus: ${iss.status || "?"}`;
    if (iss.assignee) t += `\nAssignee: ${iss.assignee}`;
    return t;
}

// ---------------------------------------------------------------------------
// Log panel
// ---------------------------------------------------------------------------
let logRefreshInterval = null;

function startLogRefresh() {
    if (logRefreshInterval) clearInterval(logRefreshInterval);
    logRefreshInterval = setInterval(fetchLog, 2000);
    fetchLog();
}

async function fetchLog() {
    try {
        const data = await apiGet("/log?lines=200");
        const entries = data.entries || [];
        const total = data.total_lines || 0;
        document.getElementById("log-total-lines").textContent = `(${total} lines)`;

        const content = document.getElementById("log-content");
        // Only update if the number of entries changed (avoid flicker)
        if (content.childElementCount !== entries.length) {
            content.innerHTML = entries.map(line => {
                // Detect severity from log format
                let cls = "log-info";
                if (line.includes("ERROR")) cls = "log-error";
                else if (line.includes("WARNING")) cls = "log-warn";
                return `<div class="${cls}">${escapeHtml(line)}</div>`;
            }).join("");
        }

        // Auto-scroll to bottom
        content.scrollTop = content.scrollHeight;
    } catch (err) {
        console.error("Log fetch error:", err);
    }
}

function clearLogPanel() {
    document.getElementById("log-content").innerHTML = "";
}

function appendToLogPanel(msg) {
    const content = document.getElementById("log-content");
    const div = document.createElement("div");
    div.className = "log-info";
    div.textContent = msg;
    content.appendChild(div);
    content.scrollTop = content.scrollHeight;
}

function escapeHtml(text) {
    const d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function setStatus(msg, type) {
    const el = document.getElementById("network-status");
    el.textContent = msg;
    el.className = `status status-${type || "info"}`;
    console.log(`[${type || "info"}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
function darkenColor(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const r = Math.max(0, (num >> 16) - percent);
    const g = Math.max(0, ((num >> 8) & 0x00FF) - percent);
    const b = Math.max(0, (num & 0x0000FF) - percent);
    return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

function lightenColor(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const r = Math.min(255, (num >> 16) + percent);
    const g = Math.min(255, ((num >> 8) & 0x00FF) + percent);
    const b = Math.min(255, (num & 0x0000FF) + percent);
    return `#${(0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1)}`;
}

// ---------------------------------------------------------------------------
// Drag-and-drop relationship creation
// ---------------------------------------------------------------------------
function initDragAndDrop() {
    if (!network) return;

    network.on("dragStart", function (params) {
        if (params.nodes.length > 0) {
            dragSourceNode = params.nodes[0];
            pendingDrag = { source: dragSourceNode };
        }
    });

    network.on("dragEnd", function (params) {
        if (pendingDrag && params.nodes.length > 0) {
            const endNode = params.nodes[0];
            if (endNode !== pendingDrag.source) {
                // Dragged from one node to another — create relationship
                showRelationshipDialog(pendingDrag.source, endNode);
            }
            pendingDrag = null;
            dragSourceNode = null;
        }
    });
}

// ---------------------------------------------------------------------------
// Relationship dialog
// ---------------------------------------------------------------------------
function showRelationshipDialog(sourceId, targetId) {
    const dialog = document.getElementById("rel-dialog");
    document.getElementById("rel-dialog-source").textContent = sourceId;
    document.getElementById("rel-dialog-target").textContent = targetId;

    const typesContainer = document.getElementById("rel-dialog-types");
    typesContainer.innerHTML = "";

    // Show discovered link types
    for (const lt of linkTypes) {
        const btn = document.createElement("button");
        btn.textContent = `${lt.name} (outward: ${lt.outward})`;
        btn.onclick = () => createRelationship(sourceId, targetId, lt.name);
        typesContainer.appendChild(btn);
    }

    // Also show common types not in discovered list (for flexibility)
    const commonTypes = ["blocks", "relates", "duplicates", "clones", "requires", "causes"];
    const discoveredNames = linkTypes.map(lt => lt.name.toLowerCase());
    for (const ct of commonTypes) {
        if (!discoveredNames.includes(ct.toLowerCase())) {
            const btn = document.createElement("button");
            btn.textContent = ct;
            btn.style.opacity = "0.5";
            btn.title = "Not in discovered JIRA link types — may be rejected";
            btn.onclick = () => createRelationship(sourceId, targetId, ct);
            typesContainer.appendChild(btn);
        }
    }

    dialog.style.display = "flex";
}

function cancelRelationship() {
    document.getElementById("rel-dialog").style.display = "none";
    pendingDrag = null;
}

async function createRelationship(sourceId, targetId, linkType) {
    document.getElementById("rel-dialog").style.display = "none";
    pendingDrag = null;

    // Client-side validation
    if (sourceId === targetId) {
        setStatus(`Self-loop rejected: ${sourceId} cannot link to itself`, "error");
        appendToLogPanel(`WARNING: Validation rejected: self-loop — ${sourceId} → ${sourceId}`);
        return;
    }

    setStatus(`Creating relationship: ${sourceId} → ${targetId} (${linkType})`, "info");

    try {
        const resp = await fetch("/api/relationships", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_key: sourceId, target_key: targetId, link_type: linkType }),
        });

        const data = await resp.json();

        if (!resp.ok) {
            setStatus(`Error: ${data.error}`, "error");
            appendToLogPanel(`ERROR: Failed to create relationship: ${data.error}`);
            return;
        }

        // Add to local state
        relationships.push({ source_key: sourceId, target_key: targetId, link_type: linkType });
        commitQueueCount = data.queue_count || 0;
        updateCommitQueueDisplay();

        setStatus(`Relationship created: ${sourceId} → ${targetId} (${linkType})`, "info");
        appendToLogPanel(`INFO: Relationship added: ${sourceId} → ${targetId} (${linkType})`);
        appendToLogPanel(`INFO: Queued for commit: ${sourceId} → ${targetId} (${linkType})`);

        // Re-render graph
        renderGraph();

    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Double-click: show connections panel
// ---------------------------------------------------------------------------
function initDoubleClick() {
    if (!network) return;

    network.on("doubleClick", function (params) {
        if (params.nodes.length > 0) {
            const nodeId = params.nodes[0];
            showConnectionsPanel(nodeId);
        }
    });
}

async function showConnectionsPanel(nodeId) {
    console.log("[Connections] Opening panel for:", nodeId);
    const panel = document.getElementById("connections-panel");
    document.getElementById("connections-node-key").textContent = nodeId;
    const content = document.getElementById("connections-content");
    content.innerHTML = "Loading...";
    panel.style.display = "flex";
    connectionsPanelOpen = true;
    connectionsPanelNode = nodeId;
    console.log("[Connections] Panel display:", panel.style.display);

    try {
        const resp = await fetch(`/api/relationships/${encodeURIComponent(nodeId)}`);
        const data = await resp.json();

        if (data.error) {
            content.innerHTML = `<p style="color:#f38ba8">${data.error}</p>`;
            return;
        }

        content.innerHTML = "";
        if (data.relationships.length === 0) {
            content.innerHTML = "<p style='color:#6c7086'>No connections.</p>";
            return;
        }

        // Sort relationships: by direction (incoming first), then by type, then by source key
        const sortedRevs = [...data.relationships].sort((a, b) => {
            // Incoming first
            if (a.direction !== b.direction) {
                return a.direction === "incoming" ? -1 : 1;
            }
            // Then by type
            if (a.type.toLowerCase() !== b.type.toLowerCase()) {
                return a.type.toLowerCase().localeCompare(b.type.toLowerCase());
            }
            // Then by source key
            return a.source.localeCompare(b.source);
        });

        for (const rel of sortedRevs) {
            const div = document.createElement("div");
            div.className = `conn-item ${rel.direction}`;

            // Show both keys clearly: "OtherNode [type] CenterNode" or "CenterNode [type] OtherNode"
            let leftNode, rightNode;
            if (rel.direction === "incoming") {
                // Other node is the source (the one linking TO center)
                leftNode = rel.source;  // e.g., OKR-9
                rightNode = rel.target; // e.g., OKR-2 (center)
            } else {
                // Outgoing: center links TO other
                leftNode = rel.source;  // e.g., OKR-2 (center)
                rightNode = rel.target; // e.g., OKR-9
            }

            // Click to focus on the OTHER node (not the center)
            const otherKey = rel.direction === "incoming" ? rel.source : rel.target;

            // Get JIRA web URLs for both nodes
            const leftUrl = getJiraWebUrl(leftNode);
            const rightUrl = getJiraWebUrl(rightNode);

            div.innerHTML = `
                <span class="conn-type">${rel.type}</span>
                <span class="conn-key"> <a href="${leftUrl}" target="_blank" class="conn-url" title="Open ${leftNode} in JIRA">${leftNode}</a> → <a href="${rightUrl}" target="_blank" class="conn-url" title="Open ${rightNode} in JIRA">${rightNode}</a></span>
                <button class="conn-delete-btn" onclick="event.stopPropagation(); deleteConnection('${leftNode}', '${rightNode}', '${rel.type}')" title="Delete this relationship">×</button>
            `;
            div.style.cursor = "pointer";
            div.onclick = () => focusOnNode(otherKey);
            content.appendChild(div);
        }

        // Note: "Show direct connections" and "+ Add connection" buttons
        // are now in the HTML header sections, not dynamically created

    } catch (err) {
        content.innerHTML = `<p style="color:#f38ba8">Error: ${err.message}</p>`;
    }
}

// Highlight a single node (hide all others, show only this one)
function highlightSingleNode(nodeKey) {
    if (!network || !issues.length) return;
    
    const nodeData = [];
    for (const iss of issues) {
        const isTarget = iss.key === nodeKey;
        nodeData.push({
            id: iss.key,
            hidden: !isTarget,
            style: isTarget ? {
                background: "#ffd700",
                border: "3px solid #ffd700",
                font: { size: 14, color: "#1e1e2e", bold: true }
            } : undefined
        });
    }
    
    // Hide all edges
    const edgeData = [];
    if (network.body.data.edges) {
        network.body.data.edges.forEach(edge => {
            edgeData.push({ id: edge.id, hidden: true });
        });
    }
    
    network.body.data.nodes.update(nodeData);
    if (edgeData.length > 0) {
        network.body.data.edges.update(edgeData);
    }
    
    // Fit to the single node
    network.fit({ nodes: [nodeKey], animation: true, scale: 1.2 });
}

function focusConnectedSubgraph(centerKey, relationships) {
    // Collect all connected node keys
    const connectedKeys = new Set([centerKey]);
    for (const rel of relationships) {
        connectedKeys.add(rel.source);
        connectedKeys.add(rel.target);
    }

    // Get all node IDs
    const allKeys = issues.map(iss => iss.key);

    // Hide nodes not in the connected set
    const hiddenNodes = allKeys.filter(k => !connectedKeys.has(k));
    const visibleNodes = allKeys.filter(k => connectedKeys.has(k));

    if (network) {
        // Update nodes: set visibility
        const nodeData = [];
        for (const iss of issues) {
            const isVisible = connectedKeys.has(iss.key);
            nodeData.push({
                id: iss.key,
                hidden: !isVisible,
            });
        }
        network.body.data.nodes.update(nodeData);

        // Update edges: only show edges between visible nodes
        const edgeData = [];
        for (const rel of relationships) {
            edgeData.push({
                from: rel.source,
                to: rel.target,
                hidden: false,
            });
        }
        // Also include existing edges between visible nodes
        const existingEdges = network.body.data.edges.get() || [];
        for (const edge of existingEdges) {
            if (!edgeData.find(e => e.from === edge.from && e.to === edge.to)) {
                // Check if both endpoints are visible
                if (connectedKeys.has(edge.from) && connectedKeys.has(edge.to)) {
                    edgeData.push({
                        id: edge.id,
                        hidden: false,
                    });
                }
            }
        }
        network.body.data.edges.update(edgeData);

        // Re-layout visible nodes to spread them out
        if (visibleNodes.length > 2) {
            try {
                const physics = network.options.physics;
                network.body.data.nodes.update(visibleNodes.map(key => ({ id: key })), { physics: true });
                // Give layout time to settle
                setTimeout(() => {
                    network.fit({
                        nodes: visibleNodes,
                        animation: true,
                        scale: 0.7,
                        margin: 80,
                    });
                }, 300);
            } catch (err) {
                // Fallback: just fit without re-layout
                network.fit({
                    nodes: visibleNodes,
                    animation: true,
                    scale: 0.7,
                    margin: 80,
                });
            }
        } else {
            network.fit({
                nodes: visibleNodes,
                animation: true,
                scale: 0.7,
                margin: 80,
            });
        }
    }

    // Show restore button
    const restoreBtn = document.getElementById("btn-restore");
    if (restoreBtn) restoreBtn.style.display = "inline";

    appendToLogPanel(`INFO: Focused on ${centerKey} and ${connectedKeys.size - 1} connected nodes (${hiddenNodes.length} hidden)`);
}

// ---------------------------------------------------------------------------
// Show all related nodes via any relationship (transitive closure)
// ---------------------------------------------------------------------------
let allRelatedActive = false;

function showAllRelated() {
    if (!network) return;
    
    // Toggle: if already active, restore full graph
    if (allRelatedActive) {
        restoreFullGraph();
        allRelatedActive = false;
        return;
    }
    
    const focusKey = document.getElementById("connections-node-key").textContent.trim();
    if (!focusKey) return;
    
    // Build adjacency list from relationships
    const adjacency = {};
    for (const rel of relationships) {
        if (!adjacency[rel.source_key]) adjacency[rel.source_key] = [];
        if (!adjacency[rel.target_key]) adjacency[rel.target_key] = [];
        adjacency[rel.source_key].push({ target: rel.target_key, type: rel.link_type, dir: "out" });
        adjacency[rel.target_key].push({ target: rel.source_key, type: rel.link_type, dir: "in" });
    }
    
    // BFS to find all connected nodes (with cycle detection)
    const visited = new Set();
    const queue = [focusKey];
    const relatedNodes = new Set();
    const relatedEdges = [];
    
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        relatedNodes.add(current);
        
        const neighbors = adjacency[current] || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor.target)) {
                queue.push(neighbor.target);
            }
            // Track edges
            relatedEdges.push({
                source: current,
                target: neighbor.target,
                type: neighbor.type,
                dir: neighbor.dir
            });
        }
    }
    
    // Hide all nodes except related ones
    const nodeUpdates = [];
    for (const iss of issues) {
        const isRelated = relatedNodes.has(iss.key);
        nodeUpdates.push({
            id: iss.key,
            hidden: !isRelated,
            style: isRelated && iss.key === focusKey ? {
                background: "#ffd700",
                border: "3px solid #ffd700",
                font: { size: 14, color: "#1e1e2e", bold: true }
            } : undefined
        });
    }
    
    // Build edge set for quick lookup
    const edgeSet = new Set();
    for (const edge of relatedEdges) {
        const key = `${edge.source}->${edge.target}->${edge.type.toLowerCase()}`;
        edgeSet.add(key);
    }
    
    // Hide edges not in related set
    const edgeUpdates = [];
    if (network.body.data.edges) {
        network.body.data.edges.forEach(edge => {
            const from = edge.from;
            const to = edge.to;
            // Try to find the relationship type
            let linkType = "";
            if (edge.label) {
                linkType = edge.label.replace(/\(.*\)/, "").trim().toLowerCase();
            }
            const key = `${from}->${to}->${linkType}`;
            const reverseKey = `${to}->${from}->${linkType}`;
            
            edgeUpdates.push({
                id: edge.id,
                hidden: !edgeSet.has(key) && !edgeSet.has(reverseKey)
            });
        });
    }
    
    // Apply updates
    if (nodeUpdates.length > 0) {
        network.body.data.nodes.update(nodeUpdates);
    }
    if (edgeUpdates.length > 0) {
        network.body.data.edges.update(edgeUpdates);
    }
    
    allRelatedActive = true;
    
    // Update status
    setStatus(`Showing ${relatedNodes.size} related nodes (transitive closure from ${focusKey})`, "info");
    appendToLogPanel(`INFO: Show all related - ${relatedNodes.size} nodes, ${relatedEdges.length} edges from ${focusKey}`);
}

function restoreFullGraph() {
    if (!network) return;
    
    // Reset flags
    allRelatedActive = false;
    directConnectionsActive = false;

    // Show all nodes and edges
    const nodeData = issues.map(iss => ({
        id: iss.key,
        hidden: false,
    }));
    network.body.data.nodes.update(nodeData);

    // Reset edge visibility
    const edgeData = relationships.map(rel => ({
        from: rel.source_key,
        to: rel.target_key,
        hidden: false,
    }));
    network.body.data.edges.update(edgeData);

    // Fit to all nodes with padding
    const allKeys = issues.map(iss => iss.key);
    if (allKeys.length > 0) {
        network.fit({
            nodes: allKeys,
            animation: true,
            scale: 0.8,
            margin: 60,
        });
    }

    // Hide restore button
    const restoreBtn = document.getElementById("btn-restore");
    if (restoreBtn) restoreBtn.style.display = "none";

    appendToLogPanel(`INFO: Restored full graph (${issues.length} nodes, ${relationships.length} edges)`);
}

function focusOnNode(nodeId) {
    if (network) {
        network.focus(nodeId, { scale: 1.5, animation: true });
    }
    appendToLogPanel(`INFO: Focused on ${nodeId}`);
}

// Toggle direct connections view (single-hop neighbors)
let directConnectionsActive = false;

function showDirectConnections() {
    // Toggle: if already active, restore full graph
    if (directConnectionsActive) {
        restoreFullGraph();
        directConnectionsActive = false;
        setStatus("Showing full graph", "info");
        return;
    }
    
    if (!connectionsPanelNode || !network) return;
    
    // Get relationships from the API for the current panel node
    fetch(`/api/relationships/${encodeURIComponent(connectionsPanelNode)}`)
        .then(resp => resp.json())
        .then(data => {
            directConnectionsActive = true;
            
            if (data.relationships && data.relationships.length > 0) {
                focusConnectedSubgraph(connectionsPanelNode, data.relationships);
                setStatus(`Showing direct connections for ${connectionsPanelNode} (${data.relationships.length} links)`, "info");
            } else {
                // No connections: just highlight the single node
                highlightSingleNode(connectionsPanelNode);
                setStatus(`Showing ${connectionsPanelNode} (no direct connections)`, "info");
            }
        })
        .catch(err => {
            console.error("Error fetching relationships:", err);
            setStatus(`Error fetching connections: ${err.message}`, "error");
            directConnectionsActive = false;
        });
}

function closeConnectionsPanel() {
    console.log("[Connections] Closing panel");
    const panel = document.getElementById("connections-panel");
    if (panel) {
        panel.style.display = "none";
    }
    connectionsPanelOpen = false;
    connectionsPanelNode = null;
    // Restore full graph when closing
    restoreFullGraph();
}

// ---------------------------------------------------------------------------
// Context menu (right-click on edges)
// ---------------------------------------------------------------------------
function initContextMenu() {
    if (!network) return;

    network.on("doubleClick", function (params) {
        // Ignore if it's a node double-click (handled above)
        if (params.nodes.length > 0) return;
        if (params.edges.length > 0) {
            selectedEdge = { from: params.edges[0].split("^?")[0], to: params.edges[0].split("^?")[1] };
            // Actually vis.js edge IDs are different — let's get fromEdges
            showContextMenu(params.event);
        }
    });

    // Hide context menu on click elsewhere
    document.addEventListener("click", function (e) {
        if (!e.target.closest(".context-menu")) {
            hideContextMenu();
        }
    });

    // Right-click on edge
    network.on("onContextMenu", function (params) {
        if (params.edges.length > 0) {
            params.event.preventDefault();
            selectedEdge = { edgeId: params.edges[0] };
            showContextMenu(params.event);
        }
    });
}

function showContextMenu(event) {
    const menu = document.getElementById("context-menu");
    contextMenuPos = { x: event.clientX, y: event.clientY };
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    menu.style.display = "block";
}

function hideContextMenu() {
    document.getElementById("context-menu").style.display = "none";
    selectedEdge = null;
}

async function deleteSelectedEdge() {
    hideContextMenu();
    if (!selectedEdge) return;

    // Find the edge in local relationships
    const edge = relationships.find(r =>
        r.source_key === selectedEdge.from && r.target_key === selectedEdge.to
    );
    if (!edge) {
        setStatus("Edge not found in local state", "warn");
        return;
    }

    try {
        const resp = await fetch("/api/relationships", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_key: edge.source_key,
                target_key: edge.target_key,
                link_type: edge.link_type,
            }),
        });

        const data = await resp.json();
        if (!resp.ok) {
            setStatus(`Error: ${data.error}`, "error");
            return;
        }

        // Remove from local state
        relationships = relationships.filter(r => !(r.source_key === edge.source_key && r.target_key === edge.target_key && r.link_type === edge.link_type));
        commitQueueCount = data.queue_count || 0;
        updateCommitQueueDisplay();

        setStatus(`Relationship deleted: ${edge.source_key} → ${edge.target_key} (${edge.link_type})`, "info");
        appendToLogPanel(`INFO: Relationship deleted: ${edge.source_key} → ${edge.target_key} (${edge.link_type})`);
        appendToLogPanel(`INFO: Queued for commit (delete): ${edge.source_key} → ${edge.target_key} (${edge.link_type})`);

        renderGraph();
    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
        console.error(err);
    }
}

async function editSelectedEdge() {
    hideContextMenu();
    if (!selectedEdge) return;

    // For now, just delete and let user create a new one
    await deleteSelectedEdge();
    setStatus("Deleted. Drag nodes to create a new relationship with the desired type.", "info");
}

async function swapEdgeDirection() {
    hideContextMenu();
    if (!selectedEdge || !selectedEdge.edgeId) {
        setStatus("No edge selected for swap.", "warn");
        return;
    }

    // Get edge data from vis.js network
    const edgeData = network.body.data.edges.get(selectedEdge.edgeId);
    if (!edgeData) {
        setStatus("Edge data not found.", "warn");
        return;
    }

    const { from, to } = edgeData;

    // Find the relationship in local state (try both directions)
    const edge = relationships.find(r =>
        (r.source_key === from && r.target_key === to) ||
        (r.source_key === to && r.target_key === from)
    );
    if (!edge) {
        setStatus("Relationship not found in local state — cannot swap.", "warn");
        return;
    }

    if (edge.link_type.toLowerCase() !== "blocks") {
        setStatus("Swap direction is only supported for 'blocks' relationships.", "warn");
        return;
    }

    const linkType = edge.link_type;
    const oldSource = edge.source_key;
    const oldTarget = edge.target_key;
    const newSource = oldTarget;
    const newTarget = oldSource;

    setStatus(`Swapping direction: ${oldSource} → ${oldTarget} → ${newSource} → ${newTarget}`, "info");

    try {
        // Delete old relationship
        const delResp = await fetch("/api/relationships", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_key: oldSource, target_key: oldTarget, link_type: linkType }),
        });
        const delData = await delResp.json();
        if (!delResp.ok) {
            setStatus(`Swap failed during delete: ${delData.error}`, "error");
            return;
        }

        // Remove from local state
        relationships = relationships.filter(r =>
            !(r.source_key === oldSource && r.target_key === oldTarget && r.link_type === linkType)
        );

        // Create new relationship (swapped)
        const creResp = await fetch("/api/relationships", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_key: newSource, target_key: newTarget, link_type: linkType }),
        });
        const creData = await creResp.json();
        if (!creResp.ok) {
            // Re-add the old one since the delete already went through
            relationships.push({ source_key: oldSource, target_key: oldTarget, link_type: linkType });
            setStatus(`Swap failed during create: ${creData.error} — original relationship restored.`, "error");
            renderGraph();
            return;
        }

        // Add new relationship to local state
        relationships.push({ source_key: newSource, target_key: newTarget, link_type: linkType });
        commitQueueCount = creData.queue_count || 0;
        updateCommitQueueDisplay();

        setStatus(`Swapped: ${oldSource} → ${oldTarget} → ${newSource} → ${newTarget} (${linkType})`, "info");
        appendToLogPanel(`INFO: Swapped direction: ${oldSource} → ${oldTarget} → ${newSource} → ${newTarget}`);
        renderGraph();

    } catch (err) {
        setStatus(`Swap failed: ${err.message}`, "error");
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Commit Workflow
// ---------------------------------------------------------------------------
let commitOps = [];       // Planned commit operations
let commitLiveLog = [];   // Live log entries to show in review

async function showCommitDialog() {
    if (commitQueueCount === 0) {
        setStatus("Nothing to commit.", "warn");
        return;
    }

    // Fetch the commit plan
    try {
        const resp = await apiGet("/api/commit-plan");
        commitOps = resp.ops || [];
        commitLiveLog = [];  // Will be fetched separately

        // Fetch live log
        const logResp = await apiGet("/log?lines=100");
        commitLiveLog = logResp.entries || [];

        // Show dialog
        const dialog = document.getElementById("commit-dialog");
        const opsList = document.getElementById("commit-ops-list");
        const liveLogDiv = document.getElementById("commit-live-log");

        opsList.innerHTML = "";
        for (const op of commitOps) {
            const div = document.createElement("div");
            div.className = `commit-op ${op.action}`;
            const icon = op.action === "create" ? "+" : "-";
            const statusIcon = op.validation_status === "error" ? "⚠️" : (op.validation_status === "warning" ? "⚡" : "✓");
            div.innerHTML = `
                <span class="op-type">${icon} ${op.action.toUpperCase()}</span>
                <span class="op-keys">${op.source_key} → ${op.target_key} (${op.link_type})</span>
                <span class="op-status">${statusIcon} ${op.validation_status || "ok"}</span>
            `;
            if (op.validation_status === "error") {
                div.style.borderLeftColor = "#f38ba8";
            } else if (op.validation_status === "warning") {
                div.style.borderLeftColor = "#f9e2af";
            }
            opsList.appendChild(div);
        }

        liveLogDiv.innerHTML = "";
        const recentLogs = commitLiveLog.slice(-20);  // Last 20 entries
        for (const line of recentLogs) {
            const div = document.createElement("div");
            div.className = "log-line";
            div.textContent = line;
            liveLogDiv.appendChild(div);
        }

        dialog.style.display = "flex";
    } catch (err) {
        setStatus(`Error fetching commit plan: ${err.message}`, "error");
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Dry run commit
// ---------------------------------------------------------------------------
async function dryRunCommit() {
    try {
        const resp = await apiGet("/api/commit?dry_run=true");
        const data = resp;

        // Show results in the commit dialog
        const opsList = document.getElementById("commit-ops-list");
        opsList.innerHTML = "";
        for (const op of data.ops || []) {
            const div = document.createElement("div");
            div.className = `commit-op ${op.action}`;
            const icon = op.action === "create" ? "+" : "-";
            const status = op.success ? "✓ Would succeed" : "✗ Would fail";
            const statusClass = op.success ? "success" : "error";
            div.innerHTML = `
                <span class="op-type">${icon} ${op.action.toUpperCase()}</span>
                <span class="op-keys">${op.source_key} → ${op.target_key} (${op.link_type})</span>
                <span class="op-status ${statusClass}">${status}</span>
            `;
            if (!op.success && op.error_message) {
                div.innerHTML += `<div class="op-error">${op.error_message}</div>`;
            }
            opsList.appendChild(div);
        }

        setStatus(`Dry run: ${data.success_count} would succeed, ${data.failure_count} would fail`, data.success_count === data.ops.length ? "info" : "warn");
    } catch (err) {
        setStatus(`Dry run failed: ${err.message}`, "error");
        console.error(err);
    }
}

function cancelCommit() {
    document.getElementById("commit-dialog").style.display = "none";
    commitOps = [];
    commitLiveLog = [];
}

async function clearCommitQueue() {
    if (!confirm("Clear all pending changes from the commit queue?")) {
        return;
    }
    
    try {
        const resp = await fetch("/api/commit-queue", { method: "DELETE" });
        const data = await resp.json();
        
        commitOps = [];
        commitLiveLog = [];
        commitQueueCount = 0;
        updateCommitQueueDisplay();
        
        setStatus("Commit queue cleared.", "info");
        appendToLogPanel("INFO: Commit queue cleared by user");
        
        cancelCommit();
    } catch (err) {
        setStatus(`Error clearing queue: ${err.message}`, "error");
    }
}

async function executeCommit() {
    document.getElementById("commit-dialog").style.display = "none";

    setStatus("Committing to JIRA...", "info");
    document.getElementById("btn-commit").disabled = true;

    try {
        // First, do a dry run to show results
        const dryResp = await apiGet("/api/commit?dry_run=true");
        const dryOps = dryResp.ops || [];

        // Show results
        showCommitResult(dryOps, dryResp.success_count, dryResp.failure_count);

        // If dry run shows failures, ask user to confirm
        if (dryResp.failure_count > 0) {
            const confirm = window.confirm(
                `${dryResp.failure_count} operation(s) would fail. Proceed anyway?`
            );
            if (!confirm) {
                setStatus("Commit cancelled.", "warn");
                document.getElementById("btn-commit").disabled = false;
                return;
            }
        }

        // Execute the actual commit
        const commitResp = await apiPost("/api/commit", {});
        const resultOps = commitResp.ops || [];

        showCommitResult(resultOps, commitResp.success_count, commitResp.failure_count, commitResp.remaining_queue);

        // Update local state for successful commits
        if (commitResp.success_count > 0) {
            // Reload to merge remote state
            await fetchIssues();
        }

    } catch (err) {
        setStatus(`Commit failed: ${err.message}`, "error");
        console.error(err);
    } finally {
        document.getElementById("btn-commit").disabled = false;
    }
}

function showCommitResult(ops, successCount, failureCount, remainingQueue) {
    const dialog = document.getElementById("commit-result-dialog");
    const content = document.getElementById("commit-result-content");

    content.innerHTML = "";

    // Summary
    const summary = document.createElement("div");
    summary.style.marginBottom = "12px";
    summary.innerHTML = `
        <strong>Success:</strong> ${successCount} &nbsp;
        <strong>Failed:</strong> ${failureCount} &nbsp;
        ${remainingQueue !== undefined ? `<strong>Remaining in queue:</strong> ${remainingQueue}` : ""}
    `;
    content.appendChild(summary);

    // Op details
    for (const op of ops) {
        const div = document.createElement("div");
        div.className = `commit-op ${op.action} ${op.success ? "success" : "failure"}`;
        const icon = op.success ? "✓" : "✗";
        div.innerHTML = `
            <span class="op-type">${icon} ${op.action.toUpperCase()}</span>
            <span class="op-keys">${op.source_key} → ${op.target_key} (${op.link_type})</span>
        `;
        if (op.error_message) {
            div.innerHTML += `<div class="op-error">${op.error_message}</div>`;
        }
        content.appendChild(div);
    }

    dialog.style.display = "flex";
    appendToLogPanel(`INFO: Commit completed — ${successCount} success, ${failureCount} failed`);
}

function closeCommitResult() {
    document.getElementById("commit-result-dialog").style.display = "none";
    commitOps = [];
}

// ---------------------------------------------------------------------------
// Delete connection from connections panel
// ---------------------------------------------------------------------------
async function deleteConnection(sourceKey, targetKey, linkType) {
    if (!confirm(`Delete relationship: ${sourceKey} → ${targetKey} (${linkType})?`)) {
        return;
    }

    try {
        const deleteResp = await fetch("/api/relationships", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_key: sourceKey,
                target_key: targetKey,
                link_type: linkType,
            }),
        });

        const data = await deleteResp.json();

        if (!deleteResp.ok) {
            setStatus(`Error deleting: ${data.error}`, "error");
            return;
        }

        // Remove from local state
        relationships = relationships.filter(r => !(r.source_key === sourceKey && r.target_key === targetKey && r.link_type === linkType));
        commitQueueCount = data.queue_count || 0;
        updateCommitQueueDisplay();

        setStatus(`Relationship deleted from canvas. Queued for commit to JIRA.`, "info");
        appendToLogPanel(`INFO: Relationship deleted from canvas: ${sourceKey} → ${targetKey} (${linkType})`);
        appendToLogPanel(`INFO: Queued for commit to JIRA (delete): ${sourceKey} → ${targetKey} (${linkType})`);

        // Refresh the connections panel
        if (connectionsPanelOpen && connectionsPanelNode) {
            await showConnectionsPanel(connectionsPanelNode);
        }

        // Re-render graph
        renderGraph();

    } catch (err) {
        setStatus(`Error deleting: ${err.message}`, "error");
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Add connection dialog
// ---------------------------------------------------------------------------
function showAddConnectionDialog(centerKey) {
    const dialog = document.getElementById("rel-dialog");
    document.getElementById("rel-dialog-source").textContent = centerKey;
    document.getElementById("rel-dialog-target").textContent = "(enter target key)";

    const typesContainer = document.getElementById("rel-dialog-types");
    typesContainer.innerHTML = "";

    // Show discovered link types as dropdown
    const typeSelect = document.createElement("select");
    typeSelect.id = "add-conn-type-select";
    typeSelect.style.cssText = "width: 100%; padding: 6px; margin-bottom: 8px; background: #1e1e2e; border: 1px solid #45475a; color: #cdd6f4; border-radius: 3px;";
    
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "-- Select Link Type --";
    typeSelect.appendChild(defaultOption);
    
    for (const lt of linkTypes) {
        const option = document.createElement("option");
        option.value = lt.name;
        option.textContent = `${lt.name} (outward: ${lt.outward})`;
        typeSelect.appendChild(option);
    }
    
    typeSelect.onchange = () => {
        selectedLinkType = typeSelect.value;
    };
    typesContainer.appendChild(typeSelect);

    // Add input for target key with search
    const targetInput = document.createElement("div");
    targetInput.style.marginTop = "12px";
    targetInput.innerHTML = `
        <label style="font-size: 12px; color: #cdd6f4;">Target issue key or summary:</label>
        <input type="text" id="add-conn-target" placeholder="e.g. OKR-17 or type part of summary" style="width: 100%; padding: 6px; margin-top: 4px; background: #1e1e2e; border: 1px solid #45475a; color: #cdd6f4; border-radius: 3px;" />
        <div id="add-conn-search-results" style="max-height: 150px; overflow-y: auto; margin-top: 6px;"></div>
    `;
    typesContainer.appendChild(targetInput);

    // Add search on input
    const targetField = document.getElementById("add-conn-target");
    targetField.addEventListener("input", async () => {
        const query = targetField.value.trim();
        const resultsDiv = document.getElementById("add-conn-search-results");
        resultsDiv.innerHTML = "";
        if (!query) return;

        try {
            const resp = await apiGet(`/api/search?q=${encodeURIComponent(query)}`);
            const matches = resp.matches || [];
            for (const match of matches) {
                const div = document.createElement("div");
                div.style.padding = "4px 8px";
                div.style.cursor = "pointer";
                div.style.fontSize = "12px";
                div.style.color = "#cdd6f4";
                div.innerHTML = `<strong>${match.key}</strong> — ${match.summary ? match.summary.substring(0, 50) : ""}`;
                div.onclick = () => {
                    targetField.value = match.key;
                    resultsDiv.innerHTML = "";
                };
                resultsDiv.appendChild(div);
            }
        } catch (err) {
            console.error("Search failed:", err);
        }
    });

    // Add confirm button
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "✓ Confirm Connection";
    confirmBtn.style.marginTop = "12px";
    confirmBtn.style.padding = "10px 16px";
    confirmBtn.style.background = "#89b4fa";
    confirmBtn.style.color = "#1e1e2e";
    confirmBtn.style.border = "2px solid #74c7ec";
    confirmBtn.style.borderRadius = "4px";
    confirmBtn.style.fontSize = "14px";
    confirmBtn.style.fontWeight = "700";
    confirmBtn.style.cursor = "pointer";
    confirmBtn.onmouseover = () => {
        confirmBtn.style.background = "#74c7ec";
    };
    confirmBtn.onmouseout = () => {
        confirmBtn.style.background = "#89b4fa";
    };
    confirmBtn.onclick = () => {
        const targetKey = document.getElementById("add-conn-target").value.trim();
        if (!targetKey) {
            alert("Please enter a target issue key.");
            return;
        }
        if (!selectedLinkType) {
            alert("Please select a link type.");
            return;
        }
        confirmAddConnection(centerKey, selectedLinkType, targetKey);
    };
    typesContainer.appendChild(confirmBtn);

    dialog.style.display = "flex";
}

let selectedLinkType = null;

// Override the link type button click to track selection
function confirmAddConnection(centerKey, linkType, targetKey) {
    document.getElementById("rel-dialog").style.display = "none";

    if (!targetKey) {
        targetKey = prompt(`Enter the target issue key for ${centerKey} (${linkType}):`);
        if (!targetKey) return;
    }

    createRelationship(centerKey, targetKey, linkType);
}

// ---------------------------------------------------------------------------
// Find / Search
// ---------------------------------------------------------------------------
let findMatches = [];       // Array of matching node IDs
let findCurrentIndex = -1;  // Current highlighted match index
let findQuery = "";         // Current search query

// ---------------------------------------------------------------------------
// Manual find — triggered by Apply button or Enter key
// ---------------------------------------------------------------------------
function manualFind() {
    const query = document.getElementById("find-input").value.trim();
    if (!query) {
        clearFind();
        return;
    }
    if (issues.length === 0) {
        setStatus("⚠️ Load issues first (click Fetch) before searching.", "warn");
        return;
    }
    if (query === findQuery && !document.getElementById("find-strict").checked) {
        // Same query and strict unchanged — skip
        return;
    }
    findQuery = query;
    performFind(query);
}

function onFindKeydown(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        manualFind();
    }
}

// ---------------------------------------------------------------------------
// Old onFindInput kept for backward compat but no longer wired
// ---------------------------------------------------------------------------
function onFindInput() {
    // No-op — search now requires Apply button or Enter
}

async function performFind(query) {
    try {
        console.log("[Find] Searching for:", query);
        const resp = await apiGet(`/api/search?q=${encodeURIComponent(query)}`);
        console.log("[Find] Response:", resp);
        const data = resp;
        findMatches = data.matches.map(m => m.key);
        findCurrentIndex = -1;
        console.log("[Find] Matches:", findMatches);
        updateFindCounter();

        // Highlight all matches (white border for visibility)
        if (!network) {
            console.log("[Find] Network not available, cannot highlight");
            setStatus("Issues loaded but graph not rendered yet.", "warn");
            return;
        }

        const strictEl = document.getElementById("find-strict");
        const strict = strictEl ? strictEl.checked : false;
        const ids = findMatches;

        console.log("[Find] Strict checkbox found:", !!strictEl);
        console.log("[Find] Strict mode:", strict);
        console.log("[Find] Find matches:", findMatches);
        console.log("[Find] Issues count:", issues.length);

        if (ids.length > 0) {
            console.log("[Find] Highlighting", ids.length, "nodes");
            const style = {
                borderColor: "#ff0000",
                borderWidth: 6,
                color: { background: "#ff6b6b", border: "#ff0000" },
                font: { color: "#ffffff", bold: true, size: 14 },
            };

            // If strict, hide all non-matching nodes and update all nodes at once
            if (strict) {
                console.log("[Find] Strict mode enabled");
                const allNodeIds = issues.map(iss => iss.key);
                const updateItems = allNodeIds.map(key => {
                    const isMatch = findMatches.includes(key);
                    return {
                        id: key,
                        hidden: !isMatch,
                        style: isMatch ? style : undefined
                    };
                });
                console.log("[Find] Updating", updateItems.length, "nodes all at once");
                console.log("[Find] Match count:", updateItems.filter(i => !i.hidden).length);
                console.log("[Find] Hidden count:", updateItems.filter(i => i.hidden).length);
                network.body.data.nodes.update(updateItems);

                // Also hide edges connected to hidden nodes
                const visibleEdges = relationships.filter(rel =>
                    findMatches.includes(rel.source_key) && findMatches.includes(rel.target_key)
                );
                console.log("[Find] Visible edges:", visibleEdges.length);
                const edgeData = [];
                for (const rel of relationships) {
                    if (visibleEdges.some(v => v.source_key === rel.source_key && v.target_key === rel.target_key)) {
                        edgeData.push({ from: rel.source_key, to: rel.target_key, hidden: false });
                    } else {
                        edgeData.push({ from: rel.source_key, to: rel.target_key, hidden: true });
                    }
                }
                if (edgeData.length > 0) {
                    network.body.data.edges.update(edgeData);
                    console.log("[Find] Updated", edgeData.length, "edges");
                }
            } else {
                // Non-strict: only highlight matches
                const items = ids.map(key => ({ id: key, style: style }));
                network.body.data.nodes.update(items);
            }

            const mode = strict ? " (strict: matches only)" : " (with connections)";
            setStatus(`Found ${ids.length} match${ids.length > 1 ? "es" : ""}${mode}. Use ◀/▶ to navigate.`, "info");
        } else {
            console.log("[Find] No matches to highlight");
            setStatus("No matches found.", "info");
        }
    } catch (err) {
        console.error("[Find] Search failed:", err);
        findMatches = [];
        updateFindCounter();
        setStatus(`Search failed: ${err.message}`, "error");
    }
}

function findNext() {
    if (findMatches.length === 0) return;
    findCurrentIndex = (findCurrentIndex + 1) % findMatches.length;
    highlightCurrentMatch();
    updateFindCounter();
}

function findPrev() {
    if (findMatches.length === 0) return;
    findCurrentIndex = (findCurrentIndex - 1 + findMatches.length) % findMatches.length;
    highlightCurrentMatch();
    updateFindCounter();
}

function highlightCurrentMatch() {
    if (!network || findCurrentIndex < 0 || findCurrentIndex >= findMatches.length) return;

    const currentKey = findMatches[findCurrentIndex];

    // Reset all matches to red border
    const redStyle = {
        borderColor: "#ff0000",
        borderWidth: 6,
        color: { background: "#ff6b6b", border: "#ff0000" },
        font: { color: "#ffffff", bold: true, size: 14 },
    };
    const redItems = findMatches.map(key => ({ id: key, style: redStyle }));
    network.body.data.nodes.update(redItems);

    // Highlight current in bright yellow/gold
    const currentStyle = {
        borderColor: "#ffd700",
        borderWidth: 8,
        color: { background: "#ffd700", border: "#ff8c00" },
        font: { color: "#000000", bold: true, size: 16 },
    };
    network.body.data.nodes.update({ id: currentKey, style: currentStyle });

    // Zoom to current node
    const pos = network.body.data.nodes.get(currentKey);
    if (pos) {
        network.focus(currentKey, { scale: 1.5, animation: true });
    }
}

function clearFind() {
    findQuery = "";
    findMatches = [];
    findCurrentIndex = -1;
    document.getElementById("find-input").value = "";
    updateFindCounter();

    // Reset all node styles and visibility
    if (network) {
        network.body.data.nodes.update({}, { style: true });
        // Restore all nodes if they were hidden in strict mode
        const allNodeIds = issues.map(iss => iss.key);
        if (allNodeIds.length > 0) {
            const restoreItems = allNodeIds.map(key => ({ id: key, hidden: false }));
            network.body.data.nodes.update(restoreItems);
        }
        // Restore all edges
        if (relationships.length > 0) {
            const edgeData = relationships.map(rel => ({
                from: rel.source_key,
                to: rel.target_key,
                hidden: false
            }));
            network.body.data.edges.update(edgeData);
        }
    }
}

// ---------------------------------------------------------------------------
// Focus found node - open connections panel for current match
// ---------------------------------------------------------------------------
function focusFoundNode() {
    if (findMatches.length === 0) {
        setStatus("No matches found.", "warn");
        return;
    }

    // Use current index, or first match if no index selected
    const idx = findCurrentIndex >= 0 ? findCurrentIndex : 0;
    const key = findMatches[idx];

    // Focus on the node in the graph
    if (network) {
        network.focus(key, { scale: 1.8, animation: true });
    }

    // Open connections panel for quick editing
    showConnectionsPanel(key);
    setStatus(`Focused on ${key} (${idx + 1}/${findMatches.length})`, "info");
}

function updateFindCounter() {
    const counter = document.getElementById("find-counter");
    const focusBtn = document.getElementById("btn-find-focus");

    if (findMatches.length === 0) {
        if (counter) counter.textContent = "No matches";
        if (focusBtn) focusBtn.style.display = "none";
    } else if (findCurrentIndex < 0) {
        if (counter) counter.textContent = `${findMatches.length} found`;
        if (focusBtn) {
            focusBtn.style.display = "";
            focusBtn.textContent = `Focus (1/${findMatches.length})`;
        }
    } else {
        if (counter) counter.textContent = `${findCurrentIndex + 1}/${findMatches.length}`;
        if (focusBtn) {
            focusBtn.style.display = "";
            focusBtn.textContent = `Focus (${findCurrentIndex + 1}/${findMatches.length})`;
        }
    }
}

// ---------------------------------------------------------------------------
// Commit queue display
// ---------------------------------------------------------------------------
function updateCommitQueueDisplay() {
    const badge = document.getElementById("commit-queue-badge");
    if (badge) {
        badge.textContent = `Commit queue: ${commitQueueCount}`;
        badge.style.display = commitQueueCount > 0 ? "inline" : "none";
    }
}

async function fetchCommitQueue() {
    try {
        const resp = await fetch("/api/commit-queue");
        const data = await resp.json();
        commitQueueCount = data.count || 0;
        updateCommitQueueDisplay();
    } catch (err) {
        console.error("Failed to fetch commit queue:", err);
    }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
    // Ctrl+F or Cmd+F for find
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        const findInput = document.getElementById("find-input");
        if (findInput) {
            findInput.focus();
            findInput.select();
        }
    }

    // Delete key to delete selected edge
    if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdge && !e.target.closest("input")) {
            e.preventDefault();
            deleteSelectedEdge();
        }
    }

    // Escape to close dialogs
    if (e.key === "Escape") {
        hideContextMenu();
        const relDialog = document.getElementById("rel-dialog");
        if (relDialog && relDialog.style.display !== "none") {
            cancelRelationship();
        }
        const commitDialog = document.getElementById("commit-dialog");
        if (commitDialog && commitDialog.style.display !== "none") {
            cancelCommit();
        }
        const commitResultDialog = document.getElementById("commit-result-dialog");
        if (commitResultDialog && commitResultDialog.style.display !== "none") {
            closeCommitResult();
        }
        if (connectionsPanelOpen) {
            closeConnectionsPanel();
        }
    }

    // Ctrl+L to toggle log panel
    if ((e.ctrlKey || e.metaKey) && e.key === "l") {
        e.preventDefault();
        toggleLogPanel();
    }

    // Ctrl+Shift+F to toggle filter section
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "f") {
        e.preventDefault();
        toggleFilterSection();
    }
});

// ---------------------------------------------------------------------------
// Log panel toggle
// ---------------------------------------------------------------------------
let logPanelVisible = true;

function toggleLogPanel() {
    const logPanel = document.getElementById("log-panel");
    const btn = document.getElementById("btn-toggle-log");
    if (!logPanel || !btn) return;

    logPanelVisible = !logPanelVisible;
    if (logPanelVisible) {
        logPanel.style.display = "flex";
        btn.textContent = "📋 Log";
        btn.title = "Hide log panel";
    } else {
        logPanel.style.display = "none";
        btn.textContent = "📋 Show Log";
        btn.title = "Show log panel";
    }
    appendToLogPanel(`INFO: Log panel ${logPanelVisible ? "shown" : "hidden"}`);
}

// ---------------------------------------------------------------------------
// Filter section toggle
// ---------------------------------------------------------------------------
let filterSectionVisible = true;

// Update value dropdown when field changes
// Load default JQL query from server on startup
async function loadDefaultJql() {
    try {
        const response = await fetch("/api/default-jql");
        const data = await response.json();
        if (data.default_jql) {
            const jqlInput = document.getElementById("jql-input");
            if (jqlInput) {
                jqlInput.value = data.default_jql;
            }
        }
    } catch (err) {
        console.warn("Failed to load default JQL:", err);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const fieldSelect = document.getElementById("filter-field");
    if (fieldSelect) {
        fieldSelect.addEventListener("change", () => {
            updateFilterOptions();
        });
    }
    
    // Load default JQL query
    loadDefaultJql();
});

function toggleFilterSection() {
    const filterSection = document.getElementById("filter-section");
    const btn = document.getElementById("btn-toggle-filter");
    if (!filterSection || !btn) return;

    filterSectionVisible = !filterSectionVisible;
    if (filterSectionVisible) {
        filterSection.style.display = "flex";
        btn.textContent = "🔍 Hide Filter";
        btn.title = "Hide filter panel";
    } else {
        filterSection.style.display = "none";
        btn.textContent = "🔍 Filter";
        btn.title = "Show filter panel";
    }
}

// ---------------------------------------------------------------------------
// Display filter logic
// ---------------------------------------------------------------------------
let activeFilter = null; // {field, value}

function applyDisplayFilter() {
    const field = document.getElementById("filter-field").value;
    const valueSelect = document.getElementById("filter-value");
    const value = valueSelect.value.trim();
    const strict = document.getElementById("filter-strict").checked;

    if (!field || !value || value === "") {
        setStatus("Please select a field and a value.", "warn");
        return;
    }

    // Filter nodes by the selected field and value
    const matchingKeys = new Set();

    if (field === "link_type") {
        // Find nodes that participate in any relationship of the selected type
        for (const rel of relationships) {
            if ((rel.link_type || "").toLowerCase() === value.toLowerCase()) {
                matchingKeys.add(rel.source_key);
                matchingKeys.add(rel.target_key);
            }
        }
    } else {
        for (const iss of issues) {
            const fieldValue = (iss[field] || "").toString().toLowerCase();
            if (fieldValue.includes(value.toLowerCase())) {
                matchingKeys.add(iss.key);
            }
        }
    }

    if (matchingKeys.size === 0) {
        setStatus(`No nodes match ${field}="${value}"`, "warn");
        return;
    }

    // Determine visible keys
    let visibleKeys;
    if (strict) {
        // Strict mode: only matching nodes, no connections
        visibleKeys = new Set(matchingKeys);
    } else {
        // Normal mode: matching nodes + all their connections (transitive closure)
        visibleKeys = new Set(matchingKeys);
        const queue = [...matchingKeys];
        while (queue.length > 0) {
            const key = queue.pop();
            // Find all edges connected to this node
            for (const rel of relationships) {
                if (rel.source_key === key && !visibleKeys.has(rel.target_key)) {
                    visibleKeys.add(rel.target_key);
                    queue.push(rel.target_key);
                }
                if (rel.target_key === key && !visibleKeys.has(rel.source_key)) {
                    visibleKeys.add(rel.source_key);
                    queue.push(rel.source_key);
                }
            }
        }
    }

    // Apply visibility
    if (network) {
        const nodeData = issues.map(iss => ({
            id: iss.key,
            hidden: !visibleKeys.has(iss.key),
        }));
        network.body.data.nodes.update(nodeData);

        const edgeData = [];
        for (const rel of relationships) {
            if (visibleKeys.has(rel.source_key) && visibleKeys.has(rel.target_key)) {
                edgeData.push({
                    from: rel.source_key,
                    to: rel.target_key,
                    hidden: false,
                });
            } else {
                edgeData.push({
                    from: rel.source_key,
                    to: rel.target_key,
                    hidden: true,
                });
            }
        }
        network.body.data.edges.update(edgeData);

        // Fit to visible nodes
        const visibleArr = [...visibleKeys];
        network.fit({
            nodes: visibleArr,
            animation: true,
            scale: 0.7,
            margin: 80,
        });
    }

    activeFilter = { field, value };
    const mode = strict ? " (strict: matching nodes only)" : " (with connections)";
    setStatus(`Filtered: ${visibleKeys.size} nodes visible (matched: ${matchingKeys.size})${mode}`, "info");
    appendToLogPanel(`INFO: Display filter applied: ${field}="${value}"${strict ? " [strict]" : ""} → ${visibleKeys.size} nodes visible`);
}

function clearDisplayFilter() {
    activeFilter = null;
    const fieldSelect = document.getElementById("filter-field");
    const valueSelect = document.getElementById("filter-value");
    if (fieldSelect) fieldSelect.value = "";
    if (valueSelect) {
        valueSelect.innerHTML = '<option value="">-- Select Value --</option>';
        valueSelect.disabled = true;
    }

    // Show all nodes and edges
    if (network) {
        const nodeData = issues.map(iss => ({
            id: iss.key,
            hidden: false,
        }));
        network.body.data.nodes.update(nodeData);

        const edgeData = relationships.map(rel => ({
            from: rel.source_key,
            to: rel.target_key,
            hidden: false,
        }));
        network.body.data.edges.update(edgeData);

        const allKeys = issues.map(iss => iss.key);
        network.fit({
            nodes: allKeys,
            animation: true,
            scale: 0.8,
            margin: 60,
        });
    }

    setStatus("Filter cleared. Showing all nodes.", "info");
    appendToLogPanel("INFO: Display filter cleared");
}

// ---------------------------------------------------------------------------
// Get JIRA web URL for an issue key
// ---------------------------------------------------------------------------
function getJiraWebUrl(issueKey) {
    // Find the issue in the issues array
    const issue = issues.find(iss => iss.key === issueKey);
    if (issue && issue.jira_web_url) {
        return issue.jira_web_url;
    }
    // Fallback: construct URL from injected config
    const baseUrl = window.__JIRA_BASE_URL__ || "https://your-instance.atlassian.net";
    return baseUrl + "/browse/" + issueKey;
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
let isDarkTheme = true;

// ---------------------------------------------------------------------------
// Multi-Link Feature
// ---------------------------------------------------------------------------
let multilinkParentKey = null;
let multilinkRows = [];  // Array of {childKey, linkType, validationStatus, validationMessage}

function openMultiLinkDialog() {
    multilinkParentKey = document.getElementById("connections-node-key").textContent.trim();
    multilinkRows = [];
    
    document.getElementById("multilink-parent-key").textContent = multilinkParentKey;
    document.getElementById("multilink-list").innerHTML = "";
    document.getElementById("multilink-validation").style.display = "none";
    
    // Add first row
    addMultilinkRow();
    
    document.getElementById("multilink-dialog").style.display = "flex";
}

function addMultilinkRow() {
    const list = document.getElementById("multilink-list");
    const rowId = multilinkRows.length;
    
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px;margin-bottom:4px;background:#1e1e2e;border-radius:4px;";
    row.innerHTML = `
        <select class="multilink-child-select" style="flex:1;padding:4px 8px;font-size:12px;background:#181825;border:1px solid #45475a;color:#cdd6f4;border-radius:3px;">
            <option value="">-- Select Child --</option>
        </select>
        <select class="multilink-type-select" style="width:150px;padding:4px 8px;font-size:12px;background:#181825;border:1px solid #45475a;color:#cdd6f4;border-radius:3px;">
            <option value="">-- Type --</option>
        </select>
        <button onclick="removeMultilinkRow(${rowId})" style="padding:4px 8px;font-size:11px;background:#f38ba8;color:#1e1e2e;border:none;border-radius:3px;cursor:pointer;">×</button>
    `;
    
    list.appendChild(row);
    
    // Populate child dropdown
    const childSelect = row.querySelector(".multilink-child-select");
    for (const iss of issues) {
        if (iss.key !== multilinkParentKey) {
            const option = document.createElement("option");
            option.value = iss.key;
            option.textContent = `${iss.key} — ${iss.summary.substring(0, 40)}${iss.summary.length > 40 ? "..." : ""}`;
            childSelect.appendChild(option);
        }
    }
    
    // Populate type dropdown
    const typeSelect = row.querySelector(".multilink-type-select");
    for (const lt of linkTypes) {
        const typeName = lt.name || lt;
        const option = document.createElement("option");
        option.value = typeName;
        option.textContent = typeName;
        typeSelect.appendChild(option);
    }
    
    // Add change listeners
    childSelect.addEventListener("change", () => validateMultilinkRow(rowId));
    typeSelect.addEventListener("change", () => validateMultilinkRow(rowId));
    
    multilinkRows.push({childKey: "", linkType: "", validationStatus: "", validationMessage: ""});
}

function removeMultilinkRow(rowId) {
    const list = document.getElementById("multilink-list");
    const rows = list.querySelectorAll("div");
    if (rows[rowId]) {
        rows[rowId].remove();
    }
    multilinkRows.splice(rowId, 1);
    validateMultilinkAll();
}

function validateMultilinkRow(rowId) {
    const list = document.getElementById("multilink-list");
    const rows = list.querySelectorAll("div");
    if (!rows[rowId]) return;
    
    const row = rows[rowId];
    const childKey = row.querySelector(".multilink-child-select").value;
    const linkType = row.querySelector(".multilink-type-select").value;
    
    const entry = multilinkRows[rowId] || {childKey: "", linkType: "", validationStatus: "", validationMessage: ""};
    entry.childKey = childKey;
    entry.linkType = linkType;
    
    // Validate
    if (!childKey || !linkType) {
        entry.validationStatus = "";
        entry.validationMessage = "";
    } else if (childKey === multilinkParentKey) {
        entry.validationStatus = "error";
        entry.validationMessage = "Cannot link to self";
    } else {
        const validType = linkTypes.some(lt => 
            (lt.name || lt).toLowerCase() === linkType.toLowerCase()
        );
        if (!validType) {
            entry.validationStatus = "error";
            entry.validationMessage = `Unknown link type: ${linkType}`;
        } else {
        // Check if relationship already exists
        const exists = relationships.some(r =>
            ((r.source_key === multilinkParentKey && r.target_key === childKey) ||
             (r.source_key === childKey && r.target_key === multilinkParentKey)) &&
            r.link_type.toLowerCase() === linkType.toLowerCase()
        );
        if (exists) {
            entry.validationStatus = "warning";
            entry.validationMessage = "Relationship already exists";
        } else {
            entry.validationStatus = "ok";
            entry.validationMessage = "";
        }
        }
    }
    
    validateMultilinkAll();
}

function validateMultilinkAll() {
    const validationDiv = document.getElementById("multilink-validation");
    const warningsDiv = document.getElementById("multilink-warnings");
    warningsDiv.innerHTML = "";
    
    let hasWarnings = false;
    for (const entry of multilinkRows) {
        if (entry.validationStatus === "warning" || entry.validationStatus === "error") {
            hasWarnings = true;
            const p = document.createElement("p");
            p.style.color = entry.validationStatus === "error" ? "#f38ba8" : "#f9e2af";
            p.textContent = `• ${entry.childKey} → ${entry.linkType}: ${entry.validationMessage}`;
            warningsDiv.appendChild(p);
        }
    }
    
    validationDiv.style.display = hasWarnings ? "block" : "none";
}

function cancelMultilink() {
    document.getElementById("multilink-dialog").style.display = "none";
    multilinkParentKey = null;
    multilinkRows = [];
}

async function executeMultilink() {
    if (!multilinkParentKey) return;
    
    // Collect all rows
    const list = document.getElementById("multilink-list");
    const rows = list.querySelectorAll("div");
    const ops = [];
    
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const childKey = row.querySelector(".multilink-child-select").value;
        const linkType = row.querySelector(".multilink-type-select").value;
        
        if (childKey && linkType) {
            ops.push({
                source_key: multilinkParentKey,
                target_key: childKey,
                link_type: linkType,
                action: "add"
            });
        }
    }
    
    if (ops.length === 0) {
        setStatus("No relationships to commit.", "warn");
        return;
    }
    
    // Add to commit queue
    for (const op of ops) {
        await apiPost("/api/relationships", op);
    }
    
    // Close dialog and show commit
    cancelMultilink();
    updateCommitQueueBadge();
    showCommitDialog();
}

function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    const btn = document.getElementById("btn-theme");
    if (isDarkTheme) {
        document.body.classList.remove("light-theme");
        btn.textContent = "🌙";
        btn.title = "Switch to light mode";
    } else {
        document.body.classList.add("light-theme");
        btn.textContent = "☀️";
        btn.title = "Switch to dark mode";
    }
    appendToLogPanel(`INFO: Theme changed to ${isDarkTheme ? "dark" : "light"} mode`);

    // Update network colors to match new theme
    if (network && issues.length > 0) {
        updateNetworkColors();
    }
}

// ---------------------------------------------------------------------------
// Update network edge and node colors to match current theme
// ---------------------------------------------------------------------------
function updateNetworkColors() {
    if (!network || !issues.length) return;

    const isLight = !isDarkTheme;

    // Update edge colors
    const edgeUpdates = relationships.map(rel => {
        const color = isLight ? getLinkTypeColorLight(rel.link_type) : getLinkTypeColor(rel.link_type);
        const strokeColor = isLight ? "#d5d8dc" : "#ffffff";
        return {
            from: rel.source_key,
            to: rel.target_key,
            color: { color: color, highlight: lightenColor(color, 20), hover: lightenColor(color, 10) },
            font: {
                color: color,
                strokeWidth: 0,
                strokeColor: strokeColor,
            },
        };
    });

    if (edgeUpdates.length > 0) {
        network.body.data.edges.update(edgeUpdates);
    }

    // Update node colors for search matches
    if (findMatches.length > 0) {
        const matchStyle = {
            borderColor: "#ff0000",
            borderWidth: 6,
            color: { background: "#ff6b6b", border: "#ff0000" },
            font: { color: "#ffffff", bold: true, size: 14 },
        };
        const matchUpdates = findMatches.map(key => ({ id: key, style: matchStyle }));
        network.body.data.nodes.update(matchUpdates);
    }
}

// ---------------------------------------------------------------------------
// Export canvas
// ---------------------------------------------------------------------------
function exportCanvas() {
    if (!network) {
        setStatus("No canvas to export.", "warn");
        return;
    }

    try {
        const canvas = document.querySelector("#mynetwork canvas");
        if (!canvas) {
            setStatus("Canvas not found.", "error");
            return;
        }

        // Create a temporary link to download
        const link = document.createElement("a");
        link.download = `jira_viz_${new Date().toISOString().slice(0, 10)}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();

        setStatus(`Canvas exported as PNG.`, "info");
        appendToLogPanel(`INFO: Canvas exported as PNG`);
    } catch (err) {
        setStatus(`Export failed: ${err.message}`, "error");
        console.error(err);
    }
}

// ===========================================================================
// GANTT CHART
// ===========================================================================

let ganttBars = [];
let ganttWarnings = [];
let ganttDataQuality = {};
let ganttAssigneeSummaries = [];
let ganttSelectedBar = null;
let ganttCurrentView = "dag";
let ganttFocusKey = null;
let ganttPendingEdits = new Map();
let ganttCommitQueue = [];

// ── Entry point from connections panel ─────────────────────

async function showGanttForNode(nodeId) {
    ganttFocusKey = nodeId;
    const reachable = collectBlocksDag(nodeId);
    if (reachable.size === 0) {
        setStatus("No Blocks relationships found for " + nodeId, "warn");
        return;
    }
    const resp = await apiPost("/api/gantt", {
        keys: Array.from(reachable),
        focus_key: nodeId,
        view: ganttCurrentView
    });
    ganttBars = resp.bars || [];
    ganttWarnings = resp.warnings || [];
    ganttDataQuality = resp.data_quality || {};
    ganttAssigneeSummaries = resp.assignee_summaries || [];
    ganttSelectedBar = null;
    ganttPendingEdits.clear();
    ganttCommitQueue = [];
    openGanttDialog();
}

function collectBlocksDag(rootKey) {
    const visited = new Set();
    const queue = [rootKey];
    while (queue.length > 0) {
        const key = queue.shift();
        if (visited.has(key)) continue;
        visited.add(key);
        for (const rel of relationships) {
            if ((rel.link_type || "").toLowerCase() === "blocks") {
                if (rel.source_key === key && !visited.has(rel.target_key)) queue.push(rel.target_key);
                if (rel.target_key === key && !visited.has(rel.source_key)) queue.push(rel.source_key);
            }
        }
        // Also check cycleEdges if available
        if (typeof cycleEdges !== "undefined") {
            for (const ce of cycleEdges) {
                if ((ce.link_type || "").toLowerCase() === "blocks") {
                    if (ce.source_key === key && !visited.has(ce.target_key)) queue.push(ce.target_key);
                    if (ce.target_key === key && !visited.has(ce.source_key)) queue.push(ce.source_key);
                }
            }
        }
    }
    return visited;
}

// ── Dialog open/close ──────────────────────────────────────

function openGanttDialog() {
    document.getElementById("gantt-dialog").style.display = "flex";
    document.getElementById("gantt-title").textContent =
        "📊 Gantt — " + (ganttFocusKey || "All issues") + " (" + ganttBars.length + " issues)";
    document.getElementById("gantt-edit-section").style.display = "none";
    ganttSelectedBar = null;
    renderGanttChart();
    populateAssigneeFilter();
    updateGanttWarnings();
}

function closeGanttDialog() {
    document.getElementById("gantt-dialog").style.display = "none";
}

// ── Chart rendering (custom HTML bars) ─────────────────────

const GANTT_ISSUE_COLORS = {
    "Epic": "#cba6f7", "Story": "#a6e3a1", "Task": "#89b4fa",
    "Bug": "#f38ba8", "Key Result": "#fab387", "Sub-task": "#94e2d5",
    "default": "#89b4fa"
};

function getGanttIssueColor(issueType) {
    return GANTT_ISSUE_COLORS[issueType] || GANTT_ISSUE_COLORS["default"];
}

function renderGanttChart() {
    const canvas = document.getElementById("gantt-canvas");
    if (!canvas || ganttBars.length === 0) {
        if (canvas) canvas.innerHTML = "<p style='color:#6c7086;padding:20px;'>No bars to display.</p>";
        return;
    }

    // Time range
    const starts = ganttBars.map(b => new Date(b.start));
    const ends = ganttBars.map(b => new Date(b.end));
    const minTime = new Date(Math.min(...starts));
    const maxTime = new Date(Math.max(...ends));
    const totalRange = maxTime - minTime;
    if (totalRange <= 0) return;

    // Dimensions
    const barHeight = 22;
    const rowHeight = 30;
    const labelWidth = 160;
    const paddingLeft = 10;
    const maxLevel = Math.max(...ganttBars.map(b => b.level), 0) + 1;
    const chartWidth = canvas.clientWidth - labelWidth - 20 || 800;
    const chartHeight = Math.max(maxLevel * rowHeight + 40, 150);

    let html = `<div style="position:relative;width:${labelWidth + chartWidth + 30}px;height:${chartHeight}px;">`;

    // Time axis
    const numTicks = Math.min(10, Math.max(2, Math.floor(chartWidth / 100)));
    html += `<div style="position:absolute;left:${labelWidth}px;top:0;width:${chartWidth}px;height:20px;border-bottom:1px solid #45475a;">`;
    for (let i = 0; i <= numTicks; i++) {
        const t = new Date(minTime.getTime() + (totalRange * i / numTicks));
        const x = (i / numTicks) * chartWidth;
        html += `<span style="position:absolute;left:${x}px;font-size:9px;color:#6c7086;transform:translateX(-50%);">${fmtDate(t)}</span>`;
    }
    html += `</div>`;

    // Bars
    const assigneeFilter = document.getElementById("gantt-assignee-filter")?.value || "";
    let visibleBars = ganttBars;
    if (assigneeFilter) {
        visibleBars = ganttBars.filter(b => (b.assignee || "Unassigned") === assigneeFilter);
    }

    // Determine row labels based on view
    let rowLabels = [];
    if (ganttCurrentView === "assignee") {
        const names = [...new Set(visibleBars.map(b => b.assignee || "Unassigned"))].sort();
        if (names.indexOf("Unassigned") > -1) { names.splice(names.indexOf("Unassigned"), 1); names.push("Unassigned"); }
        rowLabels = names;
        // Re-assign levels
        visibleBars.forEach(b => {
            const name = b.assignee || "Unassigned";
            b._row = rowLabels.indexOf(name);
        });
    } else {
        rowLabels = Array.from({length: maxLevel}, (_, i) => "Level " + (i + 1));
        visibleBars.forEach(b => { b._row = b.level; });
    }

    const numRows = rowLabels.length || maxLevel;

    for (const bar of visibleBars) {
        const start = new Date(bar.start);
        const end = new Date(bar.end);
        const left = ((start - minTime) / totalRange) * chartWidth;
        const width = Math.max(((end - start) / totalRange) * chartWidth, 4);
        const top = 24 + (bar._row || bar.level) * rowHeight;
        const color = getGanttIssueColor(getIssueTypeForKey(bar.key));

        let borderStyle = "1px solid " + darkenColor(color, 40);
        let bgStyle = color;
        let labelExtra = "";

        if (bar.data_quality === "missing_both") {
            borderStyle = "2px dashed #f9e2af";
            labelExtra = " ⚠️";
        } else if (!bar.has_start_date) {
            bgStyle = `repeating-linear-gradient(45deg, ${color}, ${color} 4px, ${lightenColor(color, 25)} 4px, ${lightenColor(color, 25)} 8px)`;
        }

        const isSelected = ganttSelectedBar === bar.key;
        if (isSelected) {
            borderStyle = "3px solid #ffd700";
        }

        html += `<div class="gantt-bar" data-key="${bar.key}"
            style="position:absolute;left:${labelWidth + left}px;top:${top}px;
                   width:${width}px;height:${barHeight}px;
                   background:${bgStyle};border:${borderStyle};
                   border-radius:3px;cursor:pointer;overflow:hidden;
                   font-size:10px;color:#ffffff;font-weight:600;
                   text-shadow:0 1px 2px rgba(0,0,0,0.4);
                   line-height:${barHeight}px;padding-left:4px;white-space:nowrap;"
            onclick="onGanttBarClick('${bar.key}')"
            title="${bar.key}: ${escHtml(bar.summary)}&#10;Start: ${fmtDate(start)}&#10;End: ${fmtDate(end)}&#10;Duration: ${bar.effort_display}&#10;Assignee: ${bar.assignee || 'Unassigned'}&#10;Quality: ${bar.data_quality}">
            ${bar.key} ${labelExtra} (${bar.effort_display})
        </div>`;
    }

    // Row labels
    for (let r = 0; r < numRows; r++) {
        const y = 24 + r * rowHeight;
        html += `<div style="position:absolute;left:${paddingLeft}px;top:${y}px;width:${labelWidth - 20}px;
            font-size:10px;color:#a6adc8;line-height:${barHeight}px;overflow:hidden;white-space:nowrap;">${rowLabels[r] || "Row " + (r + 1)}</div>`;
    }

    html += `</div>`;
    canvas.innerHTML = html;

    // Legend
    const legend = document.getElementById("gantt-legend");
    if (legend) {
        const types = [...new Set(ganttBars.map(b => getIssueTypeForKey(b.key)))];
        legend.innerHTML = types.map(t =>
            `<span style="display:inline-flex;align-items:center;gap:4px;"><span style="width:10px;height:10px;background:${getGanttIssueColor(t)};border-radius:2px;display:inline-block;"></span>${t}</span>`
        ).join("");
    }

    // Assignee footer
    renderGanttAssigneeFooter();
}

function renderGanttAssigneeFooter() {
    const footer = document.getElementById("gantt-assignee-footer");
    if (!footer || ganttAssigneeSummaries.length === 0) { if (footer) footer.innerHTML = ""; return; }
    let html = "<table style='width:100%;font-size:10px;border-collapse:collapse;'>";
    html += "<tr style='color:#6c7086;'><th style='text-align:left;'>Assignee</th><th>Issues</th><th>Hours</th><th>Conflicts</th></tr>";
    for (const s of ganttAssigneeSummaries) {
        const conflict = s.overlapping_pairs > 0 ? " !! " + s.overlapping_pairs : " —";
        html += "<tr style='border-top:1px solid #313244;'>" +
            "<td>" + escHtml(s.assignee) + "</td>" +
            "<td style='text-align:center;'>" + s.issue_count + "</td>" +
            "<td style='text-align:center;'>" + s.total_hours + "h</td>" +
            "<td style='text-align:center;color:" + (s.overlapping_pairs > 0 ? '#f9e2af' : '#6c7086') + ";'>" + conflict + "</td></tr>";
    }
    html += "</table>";
    footer.innerHTML = html;
}

// ── Bar click & EDIT section ────────────────────────────────

function onGanttBarClick(key) {
    ganttSelectedBar = key;
    const bar = ganttBars.find(b => b.key === key);
    if (!bar) return;

    document.getElementById("gantt-edit-section").style.display = "block";
    document.getElementById("gantt-edit-key").textContent = key;

    const startInput = document.getElementById("gantt-start-date");
    const startCurrent = document.getElementById("gantt-start-current");
    if (bar.has_start_date && bar.start) {
        const sd = new Date(bar.start);
        startInput.value = sd.toISOString().slice(0, 10);
        startCurrent.textContent = "current: " + sd.toISOString().slice(0, 10) + " (explicit)";
    } else {
        startInput.value = "";
        startCurrent.textContent = "current: derived from blockers";
    }

    const effortInput = document.getElementById("gantt-effort");
    const effortCurrent = document.getElementById("gantt-effort-current");
    effortInput.value = bar.effort_display === "—" ? "" : bar.effort_display;
    effortCurrent.textContent = "current: " + bar.effort_display + " = " + bar.duration_seconds + "s = " + bar.duration_hours + "h";

    renderGanttChart();
}

function applyGanttEdit() {
    if (!ganttSelectedBar) return;
    const key = ganttSelectedBar;
    const newStart = document.getElementById("gantt-start-date").value;
    const effortRaw = document.getElementById("gantt-effort").value.trim();

    // Parse effort
    let effortSeconds = null;
    if (effortRaw) {
        effortSeconds = parseEffort(effortRaw);
        if (effortSeconds === null) {
            setStatus("Invalid effort format. Use: 3d, 2.5w, 4h, 1d 4h, 30m", "error");
            return;
        }
    }

    // Clear previous queue and build fresh edits
    ganttCommitQueue = [];
    ganttCommitQueue.push({
        issue_key: key,
        field: "start_date",
        old_value: ganttBars.find(b => b.key === key)?.start || null,
        value: newStart || null
    });
    if (effortSeconds) {
        ganttCommitQueue.push({
            issue_key: key,
            field: "original_estimate",
            value: String(effortSeconds)
        });
    }

    setStatus("Applying edit...", "info");

    // Apply on server + re-render
    apiPost("/api/gantt/apply-edits", {
        edits: ganttCommitQueue,
        focus_key: ganttFocusKey,
        keys: ganttBars.map(b => b.key),
        view: ganttCurrentView
    }).then(resp => {
        ganttBars = resp.bars || ganttBars;
        ganttWarnings = resp.warnings || [];
        ganttDataQuality = resp.data_quality || {};
        ganttAssigneeSummaries = resp.assignee_summaries || [];
        renderGanttChart();
        updateGanttWarnings();
        setStatus("Edit applied and queued for commit.", "info");
    }).catch(err => {
        setStatus("Failed to apply edit: " + err.message, "error");
    });
}

function resetGanttEdit() {
    ganttSelectedBar = null;
    document.getElementById("gantt-edit-section").style.display = "none";
    document.getElementById("gantt-start-date").value = "";
    document.getElementById("gantt-effort").value = "";
    renderGanttChart();
}

// ── View toggle ────────────────────────────────────────────

function toggleGanttView() {
    ganttCurrentView = ganttCurrentView === "dag" ? "assignee" : "dag";
    const btn = document.getElementById("btn-gantt-view");
    if (btn) btn.textContent = ganttCurrentView === "assignee" ? "DAG View" : "By Assignee";

    // Re-fetch with new view
    const keys = ganttBars.map(b => b.key);
    apiPost("/api/gantt", { keys, focus_key: ganttFocusKey, view: ganttCurrentView }).then(resp => {
        ganttBars = resp.bars || [];
        ganttAssigneeSummaries = resp.assignee_summaries || [];
        renderGanttChart();
        populateAssigneeFilter();
    });
}

function populateAssigneeFilter() {
    const sel = document.getElementById("gantt-assignee-filter");
    if (!sel) return;
    const names = [...new Set(ganttBars.map(b => b.assignee || "Unassigned"))].sort();
    if (names.indexOf("Unassigned") > -1) { names.splice(names.indexOf("Unassigned"), 1); names.push("Unassigned"); }
    sel.innerHTML = '<option value="">All</option>' + names.map(function(n) { return '<option value="' + escHtml(n) + '">' + escHtml(n) + '</option>'; }).join("");
}

function onGanttAssigneeFilter() {
    renderGanttChart();
}

// ── Warnings ───────────────────────────────────────────────

function updateGanttWarnings() {
    const badge = document.getElementById("gantt-dq-badge");
    const warningsDiv = document.getElementById("gantt-warnings");
    if (badge && ganttDataQuality) {
        const bad = (ganttDataQuality.missing_both || 0) + (ganttDataQuality.missing_estimate || 0) + (ganttDataQuality.missing_start_date || 0);
        if (bad > 0) {
            badge.style.display = "inline";
            badge.textContent = "!! " + bad;
        } else {
            badge.style.display = "none";
        }
    }
    if (warningsDiv) {
        warningsDiv.innerHTML = ganttWarnings.slice(0, 5).map(w => escHtml(w)).join("<br>");
        if (ganttWarnings.length > 5) warningsDiv.innerHTML += "<br>... and " + (ganttWarnings.length - 5) + " more";
    }
}

// ── Export PNG ─────────────────────────────────────────────

function exportGanttPNG() {
    const container = document.getElementById("gantt-chart-area");
    if (!container) return;
    if (typeof html2canvas === "undefined") {
        setStatus("html2canvas not loaded. Check internet connection.", "error");
        return;
    }
    html2canvas(container, {
        backgroundColor: "#1e1e2e",
        scale: 2
    }).then(canvas => {
        canvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "gantt-" + (ganttFocusKey || "all") + "-" + new Date().toISOString().slice(0, 10) + ".png";
            a.click();
            URL.revokeObjectURL(url);
        });
    }).catch(err => {
        setStatus("Export failed: " + err.message, "error");
    });
}

// ── Focus node in graph ────────────────────────────────────

function focusGanttNodeInGraph() {
    if (!ganttSelectedBar) {
        setStatus("Click a bar first to select it.", "warn");
        return;
    }
    if (network) {
        network.focus(ganttSelectedBar, { scale: 1.5, animation: true });
    }
    setStatus("Focused on " + ganttSelectedBar + " in graph.", "info");
}

// ── Helpers ────────────────────────────────────────────────

function parseEffort(input) {
    if (!input) return null;
    const regex = /(\d+\.?\d*)\s*(w|wk|weeks?|d|days?|h|hr|hrs?|hours?|m|min|mins?|minutes?)\b/gi;
    let total = 0;
    let match;
    let found = false;
    while ((match = regex.exec(input)) !== null) {
        const val = parseFloat(match[1]);
        const unit = match[2].toLowerCase()[0];
        const multipliers = { w: 144000, d: 28800, h: 3600, m: 60 };
        total += val * (multipliers[unit] || 0);
        found = true;
    }
    if (!found) {
        const plain = parseFloat(input);
        if (!isNaN(plain)) return Math.round(plain * 3600);
        return null;
    }
    return Math.round(total);
}

function getIssueTypeForKey(key) {
    const iss = issues.find(i => i.key === key);
    return iss ? (iss.issue_type || "default") : "default";
}

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

function escHtml(s) {
    if (!s) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    fetchLinkTypes();
    startLogRefresh();
    fetchCommitQueue();
    setInterval(fetchCommitQueue, 5000);
    setStatus("Ready. Enter a JQL query and click Fetch. (Ctrl+F to find)", "info");
});
