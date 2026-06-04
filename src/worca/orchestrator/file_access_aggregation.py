"""File access aggregation at iteration completion.

Reads the iteration's JSONL file, canonicalizes+respells paths,
aggregates reads/writes/searches, and computes leakage_pct.
"""

import json
import os
from typing import Optional

from worca.orchestrator.path_canon import canonicalize, GitPathOracle


def get_iteration_jsonl_path(run_id: str, stage: str, iteration: int, bead_id: Optional[str] = None, project_root: str = ".") -> str:
    """Compute the JSONL file path for an iteration's file access records.

    Args:
        run_id: Run ID
        stage: Stage name
        iteration: Iteration number
        bead_id: Optional bead ID
        project_root: Project root directory

    Returns:
        Path to the JSONL file
    """
    if bead_id:
        filename = f"{stage}-{iteration}-{bead_id}.jsonl"
    else:
        filename = f"{stage}-{iteration}.jsonl"
    return os.path.join(project_root, ".worca", "runs", run_id, "access", filename)


def aggregate_iteration_file_access(
    run_id: str, stage: str, iteration: int, repo_root: str, bead_id: Optional[str] = None, project_root: str = "."
) -> dict:
    """Aggregate file access for a single iteration (convenience wrapper).

    Computes the JSONL path and aggregates in one call.

    Args:
        run_id: Run ID
        stage: Stage name
        iteration: Iteration number
        repo_root: Repository root
        bead_id: Optional bead ID
        project_root: Project root directory

    Returns:
        file_access dict
    """
    jsonl_path = get_iteration_jsonl_path(run_id, stage, iteration, bead_id, project_root)
    return aggregate_file_access(jsonl_path, repo_root)


def aggregate_file_access(jsonl_path: str, repo_root: str) -> dict:
    """Aggregate file access records from JSONL into structured output.

    Reads the JSONL file, canonicalizes paths, respells via git oracle,
    filters, and aggregates into file_access dict.

    Args:
        jsonl_path: Path to the JSONL file (e.g., ".worca/runs/.../access/implement-1.jsonl")
        repo_root: Repository root directory

    Returns:
        file_access dict with structure:
        {
            "reads": {path: count, ...},
            "writes": {path: count, ...},
            "searches": [...],
            "totals": {distinct_read, total_read, distinct_write, total_write, grep, glob, zero_result, root_scoped},
            "capture": {hook_writes, git_writes, leakage_pct, oracle}
        }

        On git failure, oracle='degraded' and paths degrade to Layer 1 form.
    """
    reads: dict[str, int] = {}
    writes: dict[str, int] = {}
    searches: list = []
    hook_write_paths: set = set()  # Track which paths were written by hook

    # Build oracle once, pass to handlers for respelling
    try:
        oracle = GitPathOracle(repo_root)
    except Exception:
        oracle = None

    # Try to read and parse the JSONL file
    try:
        if not os.path.exists(jsonl_path):
            if oracle is None:
                oracle = GitPathOracle.__new__(GitPathOracle)
                oracle.oracle_status = "degraded"
            return _build_empty_response(oracle.oracle_status)

        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                op = record.get("op")
                if op == "read":
                    _handle_read_record(record, repo_root, reads, oracle)
                elif op == "write":
                    _handle_write_record(record, repo_root, writes, hook_write_paths, oracle)
                elif op == "search":
                    _handle_search_record(record, searches)
    except Exception:
        # File read failure — return degraded response
        if oracle is None:
            oracle = GitPathOracle.__new__(GitPathOracle)
            oracle.oracle_status = "degraded"
        return _build_empty_response(oracle.oracle_status)

    # Ensure we have an oracle for final metrics
    if oracle is None:
        try:
            oracle = GitPathOracle(repo_root)
        except Exception:
            oracle = GitPathOracle.__new__(GitPathOracle)
            oracle.oracle_status = "degraded"

    oracle_status = oracle.oracle_status

    # Compute totals
    totals = {
        "distinct_read": len(reads),
        "total_read": sum(reads.values()),
        "distinct_write": len(writes),
        "total_write": sum(writes.values()),
        "grep": sum(1 for s in searches if s["tool"] == "Grep"),
        "glob": sum(1 for s in searches if s["tool"] == "Glob"),
        "zero_result": sum(1 for s in searches if s.get("result_count", 0) == 0),
        "root_scoped": sum(1 for s in searches if s.get("scope", "") in (".", "")),
    }

    # Compute leakage_pct (union of hook writes vs final git status source set)
    leakage_pct = 0.0
    if oracle_status == "ok":
        hook_write_union = hook_write_paths
        git_write_set = set(oracle.writes.keys())
        symmetric_diff = (hook_write_union - git_write_set) | (git_write_set - hook_write_union)
        total_writes = len(hook_write_union | git_write_set)
        if total_writes > 0:
            leakage_pct = round(100.0 * len(symmetric_diff) / total_writes, 2)

    return {
        "reads": reads,
        "writes": writes,
        "searches": searches,
        "totals": totals,
        "capture": {
            "hook_writes": len(hook_write_paths),
            "git_writes": len(oracle.writes) if oracle_status == "ok" else 0,
            "leakage_pct": leakage_pct,
            "oracle": oracle_status,
        },
    }


def _handle_read_record(
    record: dict, repo_root: str, reads: dict[str, int], oracle: Optional["GitPathOracle"] = None
) -> None:
    """Process a read record and add to reads dict.

    Canonicalizes the path and respells via oracle (Layer 2) if available.
    Falls back to canonical form if oracle fails or is unavailable.
    """
    raw_path = record.get("path", "")
    if not raw_path:
        return

    canonical = canonicalize(raw_path, repo_root)
    if canonical is None:
        return

    # Try to respell via oracle (Layer 2), fall back to canonical form
    final_path = canonical
    if oracle and oracle.oracle_status == "ok":
        try:
            respelled = oracle.respell_read(canonical)
            if respelled and respelled.get("path") is not None:
                final_path = respelled.get("path")
        except Exception:
            # Oracle failure — use canonical form
            pass

    reads[final_path] = reads.get(final_path, 0) + 1


def _handle_write_record(
    record: dict, repo_root: str, writes: dict[str, int], hook_write_paths: set, oracle: Optional["GitPathOracle"] = None
) -> None:
    """Process a write record and add to writes dict.

    Canonicalizes the path and respells via oracle (Layer 2) if available.
    If oracle says the path is gitignored, drops it. Falls back to canonical
    form if oracle fails or is unavailable.
    """
    raw_path = record.get("path", "")
    if not raw_path:
        return

    canonical = canonicalize(raw_path, repo_root)
    if canonical is None:
        return

    # Track for leakage_pct calculation
    hook_write_paths.add(canonical)

    # Try to respell via oracle, fall back to canonical form
    final_path = canonical
    if oracle and oracle.oracle_status == "ok":
        try:
            respelled = oracle.respell_write(canonical)
            respelled_path = respelled.get("path")
            if respelled_path is None:
                # Gitignored — drop from writes
                return
            final_path = respelled_path
        except Exception:
            # Oracle failure — use canonical form
            pass

    writes[final_path] = writes.get(final_path, 0) + 1


def _handle_search_record(record: dict, searches: list) -> None:
    """Process a search record and add to searches list."""
    record.get("op")
    tool = record.get("tool")
    pattern = record.get("pattern", "")
    scope = record.get("scope", "")

    # Normalize scope: empty or "." means root
    if not scope or scope == ".":
        scope = "."

    search_entry = {
        "tool": tool,
        "pattern": pattern[:200] if pattern else "",  # Truncate to ~200 chars
        "scope": scope,
        "result_count": record.get("result_count", 0),
    }

    # Add filter if present (for Grep)
    if "filter" in record:
        search_entry["filter"] = record["filter"]

    searches.append(search_entry)


def _build_empty_response(oracle_status: str = "degraded") -> dict:
    """Build an empty file_access response on failure."""
    return {
        "reads": {},
        "writes": {},
        "searches": [],
        "totals": {
            "distinct_read": 0,
            "total_read": 0,
            "distinct_write": 0,
            "total_write": 0,
            "grep": 0,
            "glob": 0,
            "zero_result": 0,
            "root_scoped": 0,
        },
        "capture": {
            "hook_writes": 0,
            "git_writes": 0,
            "leakage_pct": 0.0,
            "oracle": oracle_status,
        },
    }
