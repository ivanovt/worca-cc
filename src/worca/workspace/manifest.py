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


class WorkspaceLegacySchemaError(Exception):
    """Raised when workspace.json uses the pre-rename `repos` key.

    Points the user at `worca workspace migrate <path>` so they can convert
    in place — we made a hard cut from `repos` to `projects` rather than
    accepting both keys (see plan PR 3, "naming sweep").
    """


@dataclass
class IntegrationTest:
    command: str
    working_dir: str


@dataclass
class ProjectEntry:
    name: str
    path: str
    depends_on: list[str]


@dataclass
class Workspace:
    name: str
    projects: list[ProjectEntry]
    tiers: list[list[str]]
    integration_test: IntegrationTest | None = None
    umbrella_repo: str | None = None

    @classmethod
    def load(cls, workspace_root: str) -> Workspace:
        manifest_path = os.path.join(workspace_root, "workspace.json")
        with open(manifest_path, encoding="utf-8") as f:
            doc = json.load(f)

        if "repos" in doc and "projects" not in doc:
            raise WorkspaceLegacySchemaError(
                f"{manifest_path} uses the legacy `repos` key. Run "
                f"`worca workspace migrate {workspace_root}` to convert "
                f"the file to the current `projects` schema."
            )

        with open(_SCHEMA_PATH, encoding="utf-8") as f:
            schema = json.load(f)
        jsonschema.validate(doc, schema)

        projects = [
            ProjectEntry(
                name=p["name"],
                path=p["path"],
                depends_on=p["depends_on"],
            )
            for p in doc["projects"]
        ]

        _validate_deps(projects)
        tiers = _compute_tiers(projects)

        it = doc.get("integration_test")
        integration_test = (
            IntegrationTest(command=it["command"], working_dir=it["working_dir"])
            if it
            else None
        )

        return cls(
            name=doc["name"],
            projects=projects,
            tiers=tiers,
            integration_test=integration_test,
            umbrella_repo=doc.get("umbrella_repo"),
        )


def _validate_deps(projects: list[ProjectEntry]) -> None:
    names = [p.name for p in projects]
    seen: set[str] = set()
    for name in names:
        if name in seen:
            raise WorkspaceDependencyError(f"duplicate project name: {name}")
        seen.add(name)

    name_set = set(names)
    for project in projects:
        for dep in project.depends_on:
            if dep not in name_set:
                raise WorkspaceDependencyError(
                    f"project '{project.name}' depends on '{dep}' which is not defined"
                )


def _compute_tiers(projects: list[ProjectEntry]) -> list[list[str]]:
    """Kahn's algorithm — BFS topological sort grouped into tiers. Raises on cycles."""
    in_degree: dict[str, int] = {p.name: 0 for p in projects}
    dependents: dict[str, list[str]] = {p.name: [] for p in projects}

    for project in projects:
        for dep in project.depends_on:
            in_degree[project.name] += 1
            dependents[dep].append(project.name)

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

    if processed != len(projects):
        remaining = sorted(name for name, deg in in_degree.items() if deg > 0)
        raise WorkspaceCycleError(
            f"dependency cycle detected among projects: {', '.join(remaining)}"
        )

    return tiers
