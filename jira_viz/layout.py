"""
Force-directed layout engine for jira_viz Phase 1.

Implements Fruchterman-Reingold algorithm in pure Python (no external deps).

Usage:
    from jira_viz.layout import force_directed_layout, LayoutResult
    result = force_directed_layout(graph, logger=logger)
    for pos in result.positions:
        print(pos.x, pos.y)
"""

import logging
import math
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class NodePosition:
    """A node's computed position on the canvas."""

    key: str
    x: float
    y: float

    def to_dict(self) -> dict:
        return {"key": self.key, "x": self.x, "y": self.y}


@dataclass
class LayoutResult:
    """Result of a layout computation."""

    positions: List[NodePosition] = field(default_factory=list)
    iterations: int = 0
    final_energy: float = 0.0

    def to_dict(self) -> dict:
        return {
            "positions": [p.to_dict() for p in self.positions],
            "iterations": self.iterations,
            "final_energy": self.final_energy,
        }


def force_directed_layout(
    graph,  # GraphModel
    logger: Optional[logging.Logger] = None,
    width: float = 800.0,
    height: float = 600.0,
    k: Optional[float] = None,
    max_iterations: int = 300,
    tolerance: float = 0.5,
    initial_temp: float = 100.0,
    seed: Optional[int] = None,
) -> LayoutResult:
    """
    Compute positions for all nodes in the graph using Fruchterman-Reingold.

    Args:
        graph: GraphModel with issues and relationships
        logger: Optional logger for progress
        width: Canvas width in pixels
        height: Canvas height in pixels
        k: Ideal edge length (default: sqrt(area / num_nodes))
        max_iterations: Maximum iterations before stopping
        tolerance: Energy threshold to stop early
        initial_temp: Initial temperature for simulation annealing
        seed: Random seed for reproducibility

    Returns:
        LayoutResult with positions for each node
    """
    issues = graph.issues
    relationships = graph.relationships

    if not issues:
        if logger:
            logger.info("Layout: no issues, returning empty result.")
        return LayoutResult()

    n = len(issues)
    area = width * height

    # Compute ideal edge length — scale down for small graphs to avoid
    # overly strong repulsive forces pushing nodes to canvas edges
    if k is None:
        base_k = math.sqrt(area / max(n, 1))
        # For small graphs, use a smaller k so nodes spread nicely
        k = max(base_k * 0.5, 50.0) if n <= 20 else base_k

    if logger:
        logger.info(
            "Layout: %d nodes, %d edges, k=%.1f, area=%.0f",
            n, len(relationships), k, area,
        )

    # Seed for reproducibility
    rng = random.Random(seed)

    # Initialise positions in a grid pattern with slight random offset
    # This gives a better starting point than pure random placement
    pos: Dict[str, Tuple[float, float]] = {}
    margin = k * 0.5
    cols = max(1, math.ceil(math.sqrt(n)))
    rows = max(1, math.ceil(n / cols))
    cell_w = (width - 2 * margin) / max(cols, 1)
    cell_h = (height - 2 * margin) / max(rows, 1)

    for idx, iss in enumerate(issues):
        col = idx % cols
        row = idx // cols
        base_x = margin + cell_w * (col + 0.5)
        base_y = margin + cell_h * (row + 0.5)
        # Add small random jitter
        jitter_x = rng.uniform(-cell_w * 0.2, cell_w * 0.2)
        jitter_y = rng.uniform(-cell_h * 0.2, cell_h * 0.2)
        pos[iss.key] = (
            max(margin, min(width - margin, base_x + jitter_x)),
            max(margin, min(height - margin, base_y + jitter_y)),
        )

    # Build adjacency for efficient force computation
    # Skip self-loops — they don't contribute meaningful positioning
    edges: List[Tuple[str, str]] = []
    for r in relationships:
        if r.source.key != r.target.key:
            edges.append((r.source.key, r.target.key))

    # Fruchterman-Reingold main loop
    temperature = initial_temp
    best_positions = dict(pos)

    for iteration in range(1, max_iterations + 1):
        # Compute forces
        fx = {key: 0.0 for key in pos}
        fy = {key: 0.0 for key in pos}

        # Repulsive forces (all pairs)
        keys = list(pos.keys())
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                ki, kj = keys[i], keys[j]
                dx = pos[ki][0] - pos[kj][0]
                dy = pos[ki][1] - pos[kj][1]
                dist = math.sqrt(dx * dx + dy * dy)
                if dist < 0.001:
                    dist = 0.001  # Avoid division by zero
                    dx = rng.uniform(-0.1, 0.1)
                    dy = rng.uniform(-0.1, 0.1)

                # Repulsive force: F = k^2 / d
                f_rep = (k * k) / dist
                fx[ki] += (dx / dist) * f_rep
                fy[ki] += (dy / dist) * f_rep
                fx[kj] -= (dx / dist) * f_rep
                fy[kj] -= (dy / dist) * f_rep

        # Attractive forces (edges only)
        for si, ti in edges:
            if si in pos and ti in pos:
                dx = pos[ti][0] - pos[si][0]
                dy = pos[ti][1] - pos[si][1]
                dist = math.sqrt(dx * dx + dy * dy)
                if dist < 0.001:
                    dist = 0.001

                # Attractive force: F = d^2 / k
                f_att = (dist * dist) / k
                fx[si] += (dx / dist) * f_att
                fy[si] += (dy / dist) * f_att
                fx[ti] -= (dx / dist) * f_att
                fy[ti] -= (dy / dist) * f_att

        # Compute total energy for this iteration
        energy = 0.0
        for key in pos:
            energy += fx[key] * fx[key] + fy[key] * fy[key]
        energy = math.sqrt(energy / n)

        # Update positions with temperature-limited movement
        max_displacement = temperature
        for key in pos:
            dx = fx[key]
            dy = fy[key]
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > 0:
                # Limit displacement to temperature
                displacement = min(dist, max_displacement)
                # Add tiny random perturbation to escape local minima
                perturbation = rng.uniform(-0.5, 0.5) * temperature * 0.01
                pos[key] = (
                    pos[key][0] + (dx / dist) * displacement + perturbation,
                    pos[key][1] + (dy / dist) * displacement + perturbation,
                )

        # Clamp positions to canvas boundaries (with margin)
        margin = k * 0.5
        for key in pos:
            px, py = pos[key]
            px = max(margin, min(width - margin, px))
            py = max(margin, min(height - margin, py))
            pos[key] = (px, py)

        # Cool down
        temperature *= 0.95

        # Log progress
        if logger and iteration % 20 == 0:
            logger.debug(
                "Layout iteration %d/%d: energy=%.2f, temp=%.2f",
                iteration, max_iterations, energy, temperature,
            )

        # Check convergence
        if energy < tolerance:
            if logger:
                logger.info("Layout converged at iteration %d (energy=%.4f).", iteration, energy)
            break

        best_positions = dict(pos)

    # Build result
    positions = []
    for iss in issues:
        px, py = best_positions.get(iss.key, (width / 2, height / 2))
        positions.append(NodePosition(key=iss.key, x=px, y=py))

    result = LayoutResult(
        positions=positions,
        iterations=iteration if 'iteration' in dir() else max_iterations,
        final_energy=energy,
    )

    if logger:
        logger.info(
            "Layout complete: %d positions, %d iterations, final energy=%.4f.",
            len(positions), result.iterations, result.final_energy,
        )

    return result
