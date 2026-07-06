/*
 * jira_tree frontend — Tree Visualizer
 *
 * Uses vis.js for graph rendering.
 * Communicates with FastAPI backend via JSON API.
 * Key difference from jira_viz: single /api/tree call fetches roots,
 * recursively traverses linked items, and returns layout positions.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let issues = [];
let relationships = [];
let cycleEdges = [];       // Cycle edges with special rendering
let treeMetadata = {};     // Tree build statistics
let network = null;
let linkTypes = [];
let commitQueueCount = 0;
let positions = null;      // Layout positions from server

// Drag state
let dragSourceNode = null;
let pendingDrag = null;

// Context menu state
let selectedEdge = null;
let contextMenuPos = { x: 0, y: 0 };

// Connections panel
let connectionsPanelOpen = false;
let connectionsPanelNode = null;

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
const LINK_TYPE_COLORS = {
    "blocks":        "#e74c3c",
    "is blocked by": "#e74c3c",
    "relates":       "#3498db",
    "is related to": "#3498db",
    "duplicates":    "#9b59b6",
    "is duplicated by": "#9b59b6",
    "clones":        "#2ecc71",
    "is cloned by":  "#2ecc71",
    "requires":      "#f39c12",
    "is required by": "#f39c12",
    "causes":        "#1abc9c",
    "is caused by":  "#1abc9c",
};

function getLinkTypeColor(type) {
    return LINK_TYPE_COLORS[type.toLowerCase()] || "#95a5a6";
}

function getLinkTypeColorLight(type) {
    const darker = {
        "blocks": "#c0392b", "is blocked by": "#c0392b",
        "relates": "#2980b9", "is related to": "#2980b9",
        "duplicates": "#8e44ad", "is duplicated by": "#8e44ad",
        "clones": "#27ae60", "is cloned by": "#27ae60",
        "requires": "#d68910", "is required by": "#d68910",
        "causes": "#16a085", "is caused by": "#16a085",
    };
    return darker[type.toLowerCase()] || "#7f8c8d";
}

const ISSUE_TYPE_COLORS = {
    "Epic": "#8e44ad", "Story": "#2980b9", "Task": "#27ae60",
    "Bug": "#c0392b", "Sub-task": "#7f8c8d", "Key Result": "#d35400",
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
// FETCH TREE — the main entry point
// ---------------------------------------------------------------------------
async function fetchTree() {
    const jql = document.getElementById("jql-input").value.trim();
    if (!jql) {
        setStatus("Please enter a root JQL query.", "warn");
        return;
    }

    const maxDepth = parseInt(document.getElementById("max-depth-input").value) || 15;
    const maxNodes = parseInt(document.getElementById("max-nodes-input").value) || 200;

    setStatus("Fetching root issues and traversing linked work items...", "info");
    document.getElementById("btn-fetch").disabled = true;

    try {
        const params = new URLSearchParams({
            jql: jql,
            max_root_results: 50,
            max_depth: maxDepth,
            max_nodes: maxNodes,
            width: 1200,
            height: 800,
            seed: 42,
        });
        const data = await apiGet(`/api/tree?${params.toString()}`);

        issues = data.issues || [];
        relationships = data.relationships || [];
        cycleEdges = data.cycle_edges || [];
        positions = data.positions || null;
        treeMetadata = data.tree_metadata || {};

        // Update tree metadata display
        updateTreeMetadata();

        // Update issue count
        document.getElementById("issue-count").textContent =
            `${treeMetadata.total_nodes || issues.length} nodes, ${treeMetadata.relationship_count || relationships.length} links`;

        // Update filter options
        updateFilterOptions();

        // Render graph
        renderGraph(positions);
        document.getElementById("btn-layout").disabled = issues.length === 0;

        const cycleInfo = treeMetadata.cycle_count > 0
            ? ` ⚠️ ${treeMetadata.cycle_count} cycle(s) detected`
            : "";

        setStatus(
            `Tree built: ${treeMetadata.total_nodes} nodes, ${treeMetadata.relationship_count} links, max depth ${treeMetadata.max_depth_reached}.${cycleInfo}`,
            "info"
        );

        appendToLogPanel(
            `TREE: ${treeMetadata.total_nodes} nodes, ${treeMetadata.relationship_count} links, ${treeMetadata.cycle_count} cycles, max depth ${treeMetadata.max_depth_reached}`
        );

        if (treeMetadata.warnings && treeMetadata.warnings.length > 0) {
            for (const w of treeMetadata.warnings) {
                appendToLogPanel(`WARNING: ${w}`);
            }
        }

    } catch (err) {
        setStatus(`Error fetching tree: ${err.message}`, "error");
        console.error(err);
    } finally {
        document.getElementById("btn-fetch").disabled = false;
    }
}

function updateTreeMetadata() {
    const el = document.getElementById("tree-metadata");
    const cycleBadge = document.getElementById("cycle-badge");

    if (!treeMetadata || !treeMetadata.total_nodes) {
        el.style.display = "none";
        if (cycleBadge) cycleBadge.style.display = "none";
        return;
    }

    el.style.display = "inline";
    el.textContent = `🌳 Depth: ${treeMetadata.max_depth_reached || 0} | ${treeMetadata.total_nodes} nodes`;

    if (treeMetadata.cycle_count > 0 && cycleBadge) {
        cycleBadge.style.display = "inline";
        cycleBadge.textContent = `⚠️ ${treeMetadata.cycle_count} cycle(s)`;
    } else if (cycleBadge) {
        cycleBadge.style.display = "none";
    }
}

// ---------------------------------------------------------------------------
// RENDER GRAPH — key difference: cycle edges rendered as dashed
// ---------------------------------------------------------------------------
function renderGraph(positions) {
    // Build cycle edge keys for quick lookup
    const cycleKeySet = new Set();
    for (const ce of cycleEdges) {
        // Store both directions since vis.js edges may be in either order
        cycleKeySet.add(`${ce.source_key}|||${ce.target_key}|||${ce.link_type}`);
        cycleKeySet.add(`${ce.target_key}|||${ce.source_key}|||${ce.link_type}`);
    }

    function isCycleEdge(sourceKey, targetKey, linkType) {
        return cycleKeySet.has(`${sourceKey}|||${targetKey}|||${linkType}`) ||
               cycleKeySet.has(`${targetKey}|||${sourceKey}|||${linkType}`);
    }

    // Build vis.js nodes
    const visNodes = [];
    const rootKeys = new Set(treeMetadata.root_keys || []);
    const cycleNodeKeys = new Set();
    for (const ce of cycleEdges) {
        cycleNodeKeys.add(ce.source_key);
        cycleNodeKeys.add(ce.target_key);
    }

    for (const iss of issues) {
        const typeColor = getIssueTypeColor(iss.issue_type);
        let summary = iss.summary && iss.summary.length > 60
            ? iss.summary.substring(0, 57) + "..."
            : (iss.summary || "");

        // Build label — add 🌱 for roots, ⚠️ for cycle nodes
        let labelPrefix = "";
        if (rootKeys.has(iss.key)) {
            labelPrefix = "🌱 ";
        }
        if (cycleNodeKeys.has(iss.key) && !rootKeys.has(iss.key)) {
            labelPrefix = "🔄 ";
        } else if (cycleNodeKeys.has(iss.key)) {
            labelPrefix = "🌱🔄 ";
        }

        visNodes.push({
            id: iss.key,
            label: `${labelPrefix}${iss.key}\n${summary}`,
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

    // Build vis.js edges
    const visEdges = [];
    const isLight = !isDarkTheme;

    // Regular relationships
    for (const rel of relationships) {
        const color = isLight ? getLinkTypeColorLight(rel.link_type) : getLinkTypeColor(rel.link_type);
        const strokeColor = isLight ? "#d5d8dc" : "#ffffff";
        const isCycle = isCycleEdge(rel.source_key, rel.target_key, rel.link_type);

        visEdges.push({
            from: rel.source_key,
            to: rel.target_key,
            label: rel.link_type + (isCycle ? " ⚠️" : ""),
            arrows: "to",
            color: {
                color: isCycle ? "#f38ba8" : color,
                highlight: lightenColor(isCycle ? "#f38ba8" : color, 20),
                hover: lightenColor(isCycle ? "#f38ba8" : color, 10),
            },
            font: {
                color: isCycle ? "#f38ba8" : color,
                size: 11,
                face: "sans-serif",
                strokeWidth: 0,
                strokeColor: strokeColor,
            },
            width: 2,
            dashes: isCycle ? [8, 4] : false,
            smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.4 },
            title: isCycle ? `⚠️ Cycle edge: ${rel.source_key} → ${rel.target_key} (${rel.link_type})` : undefined,
        });
    }

    // Cycle-only edges (ones that weren't already in relationships)
    const relKeySet = new Set();
    for (const rel of relationships) {
        relKeySet.add(`${rel.source_key}|||${rel.target_key}|||${rel.link_type}`);
    }
    for (const ce of cycleEdges) {
        const key = `${ce.source_key}|||${ce.target_key}|||${ce.link_type}`;
        if (!relKeySet.has(key)) {
            const color = "#f38ba8";
            visEdges.push({
                from: ce.source_key,
                to: ce.target_key,
                label: ce.link_type + " ⚠️",
                arrows: "to",
                color: { color: color, highlight: lightenColor(color, 20), hover: lightenColor(color, 10) },
                font: { color: color, size: 11, face: "sans-serif", strokeWidth: 0, strokeColor: "#ffffff" },
                width: 2,
                dashes: [8, 4],
                smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.4 },
                title: `⚠️ Cycle: ${ce.source_key} → ${ce.target_key} (${ce.link_type})`,
            });
        }
    }

    const data = { nodes: visNodes, edges: visEdges };

    const options = {
        nodes: {
            fixed: false,  // Allow dragging to rearrange hierarchy
        },
        edges: {
            smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.4 },
        },
        physics: {
            enabled: positions === undefined || positions === null,
            stabilization: { iterations: 150 },
        },
        interaction: {
            dragNodes: true,     // Allow dragging individual nodes
            zoomView: true,
            dragView: true,
            hover: true,
            navigationButtons: true,
        },
        layout: {
            improvedLayout: issues.length <= 50,
        },
    };

    // Apply positions from server
    if (positions && positions.length > 0) {
        for (const pos of positions) {
            const node = data.nodes.find(n => n.id === pos.key);
            if (node) {
                node.x = pos.x;
                node.y = pos.y;
            }
        }
    }

    const container = document.getElementById("mynetwork");

    if (network) {
        network.destroy();
        network = null;
    }

    network = new vis.Network(container, data, options);

    appendToLogPanel(`RENDER: ${data.nodes.length} nodes, ${data.edges.length} edges`);
    console.log(`Rendered: ${data.nodes.length} nodes, ${data.edges.length} edges`);

    initDragAndDrop();
    initDoubleClick();
    initContextMenu();
}

// ---------------------------------------------------------------------------
// Tooltip (with depth info if available)
// ---------------------------------------------------------------------------
function buildNodeTooltip(iss) {
    let t = `${iss.key} — ${iss.summary || "(no summary)"}`;
    t += `\nType: ${iss.issue_type || "?"}`;
    t += `\nStatus: ${iss.status || "?"}`;
    if (iss.assignee) t += `\nAssignee: ${iss.assignee}`;
    if (iss.project) t += `\nProject: ${iss.project}`;
    const rootKeys = new Set(treeMetadata.root_keys || []);
    if (rootKeys.has(iss.key)) t += `\n🌱 Root issue`;
    return t;
}

// ---------------------------------------------------------------------------
// Compute layout (manual re-layout button)
// ---------------------------------------------------------------------------
async function computeLayout() {
    if (issues.length === 0) {
        setStatus("No issues to layout.", "warn");
        return;
    }
    setStatus("Computing layout...", "info");
    try {
        const issuesJson = JSON.stringify(issues);
        const relsJson = JSON.stringify([...relationships, ...cycleEdges.map(ce => ({
            source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
        }))]);
        const url = `/api/layout?issues_json=${encodeURIComponent(issuesJson)}&relationships_json=${encodeURIComponent(relsJson)}&width=1200&height=800&seed=42`;
        const data = await apiGet(url);
        positions = data.positions;
        renderGraph(positions);
        setStatus(`Layout complete: ${data.iterations} iterations.`, "info");
    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
    }
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
        if (content.childElementCount !== entries.length) {
            content.innerHTML = entries.map(line => {
                let cls = "log-info";
                if (line.includes("ERROR")) cls = "log-error";
                else if (line.includes("WARNING")) cls = "log-warn";
                return `<div class="${cls}">${escapeHtml(line)}</div>`;
            }).join("");
        }
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
// Link types
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
    }
}

// ---------------------------------------------------------------------------
// Filter options
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
        if (typeof cycleEdges !== "undefined") {
            for (const ce of cycleEdges) {
                if (ce.link_type) types.add(ce.link_type);
            }
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
    const valueSelect = document.getElementById("filter-value");
    if (!valueSelect) return;
    if (currentField && fieldValues[currentField]) {
        const options = fieldValues[currentField];
        valueSelect.innerHTML = "";
        for (const opt of options) {
            const option = document.createElement("option");
            option.value = opt;
            option.textContent = opt;
            valueSelect.appendChild(option);
        }
    }
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------
let activeFilter = null;

function applyDisplayFilter() {
    const field = document.getElementById("filter-field").value;
    const valueSelect = document.getElementById("filter-value");
    const value = valueSelect.value.trim();
    const strict = document.getElementById("filter-strict").checked;
    if (!field || !value) {
        setStatus("Please select a field and value.", "warn");
        return;
    }

    const matchingKeys = new Set();

    if (field === "link_type") {
        // Find nodes that participate in any relationship of the selected type
        const allRels = [...relationships];
        if (typeof cycleEdges !== "undefined") allRels.push(...cycleEdges.map(ce => ({
            source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
        })));
        for (const rel of allRels) {
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
    let visibleKeys;
    if (strict) {
        visibleKeys = new Set(matchingKeys);
    } else {
        visibleKeys = new Set(matchingKeys);
        const queue = [...matchingKeys];
        while (queue.length > 0) {
            const key = queue.pop();
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
    if (network) {
        const nodeData = issues.map(iss => ({
            id: iss.key,
            hidden: !visibleKeys.has(iss.key),
        }));
        network.body.data.nodes.update(nodeData);
        const edgeData = [];
        const allRels = [...relationships, ...cycleEdges.map(ce => ({
            source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
        }))];
        for (const rel of allRels) {
            const visible = visibleKeys.has(rel.source_key) && visibleKeys.has(rel.target_key);
            edgeData.push({ from: rel.source_key, to: rel.target_key, hidden: !visible });
        }
        network.body.data.edges.update(edgeData);
        const visibleArr = [...visibleKeys];
        network.fit({ nodes: visibleArr, animation: true, scale: 0.7, margin: 80 });
    }
    activeFilter = { field, value };
    const mode = strict ? " (strict)" : " (with connections)";
    setStatus(`Filtered: ${visibleKeys.size} nodes visible (matched: ${matchingKeys.size})${mode}`, "info");
    appendToLogPanel(`INFO: Filter: ${field}="${value}"${strict ? " [strict]" : ""} → ${visibleKeys.size} nodes`);
}

function clearDisplayFilter() {
    activeFilter = null;
    document.getElementById("filter-field").value = "";
    const valueSelect = document.getElementById("filter-value");
    valueSelect.innerHTML = '<option value="">-- Value --</option>';
    if (network) {
        const nodeData = issues.map(iss => ({ id: iss.key, hidden: false }));
        network.body.data.nodes.update(nodeData);
        const allRels = [...relationships, ...cycleEdges.map(ce => ({
            source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
        }))];
        const edgeData = allRels.map(rel => ({ from: rel.source_key, to: rel.target_key, hidden: false }));
        network.body.data.edges.update(edgeData);
        const allKeys = issues.map(iss => iss.key);
        network.fit({ nodes: allKeys, animation: true, scale: 0.8, margin: 60 });
    }
    setStatus("Filter cleared.", "info");
    appendToLogPanel("INFO: Filter cleared");
}

// ---------------------------------------------------------------------------
// Drag-and-drop
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
                showRelationshipDialog(pendingDrag.source, endNode);
            }
            pendingDrag = null;
            dragSourceNode = null;
        }
    });
}

function showRelationshipDialog(sourceId, targetId) {
    const dialog = document.getElementById("rel-dialog");
    document.getElementById("rel-dialog-source").textContent = sourceId;
    document.getElementById("rel-dialog-target").textContent = targetId;
    const typesContainer = document.getElementById("rel-dialog-types");
    typesContainer.innerHTML = "";
    for (const lt of linkTypes) {
        const btn = document.createElement("button");
        btn.textContent = `${lt.name} (outward: ${lt.outward})`;
        btn.onclick = () => createRelationship(sourceId, targetId, lt.name);
        typesContainer.appendChild(btn);
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
    if (sourceId === targetId) {
        setStatus(`Self-loop rejected: ${sourceId}`, "error");
        appendToLogPanel(`WARNING: Self-loop rejected — ${sourceId} → ${sourceId}`);
        return;
    }
    setStatus(`Creating: ${sourceId} → ${targetId} (${linkType})`, "info");
    try {
        const resp = await fetch("/api/relationships", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_key: sourceId, target_key: targetId, link_type: linkType }),
        });
        const data = await resp.json();
        if (!resp.ok) {
            setStatus(`Error: ${data.error}`, "error");
            return;
        }
        relationships.push({ source_key: sourceId, target_key: targetId, link_type: linkType });
        commitQueueCount = data.queue_count || 0;
        updateCommitQueueDisplay();
        setStatus(`Created: ${sourceId} → ${targetId} (${linkType})`, "info");
        appendToLogPanel(`INFO: Added: ${sourceId} → ${targetId} (${linkType})`);
        renderGraph(positions);
    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
    }
}

// ---------------------------------------------------------------------------
// Double-click: connections panel
// ---------------------------------------------------------------------------
function initDoubleClick() {
    if (!network) return;
    network.on("doubleClick", function (params) {
        if (params.nodes.length > 0) {
            showConnectionsPanel(params.nodes[0]);
        }
    });
}

async function showConnectionsPanel(nodeId) {
    const panel = document.getElementById("connections-panel");
    document.getElementById("connections-node-key").textContent = nodeId;
    const content = document.getElementById("connections-content");
    content.innerHTML = "Loading...";
    panel.style.display = "flex";
    connectionsPanelOpen = true;
    connectionsPanelNode = nodeId;
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
        const sortedRevs = [...data.relationships].sort((a, b) => {
            if (a.direction !== b.direction) return a.direction === "incoming" ? -1 : 1;
            if (a.type.toLowerCase() !== b.type.toLowerCase()) return a.type.toLowerCase().localeCompare(b.type.toLowerCase());
            return a.source.localeCompare(b.source);
        });
        for (const rel of sortedRevs) {
            const div = document.createElement("div");
            div.className = `conn-item ${rel.direction}`;
            const otherKey = rel.direction === "incoming" ? rel.source : rel.target;
            const leftUrl = getJiraWebUrl(rel.source);
            const rightUrl = getJiraWebUrl(rel.target);
            div.innerHTML = `
                <span class="conn-type">${rel.type}</span>
                <span class="conn-key"> <a href="${leftUrl}" target="_blank" class="conn-url">${rel.source}</a> → <a href="${rightUrl}" target="_blank" class="conn-url">${rel.target}</a></span>
                <button class="conn-delete-btn" onclick="event.stopPropagation(); deleteConnection('${rel.source}', '${rel.target}', '${rel.type}')" title="Delete">×</button>
            `;
            div.style.cursor = "pointer";
            div.onclick = () => focusOnNode(otherKey);
            content.appendChild(div);
        }
    } catch (err) {
        content.innerHTML = `<p style="color:#f38ba8">Error: ${err.message}</p>`;
    }
}

function focusOnNode(nodeId) {
    if (network) network.focus(nodeId, { scale: 1.5, animation: true });
    appendToLogPanel(`INFO: Focused on ${nodeId}`);
}

function closeConnectionsPanel() {
    document.getElementById("connections-panel").style.display = "none";
    connectionsPanelOpen = false;
    connectionsPanelNode = null;
    restoreFullGraph();
}

// ---------------------------------------------------------------------------
// Show all related / direct connections
// ---------------------------------------------------------------------------
let allRelatedActive = false;
let directConnectionsActive = false;

function showAllRelated() {
    if (!network) return;
    if (allRelatedActive) { restoreFullGraph(); allRelatedActive = false; return; }
    const focusKey = document.getElementById("connections-node-key").textContent.trim();
    if (!focusKey) return;
    const adjacency = {};
    const allRels = [...relationships, ...cycleEdges.map(ce => ({
        source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
    }))];
    for (const rel of allRels) {
        if (!adjacency[rel.source_key]) adjacency[rel.source_key] = [];
        if (!adjacency[rel.target_key]) adjacency[rel.target_key] = [];
        adjacency[rel.source_key].push(rel.target_key);
        adjacency[rel.target_key].push(rel.source_key);
    }
    const visited = new Set();
    const queue = [focusKey];
    const relatedNodes = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        relatedNodes.add(current);
        for (const neighbor of (adjacency[current] || [])) {
            if (!visited.has(neighbor)) queue.push(neighbor);
        }
    }
    const nodeData = issues.map(iss => ({
        id: iss.key, hidden: !relatedNodes.has(iss.key),
        style: iss.key === focusKey ? { background: "#ffd700", border: "3px solid #ffd700", font: { size: 14, color: "#1e1e2e", bold: true } } : undefined
    }));
    network.body.data.nodes.update(nodeData);
    const edgeData = allRels.map(rel => ({
        from: rel.source_key, to: rel.target_key,
        hidden: !(relatedNodes.has(rel.source_key) && relatedNodes.has(rel.target_key))
    }));
    network.body.data.edges.update(edgeData);
    allRelatedActive = true;
    setStatus(`Showing ${relatedNodes.size} related nodes from ${focusKey}`, "info");
    appendToLogPanel(`INFO: Show all related — ${relatedNodes.size} nodes from ${focusKey}`);
}

function showDirectConnections() {
    if (directConnectionsActive) { restoreFullGraph(); directConnectionsActive = false; return; }
    if (!connectionsPanelNode || !network) return;
    fetch(`/api/relationships/${encodeURIComponent(connectionsPanelNode)}`)
        .then(resp => resp.json())
        .then(data => {
            directConnectionsActive = true;
            if (data.relationships && data.relationships.length > 0) {
                focusConnectedSubgraph(connectionsPanelNode, data.relationships);
            } else {
                const nodeData = issues.map(iss => ({
                    id: iss.key, hidden: iss.key !== connectionsPanelNode,
                    style: iss.key === connectionsPanelNode ? { background: "#ffd700", border: "3px solid #ffd700", font: { size: 14, color: "#1e1e2e", bold: true } } : undefined
                }));
                network.body.data.nodes.update(nodeData);
                network.fit({ nodes: [connectionsPanelNode], animation: true, scale: 1.2 });
            }
            setStatus(`Showing direct connections for ${connectionsPanelNode}`, "info");
        })
        .catch(err => {
            console.error(err);
            directConnectionsActive = false;
        });
}

function focusConnectedSubgraph(centerKey, rels) {
    const connectedKeys = new Set([centerKey]);
    for (const rel of rels) { connectedKeys.add(rel.source); connectedKeys.add(rel.target); }
    if (network) {
        const nodeData = issues.map(iss => ({
            id: iss.key, hidden: !connectedKeys.has(iss.key)
        }));
        network.body.data.nodes.update(nodeData);
        network.fit({ nodes: [...connectedKeys], animation: true, scale: 0.7, margin: 80 });
    }
    document.getElementById("btn-restore").style.display = "inline";
    appendToLogPanel(`INFO: Focused on ${centerKey} + ${connectedKeys.size - 1} connections`);
}

function restoreFullGraph() {
    if (!network) return;
    allRelatedActive = false;
    directConnectionsActive = false;
    const nodeData = issues.map(iss => ({ id: iss.key, hidden: false }));
    network.body.data.nodes.update(nodeData);
    const allRels = [...relationships, ...cycleEdges.map(ce => ({
        source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
    }))];
    const edgeData = allRels.map(rel => ({ from: rel.source_key, to: rel.target_key, hidden: false }));
    network.body.data.edges.update(edgeData);
    const allKeys = issues.map(iss => iss.key);
    if (allKeys.length > 0) network.fit({ nodes: allKeys, animation: true, scale: 0.8, margin: 60 });
    document.getElementById("btn-restore").style.display = "none";
    appendToLogPanel("INFO: Restored full graph");
}

// ---------------------------------------------------------------------------
// Context menu (right-click edges)
// ---------------------------------------------------------------------------
function initContextMenu() {
    if (!network) return;
    network.on("oncontext", function (params) {
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
    if (!selectedEdge || !selectedEdge.edgeId) return;
    const edgeData = network.body.data.edges.get(selectedEdge.edgeId);
    if (!edgeData) return;
    const { from, to } = edgeData;
    const edge = relationships.find(r =>
        (r.source_key === from && r.target_key === to) || (r.source_key === to && r.target_key === from)
    );
    const ceEdge = cycleEdges.find(ce =>
        (ce.source_key === from && ce.target_key === to) || (ce.source_key === to && ce.target_key === from)
    );
    const sourceKey = edge ? edge.source_key : (ceEdge ? ceEdge.source_key : from);
    const targetKey = edge ? edge.target_key : (ceEdge ? ceEdge.target_key : to);
    const linkType = edge ? edge.link_type : (ceEdge ? ceEdge.link_type : "Unknown");
    if (!edge && !ceEdge) {
        setStatus("Edge not found in local state", "warn");
        return;
    }
    try {
        const resp = await fetch("/api/relationships", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_key: sourceKey, target_key: targetKey, link_type: linkType }),
        });
        const data = await resp.json();
        if (!resp.ok) { setStatus(`Error: ${data.error}`, "error"); return; }
        relationships = relationships.filter(r =>
            !((r.source_key === sourceKey && r.target_key === targetKey && r.link_type === linkType) ||
              (r.source_key === targetKey && r.target_key === sourceKey && r.link_type === linkType))
        );
        cycleEdges = cycleEdges.filter(ce =>
            !((ce.source_key === sourceKey && ce.target_key === targetKey && ce.link_type === linkType) ||
              (ce.source_key === targetKey && ce.target_key === sourceKey && ce.link_type === linkType))
        );
        commitQueueCount = data.queue_count || 0;
        updateCommitQueueDisplay();
        setStatus(`Deleted: ${sourceKey} → ${targetKey} (${linkType})`, "info");
        appendToLogPanel(`INFO: Deleted: ${sourceKey} → ${targetKey} (${linkType})`);
        renderGraph(positions);
    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
    }
}

function editSelectedEdge() {
    hideContextMenu();
    if (!selectedEdge) return;
    deleteSelectedEdge();
    setStatus("Deleted. Drag nodes to recreate with new type.", "info");
}

// ---------------------------------------------------------------------------
// Delete from connections panel
// ---------------------------------------------------------------------------
async function deleteConnection(sourceKey, targetKey, linkType) {
    if (!confirm(`Delete: ${sourceKey} → ${targetKey} (${linkType})?`)) return;
    try {
        const resp = await fetch("/api/relationships", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_key: sourceKey, target_key: targetKey, link_type: linkType }),
        });
        const data = await resp.json();
        if (!resp.ok) { setStatus(`Error: ${data.error}`, "error"); return; }
        relationships = relationships.filter(r =>
            !(r.source_key === sourceKey && r.target_key === targetKey && r.link_type === linkType)
        );
        cycleEdges = cycleEdges.filter(ce =>
            !(ce.source_key === sourceKey && ce.target_key === targetKey && ce.link_type === linkType)
        );
        commitQueueCount = data.queue_count || 0;
        updateCommitQueueDisplay();
        setStatus(`Deleted from canvas. Queued for commit.`, "info");
        appendToLogPanel(`INFO: Deleted: ${sourceKey} → ${targetKey} (${linkType})`);
        if (connectionsPanelOpen && connectionsPanelNode) await showConnectionsPanel(connectionsPanelNode);
        renderGraph(positions);
    } catch (err) {
        setStatus(`Error: ${err.message}`, "error");
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
    const typeSelect = document.createElement("select");
    typeSelect.id = "add-conn-type-select";
    typeSelect.style.cssText = "width:100%;padding:6px;margin-bottom:8px;background:#1e1e2e;border:1px solid #45475a;color:#cdd6f4;border-radius:3px;";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = ""; defaultOpt.textContent = "-- Select Link Type --";
    typeSelect.appendChild(defaultOpt);
    for (const lt of linkTypes) {
        const opt = document.createElement("option");
        opt.value = lt.name;
        opt.textContent = `${lt.name} (outward: ${lt.outward})`;
        typeSelect.appendChild(opt);
    }
    typeSelect.onchange = () => { selectedLinkType = typeSelect.value; };
    typesContainer.appendChild(typeSelect);
    const targetDiv = document.createElement("div");
    targetDiv.style.marginTop = "12px";
    targetDiv.innerHTML = `
        <label style="font-size:12px;color:#cdd6f4;">Target issue key or summary:</label>
        <input type="text" id="add-conn-target" placeholder="e.g. OKR-17" style="width:100%;padding:6px;margin-top:4px;background:#1e1e2e;border:1px solid #45475a;color:#cdd6f4;border-radius:3px;" />
        <div id="add-conn-search-results" style="max-height:150px;overflow-y:auto;margin-top:6px;"></div>
    `;
    typesContainer.appendChild(targetDiv);
    const targetField = document.getElementById("add-conn-target");
    targetField.addEventListener("input", async () => {
        const query = targetField.value.trim();
        const resultsDiv = document.getElementById("add-conn-search-results");
        resultsDiv.innerHTML = "";
        if (!query) return;
        try {
            const resp = await apiGet(`/api/search?q=${encodeURIComponent(query)}`);
            for (const match of (resp.matches || [])) {
                const div = document.createElement("div");
                div.style.cssText = "padding:4px 8px;cursor:pointer;font-size:12px;color:#cdd6f4;";
                div.innerHTML = `<strong>${match.key}</strong> — ${(match.summary || "").substring(0, 50)}`;
                div.onclick = () => { targetField.value = match.key; resultsDiv.innerHTML = ""; };
                resultsDiv.appendChild(div);
            }
        } catch (err) { console.error(err); }
    });
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "✓ Confirm Connection";
    confirmBtn.style.cssText = "margin-top:12px;padding:10px 16px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;font-size:14px;font-weight:700;cursor:pointer;";
    confirmBtn.onclick = () => {
        const targetKey = document.getElementById("add-conn-target").value.trim();
        if (!targetKey) { alert("Please enter a target key."); return; }
        if (!selectedLinkType) { alert("Please select a link type."); return; }
        createRelationship(centerKey, targetKey, selectedLinkType);
    };
    typesContainer.appendChild(confirmBtn);
    dialog.style.display = "flex";
}

let selectedLinkType = null;

// ---------------------------------------------------------------------------
// Multi-link dialog
// ---------------------------------------------------------------------------
let multilinkParentKey = null;
let multilinkRows = [];

function openMultiLinkDialog() {
    multilinkParentKey = document.getElementById("connections-node-key").textContent.trim();
    multilinkRows = [];
    document.getElementById("multilink-parent-key").textContent = multilinkParentKey;
    document.getElementById("multilink-list").innerHTML = "";
    document.getElementById("multilink-validation").style.display = "none";
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
    const childSelect = row.querySelector(".multilink-child-select");
    for (const iss of issues) {
        if (iss.key !== multilinkParentKey) {
            const opt = document.createElement("option");
            opt.value = iss.key;
            opt.textContent = `${iss.key} — ${(iss.summary || "").substring(0, 40)}`;
            childSelect.appendChild(opt);
        }
    }
    const typeSelect = row.querySelector(".multilink-type-select");
    for (const lt of linkTypes) {
        const opt = document.createElement("option");
        opt.value = lt.name || lt; opt.textContent = lt.name || lt;
        typeSelect.appendChild(opt);
    }
    childSelect.addEventListener("change", () => validateMultilinkRow(rowId));
    typeSelect.addEventListener("change", () => validateMultilinkRow(rowId));
    multilinkRows.push({ childKey: "", linkType: "", validationStatus: "", validationMessage: "" });
}

function removeMultilinkRow(rowId) {
    const list = document.getElementById("multilink-list");
    const rows = list.querySelectorAll("div");
    if (rows[rowId]) rows[rowId].remove();
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
    const entry = multilinkRows[rowId] || {};
    entry.childKey = childKey; entry.linkType = linkType;
    if (!childKey || !linkType) {
        entry.validationStatus = ""; entry.validationMessage = "";
    } else if (childKey === multilinkParentKey) {
        entry.validationStatus = "error"; entry.validationMessage = "Cannot link to self";
    } else {
        const validType = linkTypes.some(lt => (lt.name || lt).toLowerCase() === linkType.toLowerCase());
        if (!validType) {
            entry.validationStatus = "error"; entry.validationMessage = `Unknown type: ${linkType}`;
        } else {
            const exists = relationships.some(r =>
                ((r.source_key === multilinkParentKey && r.target_key === childKey) ||
                 (r.source_key === childKey && r.target_key === multilinkParentKey)) &&
                r.link_type.toLowerCase() === linkType.toLowerCase()
            );
            entry.validationStatus = exists ? "warning" : "ok";
            entry.validationMessage = exists ? "Already exists" : "";
        }
    }
    validateMultilinkAll();
}

function validateMultilinkAll() {
    const vDiv = document.getElementById("multilink-validation");
    const wDiv = document.getElementById("multilink-warnings");
    wDiv.innerHTML = "";
    let hasWarnings = false;
    for (const entry of multilinkRows) {
        if (entry.validationStatus === "warning" || entry.validationStatus === "error") {
            hasWarnings = true;
            const p = document.createElement("p");
            p.style.color = entry.validationStatus === "error" ? "#f38ba8" : "#f9e2af";
            p.textContent = `• ${entry.childKey} → ${entry.linkType}: ${entry.validationMessage}`;
            wDiv.appendChild(p);
        }
    }
    vDiv.style.display = hasWarnings ? "block" : "none";
}

function cancelMultilink() {
    document.getElementById("multilink-dialog").style.display = "none";
    multilinkParentKey = null; multilinkRows = [];
}

async function executeMultilink() {
    if (!multilinkParentKey) return;
    const list = document.getElementById("multilink-list");
    const rows = list.querySelectorAll("div");
    const ops = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const childKey = row.querySelector(".multilink-child-select").value;
        const linkType = row.querySelector(".multilink-type-select").value;
        if (childKey && linkType) ops.push({ source_key: multilinkParentKey, target_key: childKey, link_type: linkType });
    }
    if (ops.length === 0) { setStatus("No relationships to add.", "warn"); return; }
    for (const op of ops) {
        await apiPost("/api/relationships", op);
        relationships.push({ source_key: op.source_key, target_key: op.target_key, link_type: op.link_type });
    }
    cancelMultilink();
    updateCommitQueueDisplay();
    renderGraph(positions);
    showCommitDialog();
}

// ---------------------------------------------------------------------------
// Find / Search
// ---------------------------------------------------------------------------
let findMatches = [];
let findCurrentIndex = -1;
let findQuery = "";

function manualFind() {
    const query = document.getElementById("find-input").value.trim();
    if (!query) { clearFind(); return; }
    if (issues.length === 0) { setStatus("⚠️ Fetch tree first.", "warn"); return; }
    findQuery = query;
    performFind(query);
}

function onFindKeydown(event) {
    if (event.key === "Enter") { event.preventDefault(); manualFind(); }
}

async function performFind(query) {
    try {
        const resp = await apiGet(`/api/search?q=${encodeURIComponent(query)}`);
        findMatches = resp.matches.map(m => m.key);
        findCurrentIndex = -1;
        updateFindCounter();
        if (!network) return;
        const strict = document.getElementById("find-strict").checked;
        const ids = findMatches;
        if (ids.length > 0) {
            const style = { borderColor: "#ff0000", borderWidth: 6, color: { background: "#ff6b6b", border: "#ff0000" }, font: { color: "#ffffff", bold: true, size: 14 } };
            if (strict) {
                const allKeys = issues.map(iss => iss.key);
                network.body.data.nodes.update(allKeys.map(key => ({
                    id: key, hidden: !findMatches.includes(key),
                    style: findMatches.includes(key) ? style : undefined
                })));
                const allRels = [...relationships, ...cycleEdges.map(ce => ({
                    source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
                }))];
                const edgeData = allRels.map(rel => ({
                    from: rel.source_key, to: rel.target_key,
                    hidden: !(findMatches.includes(rel.source_key) && findMatches.includes(rel.target_key))
                }));
                network.body.data.edges.update(edgeData);
            } else {
                network.body.data.nodes.update(ids.map(key => ({ id: key, style })));
            }
            const mode = strict ? " (strict)" : "";
            setStatus(`Found ${ids.length} match${ids.length > 1 ? "es" : ""}${mode}. Use ◀/▶ to navigate.`, "info");
        } else {
            setStatus("No matches found.", "info");
        }
    } catch (err) { console.error(err); findMatches = []; updateFindCounter(); }
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
    const redStyle = { borderColor: "#ff0000", borderWidth: 6, color: { background: "#ff6b6b", border: "#ff0000" }, font: { color: "#ffffff", bold: true, size: 14 } };
    network.body.data.nodes.update(findMatches.map(key => ({ id: key, style: redStyle })));
    const currentStyle = { borderColor: "#ffd700", borderWidth: 8, color: { background: "#ffd700", border: "#ff8c00" }, font: { color: "#000000", bold: true, size: 16 } };
    network.body.data.nodes.update({ id: currentKey, style: currentStyle });
    network.focus(currentKey, { scale: 1.5, animation: true });
}

function clearFind() {
    findQuery = "";
    findMatches = [];
    findCurrentIndex = -1;
    document.getElementById("find-input").value = "";
    updateFindCounter();
    if (network) {
        network.body.data.nodes.update(issues.map(iss => ({ id: iss.key, hidden: false })));
        const allRels = [...relationships, ...cycleEdges.map(ce => ({
            source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
        }))];
        network.body.data.edges.update(allRels.map(rel => ({ from: rel.source_key, to: rel.target_key, hidden: false })));
    }
}

function focusFoundNode() {
    if (findMatches.length === 0) { setStatus("No matches.", "warn"); return; }
    const idx = findCurrentIndex >= 0 ? findCurrentIndex : 0;
    const key = findMatches[idx];
    if (network) network.focus(key, { scale: 1.8, animation: true });
    showConnectionsPanel(key);
    setStatus(`Focused on ${key} (${idx + 1}/${findMatches.length})`, "info");
}

function updateFindCounter() {
    const counter = document.getElementById("find-counter");
    const focusBtn = document.getElementById("btn-find-focus");
    if (findMatches.length === 0) {
        if (counter) counter.textContent = "No matches";
        if (focusBtn) focusBtn.style.display = "none";
    } else {
        if (counter) counter.textContent = findCurrentIndex < 0 ? `${findMatches.length} found` : `${findCurrentIndex + 1}/${findMatches.length}`;
        if (focusBtn) { focusBtn.style.display = ""; focusBtn.textContent = `Focus (${findCurrentIndex >= 0 ? findCurrentIndex + 1 : 1}/${findMatches.length})`; }
    }
}

// ---------------------------------------------------------------------------
// Commit workflow
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
    } catch (err) { console.error("Failed to fetch commit queue:", err); }
}

async function showCommitDialog() {
    if (commitQueueCount === 0) { setStatus("Nothing to commit.", "warn"); return; }
    try {
        const data = await apiGet("/api/commit-plan");
        const ops = data.ops || [];
        const opsList = document.getElementById("commit-ops-list");
        opsList.innerHTML = "";
        for (const op of ops) {
            const div = document.createElement("div");
            div.className = `commit-op ${op.action}`;
            const icon = op.action === "create" ? "+" : "-";
            const statusIcon = op.validation_status === "error" ? "⚠️" : (op.validation_status === "warning" ? "⚡" : "✓");
            div.innerHTML = `
                <span class="op-type">${icon} ${op.action.toUpperCase()}</span>
                <span class="op-keys">${op.source_key} → ${op.target_key} (${op.link_type})</span>
                <span class="op-status">${statusIcon} ${op.validation_status || "ok"}</span>
            `;
            if (op.validation_status === "error") div.style.borderLeftColor = "#f38ba8";
            else if (op.validation_status === "warning") div.style.borderLeftColor = "#f9e2af";
            opsList.appendChild(div);
        }
        document.getElementById("commit-dialog").style.display = "flex";
    } catch (err) { setStatus(`Error: ${err.message}`, "error"); }
}

async function dryRunCommit() {
    try {
        const data = await apiGet("/api/commit?dry_run=true");
        const opsList = document.getElementById("commit-ops-list");
        opsList.innerHTML = "";
        for (const op of data.ops || []) {
            const div = document.createElement("div");
            div.className = `commit-op ${op.action}`;
            const status = op.success ? "✓ Would succeed" : "✗ Would fail";
            div.innerHTML = `
                <span class="op-type">${op.action === "create" ? "+" : "-"} ${op.action.toUpperCase()}</span>
                <span class="op-keys">${op.source_key} → ${op.target_key} (${op.link_type})</span>
                <span class="op-status ${op.success ? "success" : "error"}">${status}</span>
                ${!op.success && op.error_message ? `<div class="op-error">${op.error_message}</div>` : ""}
            `;
            opsList.appendChild(div);
        }
        setStatus(`Dry run: ${data.success_count} ok, ${data.failure_count} fail`, data.success_count === (data.ops || []).length ? "info" : "warn");
    } catch (err) { setStatus(`Error: ${err.message}`, "error"); }
}

function cancelCommit() { document.getElementById("commit-dialog").style.display = "none"; }

async function clearCommitQueue() {
    if (!confirm("Clear all pending changes?")) return;
    try {
        const resp = await fetch("/api/commit-queue", { method: "DELETE" });
        const data = await resp.json();
        commitQueueCount = 0;
        updateCommitQueueDisplay();
        setStatus("Queue cleared.", "info");
        cancelCommit();
    } catch (err) { setStatus(`Error: ${err.message}`, "error"); }
}

async function executeCommit() {
    document.getElementById("commit-dialog").style.display = "none";
    setStatus("Committing to JIRA...", "info");
    document.getElementById("btn-commit").disabled = true;
    try {
        const dryResp = await apiGet("/api/commit?dry_run=true");
        const dryOps = dryResp.ops || [];
        showCommitResult(dryOps, dryResp.success_count, dryResp.failure_count);
        if (dryResp.failure_count > 0) {
            if (!confirm(`${dryResp.failure_count} operation(s) would fail. Proceed anyway?`)) {
                setStatus("Commit cancelled.", "warn");
                document.getElementById("btn-commit").disabled = false;
                return;
            }
        }
        const commitResp = await apiPost("/api/commit", {});
        const resultOps = commitResp.ops || [];
        showCommitResult(resultOps, commitResp.success_count, commitResp.failure_count, commitResp.remaining_queue);
        if (commitResp.success_count > 0) {
            commitQueueCount = commitResp.remaining_queue || 0;
            updateCommitQueueDisplay();
        }
    } catch (err) { setStatus(`Commit failed: ${err.message}`, "error"); }
    finally { document.getElementById("btn-commit").disabled = false; }
}

function showCommitResult(ops, successCount, failureCount, remainingQueue) {
    const dialog = document.getElementById("commit-result-dialog");
    const content = document.getElementById("commit-result-content");
    content.innerHTML = "";
    const summary = document.createElement("div");
    summary.style.marginBottom = "12px";
    summary.innerHTML = `
        <strong>Success:</strong> ${successCount} &nbsp;
        <strong>Failed:</strong> ${failureCount} &nbsp;
        ${remainingQueue !== undefined ? `<strong>Remaining in queue:</strong> ${remainingQueue}` : ""}
    `;
    content.appendChild(summary);
    for (const op of ops) {
        const div = document.createElement("div");
        div.className = `commit-op ${op.action} ${op.success ? "success" : "failure"}`;
        div.innerHTML = `
            <span class="op-type">${op.success ? "✓" : "✗"} ${op.action.toUpperCase()}</span>
            <span class="op-keys">${op.source_key} → ${op.target_key} (${op.link_type})</span>
            ${op.error_message ? `<div class="op-error">${op.error_message}</div>` : ""}
        `;
        content.appendChild(div);
    }
    dialog.style.display = "flex";
    appendToLogPanel(`INFO: Commit: ${successCount} ok, ${failureCount} failed`);
}

function closeCommitResult() { document.getElementById("commit-result-dialog").style.display = "none"; }

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------
let isDarkTheme = true;

function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    const btn = document.getElementById("btn-theme");
    if (isDarkTheme) {
        document.body.classList.remove("light-theme");
        btn.textContent = "🌙";
    } else {
        document.body.classList.add("light-theme");
        btn.textContent = "☀️";
    }
    appendToLogPanel(`INFO: Theme → ${isDarkTheme ? "dark" : "light"}`);
    if (network && issues.length > 0) {
        const isLight = !isDarkTheme;
        const allRels = [...relationships, ...cycleEdges.map(ce => ({
            source_key: ce.source_key, target_key: ce.target_key, link_type: ce.link_type
        }))];
        const edgeUpdates = allRels.map(rel => {
            const color = isLight ? getLinkTypeColorLight(rel.link_type) : getLinkTypeColor(rel.link_type);
            const strokeColor = isLight ? "#d5d8dc" : "#ffffff";
            return {
                from: rel.source_key, to: rel.target_key,
                color: { color: color, highlight: lightenColor(color, 20), hover: lightenColor(color, 10) },
                font: { color: color, strokeWidth: 0, strokeColor: strokeColor },
            };
        });
        network.body.data.edges.update(edgeUpdates);
    }
}

// ---------------------------------------------------------------------------
// Export canvas
// ---------------------------------------------------------------------------
function exportCanvas() {
    if (!network) { setStatus("No canvas to export.", "warn"); return; }
    try {
        const canvas = document.querySelector("#mynetwork canvas");
        if (!canvas) { setStatus("Canvas not found.", "error"); return; }
        const link = document.createElement("a");
        link.download = `jira_tree_${new Date().toISOString().slice(0, 10)}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        setStatus("Canvas exported as PNG.", "info");
        appendToLogPanel("INFO: Canvas exported as PNG");
    } catch (err) { setStatus(`Export failed: ${err.message}`, "error"); }
}

// ---------------------------------------------------------------------------
// Utility: JIRA URL
// ---------------------------------------------------------------------------
function getJiraWebUrl(issueKey) {
    const issue = issues.find(iss => iss.key === issueKey);
    if (issue && issue.jira_web_url) return issue.jira_web_url;
    const baseUrl = window.__JIRA_BASE_URL__ || "https://your-instance.atlassian.net";
    return baseUrl + "/browse/" + issueKey;
}

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
        logPanel.style.display = "flex"; btn.textContent = "📋 Log";
    } else {
        logPanel.style.display = "none"; btn.textContent = "📋 Show Log";
    }
}

// ---------------------------------------------------------------------------
// Filter section toggle
// ---------------------------------------------------------------------------
let filterSectionVisible = true;

function toggleFilterSection() {
    const filterSection = document.getElementById("filter-section");
    const btn = document.getElementById("btn-toggle-filter");
    if (!filterSection || !btn) return;
    filterSectionVisible = !filterSectionVisible;
    if (filterSectionVisible) {
        filterSection.style.display = "flex"; btn.textContent = "🔍 Hide Filter";
    } else {
        filterSection.style.display = "none"; btn.textContent = "🔍 Filter";
    }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        const findInput = document.getElementById("find-input");
        if (findInput) { findInput.focus(); findInput.select(); }
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selectedEdge && !e.target.closest("input")) {
        e.preventDefault(); deleteSelectedEdge();
    }
    if (e.key === "Escape") {
        hideContextMenu();
        ["rel-dialog", "commit-dialog", "commit-result-dialog"].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.style.display !== "none") {
                if (id === "rel-dialog") cancelRelationship();
                else if (id === "commit-dialog") cancelCommit();
                else closeCommitResult();
            }
        });
        if (connectionsPanelOpen) closeConnectionsPanel();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "l") { e.preventDefault(); toggleLogPanel(); }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "f") { e.preventDefault(); toggleFilterSection(); }
});

// ---------------------------------------------------------------------------
// Load default JQL
// ---------------------------------------------------------------------------
async function loadDefaultJql() {
    try {
        const response = await fetch("/api/default-jql");
        const data = await response.json();
        if (data.default_jql) {
            const jqlInput = document.getElementById("jql-input");
            if (jqlInput) jqlInput.value = data.default_jql;
        }
    } catch (err) { console.warn("Failed to load default JQL:", err); }
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
            a.download = `gantt-${ganttFocusKey || "all"}-${new Date().toISOString().slice(0, 10)}.png`;
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
    setStatus(`Focused on ${ganttSelectedBar} in graph.`, "info");
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
    const fieldSelect = document.getElementById("filter-field");
    if (fieldSelect) fieldSelect.addEventListener("change", () => updateFilterOptions());
    loadDefaultJql();
    fetchLinkTypes();
    startLogRefresh();
    fetchCommitQueue();
    setInterval(fetchCommitQueue, 5000);
    setStatus("Ready. Enter root JQL and click 🌳 Fetch Tree. (Ctrl+F to find)", "info");
});
