"""Workspace dataclass — load workspace.json, validate, detect cycles, compute tiers."""
from __future__ import annotations

import json
import os
from collections import deque
from dataclasses import dataclass

import jsonschema

import worca

_SCHEMA_PATH = os.path.join(os.path.dirname(worca.__file__), "schemas", "workspace.json")


class WorkspaceCycleError(Exception):
    pass


class WorkspaceDependencyError(Exception):
    pass


@dataclass
class IntegrationTest:
    command: str
    working_dir: str


@dataclass
class RepoEntry:
    name: str
    path: str
    role: str
    depends_on: list[str]


@dataclass
class Workspace:
    name: str
    repos: list[RepoEntry]
    tiers: list[list[str]]
    integration_test: IntegrationTest | None = None
    umbrella_repo: str | None = None

    @classmethod
    def load(cls, workspace_root: str) -> Workspace:
        manifest_path = os.path.join(workspace_root, "workspace.json")
        with open(manifest_path) as f:
            doc = json.load(f)

        with open(_SCHEMA_PATH) as f:
            schema = json.load(f)
        jsonschema.validate(doc, schema)

        repos = [
            RepoEntry(
                name=r["name"],
                path=r["path"],
                role=r["role"],
                depends_on=r["depends_on"],
            )
            for r in doc["repos"]
        ]

        _validate_deps(repos)
        tiers = _compute_tiers(repos)

        it = doc.get("integration_test")
        integration_test = (
            IntegrationTest(command=it["command"], working_dir=it["working_dir"])
            if it
            else None
        )

        return cls(
            name=doc["name"],
            repos=repos,
            tiers=tiers,
            integration_test=integration_test,
            umbrella_repo=doc.get("umbrella_repo"),
        )


def _validate_deps(repos: list[RepoEntry]) -> None:
    names = [r.name for r in repos]
    seen: set[str] = set()
    for name in names:
        if name in seen:
            raise WorkspaceDependencyError(f"duplicate repo name: {name}")
        seen.add(name)

    name_set = set(names)
    for repo in repos:
        for dep in repo.depends_on:
            if dep not in name_set:
                raise WorkspaceDependencyError(
                    f"repo '{repo.name}' depends on '{dep}' which is not defined"
                )


def _compute_tiers(repos: list[RepoEntry]) -> list[list[str]]:
    """Kahn's algorithm — BFS topological sort grouped into tiers. Raises on cycles."""
    in_degree: dict[str, int] = {r.name: 0 for r in repos}
    dependents: dict[str, list[str]] = {r.name: [] for r in repos}

    for repo in repos:
        for dep in repo.depends_on:
            in_degree[repo.name] += 1
            dependents[dep].append(repo.name)

    queue: deque[str] = deque(
        sorted(name for name, deg in in_degree.items() if deg == 0)
    )
    tiers: list[list[str]] = []
    processed = 0

    while queue:
        tier = sorted(queue)
        tiers.append(tier)
        processed += len(tier)
        next_queue: deque[str] = deque()
        for name in tier:
            for dep in dependents[name]:
                in_degree[dep] -= 1
                if in_degree[dep] == 0:
                    next_queue.append(dep)
        queue = next_queue

    if processed != len(repos):
        remaining = sorted(name for name, deg in in_degree.items() if deg > 0)
        raise WorkspaceCycleError(
            f"dependency cycle detected among repos: {', '.join(remaining)}"
        )

    return tiers
