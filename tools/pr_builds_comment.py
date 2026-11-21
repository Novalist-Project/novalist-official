#!/usr/bin/env python3
"""Keep one pull request comment listing the installable builds of its head commit."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

MARKER = "<!-- novalist-test-builds -->"
AUTHOR = "github-actions[bot]"
PREVIEWS = ".github/workflows/writing-feasibility.yml"
ANDROID = ".github/workflows/android.yml"


class BuildsError(RuntimeError):
    """The comment cannot be brought up to date."""


class Unavailable(BuildsError):
    """GitHub did not answer; the same request may succeed later."""


@dataclass(frozen=True)
class Build:
    workflow: str
    artifact: str
    label: str


# The artifact patterns follow the upload steps of the two workflows;
# tools/test_pr_builds_comment.py fails when either side is renamed alone.
BUILDS = (
    Build(PREVIEWS, r"novalist-preview-windows-x64-[0-9a-f]{40}-\d+", "Windows x64"),
    Build(
        PREVIEWS,
        r"novalist-preview-macos-arm64-[0-9a-f]{40}-\d+",
        "macOS Apple Silicon",
    ),
    Build(PREVIEWS, r"novalist-preview-macos-x64-[0-9a-f]{40}-\d+", "macOS Intel"),
    Build(PREVIEWS, r"novalist-preview-linux-x64-[0-9a-f]{40}-\d+", "Linux x64"),
    Build(
        ANDROID,
        r"novalist-android-development-android-arm64",
        "Android ARM64 (phones and tablets)",
    ),
    Build(
        ANDROID,
        r"novalist-android-development-android-x64",
        "Android x64 (emulators)",
    ),
)

GUIDES = {
    PREVIEWS: (
        "Desktop builds share their settings with an installed Novalist, so quit"
        " it before starting one.",
        "How to run a desktop test build",
        "docs/branch-preview.md",
    ),
    ANDROID: (
        "Android builds are development APKs for sideloading on Android 13 or newer.",
        "Android development",
        "docs/android-development.md",
    ),
}


@dataclass(frozen=True)
class Target:
    repository: str
    sha: str
    pull_request: int

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", self.repository):
            raise BuildsError("Repository must have the form owner/name.")
        if not re.fullmatch(r"[0-9a-f]{40}", self.sha):
            raise BuildsError("The commit must be a full lowercase SHA.")
        if self.pull_request < 1:
            raise BuildsError("The pull request number must be positive.")


@dataclass(frozen=True)
class Row:
    label: str
    workflow: str
    state: str
    url: str
    size: int = 0
    expires: str = ""


class GitHub:
    """The few GitHub REST calls the comment needs, for one pull request."""

    def __init__(self, target: Target) -> None:
        self.target = target

    def call(
        self,
        path: str,
        *,
        query: dict | None = None,
        method: str = "GET",
        payload: dict | None = None,
    ):
        token = os.environ.get("GH_TOKEN")
        if not token:
            raise BuildsError("GH_TOKEN is required to list test builds.")
        url = f"https://api.github.com/repos/{self.target.repository}/{path}"
        if query:
            url += "?" + urlencode(query)
        request = Request(
            url,
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2026-03-10",
                "User-Agent": "novalist-test-builds",
            },
            method=method,
        )
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            kind = Unavailable if error.code >= 500 or error.code == 429 else BuildsError
            raise kind(f"GitHub answered HTTP {error.code} to {method} {path}.") from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise Unavailable(f"GitHub could not be read for {method} {path}.") from None

    def pages(self, path: str, key: str | None = None, **query) -> list:
        items: list = []
        for page in range(1, 11):
            payload = self.call(path, query={**query, "per_page": 100, "page": page})
            if key:
                batch = payload.get(key) if isinstance(payload, dict) else None
            else:
                batch = payload
            if not isinstance(batch, list):
                raise BuildsError(f"GitHub returned an unexpected answer for {path}.")
            items.extend(batch)
            if len(batch) < 100:
                return items
        raise BuildsError(f"Too many results to read for {path}.")

    def runs(self) -> list:
        return self.pages("actions/runs", "workflow_runs", head_sha=self.target.sha)

    def artifacts(self, run_id: int) -> list:
        return self.pages(f"actions/runs/{run_id}/artifacts", "artifacts")

    def comments(self) -> list:
        return self.pages(f"issues/{self.target.pull_request}/comments")

    def create(self, body: str) -> int:
        created = self.call(
            f"issues/{self.target.pull_request}/comments",
            method="POST",
            payload={"body": body},
        )
        if not isinstance(created, dict) or type(created.get("id")) is not int:
            raise BuildsError("GitHub did not confirm the new comment.")
        return created["id"]

    def update(self, comment_id: int, body: str) -> None:
        self.call(
            f"issues/comments/{comment_id}", method="PATCH", payload={"body": body}
        )


def build_runs(runs: list, target: Target) -> dict[str, list[dict]]:
    """The runs of the build workflows for the commit, grouped by workflow."""
    workflows = {build.workflow for build in BUILDS}
    grouped: dict[str, list[dict]] = {}
    for run in runs:
        if not isinstance(run, dict):
            raise BuildsError("GitHub returned an invalid workflow run.")
        if run.get("head_sha") != target.sha or run.get("path") not in workflows:
            continue
        if type(run.get("id")) is not int or not isinstance(run.get("status"), str):
            raise BuildsError("GitHub returned incomplete workflow run metadata.")
        grouped.setdefault(run["path"], []).append(run)
    return grouped


def newest_artifacts(hub, runs: list[dict]) -> dict[Build, tuple[int, dict]]:
    """For each build, the run and the newest unexpired artifact it left."""
    found: dict[Build, tuple[int, dict]] = {}
    for run in runs:
        for artifact in hub.artifacts(run["id"]):
            if (
                not isinstance(artifact, dict)
                or type(artifact.get("id")) is not int
                or not isinstance(artifact.get("name"), str)
            ):
                raise BuildsError("GitHub returned incomplete artifact metadata.")
            if artifact.get("expired"):
                continue
            for build in BUILDS:
                if build.workflow != run["path"]:
                    continue
                if not re.fullmatch(build.artifact, artifact["name"]):
                    continue
                if build not in found or found[build][1]["id"] < artifact["id"]:
                    found[build] = (run["id"], artifact)
    return found


def survey(hub, target: Target) -> tuple[list[Row], bool]:
    """The table rows for the commit, and whether a build is still running."""
    grouped = build_runs(hub.runs(), target)
    latest = {
        path: max(runs, key=lambda run: run["id"]) for path, runs in grouped.items()
    }
    found = newest_artifacts(hub, [run for runs in grouped.values() for run in runs])
    base = f"https://github.com/{target.repository}/actions/runs"
    rows = []
    for build in BUILDS:
        if build.workflow not in latest:
            continue
        if build in found:
            run_id, artifact = found[build]
            size = artifact.get("size_in_bytes")
            expires = artifact.get("expires_at")
            rows.append(
                Row(
                    build.label,
                    build.workflow,
                    "ready",
                    f"{base}/{run_id}/artifacts/{artifact['id']}",
                    size if type(size) is int else 0,
                    expires if isinstance(expires, str) else "",
                )
            )
            continue
        run = latest[build.workflow]
        state = "missing" if run["status"] == "completed" else "building"
        rows.append(Row(build.label, build.workflow, state, f"{base}/{run['id']}"))
    return rows, any(run["status"] != "completed" for run in latest.values())


def compose(target: Target, rows: list[Row]) -> str:
    lines = [
        MARKER,
        "### Test builds",
        "",
        f"Built from {target.sha}. Downloads need a GitHub sign-in and arrive as a ZIP.",
        "",
        "| Platform | Download | Size | Available until |",
        "| --- | --- | --- | --- |",
    ]
    for row in rows:
        if row.state == "ready":
            megabytes = max(1, round(row.size / 1048576))
            day = row.expires[:10]
            until = day if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day) else ""
            lines.append(
                f"| {row.label} | [Download]({row.url}) | {megabytes} MB | {until} |"
            )
        elif row.state == "building":
            lines.append(f"| {row.label} | Building ([run]({row.url})) | | |")
        else:
            lines.append(f"| {row.label} | Not built ([run]({row.url})) | | |")
    docs = f"https://github.com/{target.repository}/blob/{target.sha}"
    for workflow, (note, title, path) in GUIDES.items():
        if any(row.workflow == workflow for row in rows):
            lines += ["", f"{note} See [{title}]({docs}/{path})."]
    return "\n".join(lines) + "\n"


class Comment:
    """The one comment this tool owns on the pull request."""

    def __init__(self, hub) -> None:
        self.hub = hub
        self.id: int | None = None
        self.body: str | None = None
        self.looked = False

    def find(self) -> None:
        for comment in self.hub.comments():
            if not isinstance(comment, dict):
                raise BuildsError("GitHub returned an invalid comment.")
            user, body = comment.get("user"), comment.get("body")
            if (
                isinstance(user, dict)
                and user.get("login") == AUTHOR
                and isinstance(body, str)
                and body.startswith(MARKER)
                and type(comment.get("id")) is int
            ):
                self.id, self.body = comment["id"], body
                break
        self.looked = True

    def show(self, body: str) -> bool:
        """Publish the body; False when the comment already says exactly this."""
        if not self.looked:
            self.find()
        if body == self.body:
            return False
        if self.id is None:
            self.id = self.hub.create(body)
        else:
            self.hub.update(self.id, body)
        self.body = body
        return True


def keep_current(
    target: Target,
    hub,
    *,
    timeout_seconds: int = 3600,
    settle_seconds: int = 120,
    poll_seconds: int = 30,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    report: Callable[[str], None] = print,
) -> bool:
    """Update the comment as builds finish; True when it lists any build.

    Build workflows start within seconds of this one but are not all there on
    the first look, so nothing is concluded before the settle time has passed.
    """
    if timeout_seconds <= 0 or settle_seconds < 0 or not 1 <= poll_seconds <= 60:
        raise BuildsError(
            "Timeout must be positive, the settle time not negative, and polling"
            " between 1 and 60 seconds."
        )
    start = clock()
    comment = Comment(hub)
    rows: list[Row] = []
    failures = 0
    while True:
        try:
            rows, pending = survey(hub, target)
            if rows and comment.show(compose(target, rows)):
                ready = sum(row.state == "ready" for row in rows)
                report(f"Comment updated: {ready} of {len(rows)} builds available.")
            failures = 0
        except Unavailable as error:
            failures += 1
            if failures > 3:
                raise
            report(f"{error} Trying again.")
            pending = True
        waited = clock() - start
        if not pending and waited >= settle_seconds:
            if not rows:
                report(f"No build workflow ran for {target.sha}; nothing to list.")
            return bool(rows)
        if waited >= timeout_seconds:
            raise BuildsError(f"Timed out waiting for the builds of {target.sha}.")
        sleep(min(poll_seconds, timeout_seconds - waited))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--pull-request", type=int, required=True)
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    parser.add_argument("--settle-seconds", type=int, default=120)
    parser.add_argument("--poll-seconds", type=int, default=30)
    parser.add_argument(
        "--preview", action="store_true", help="Print the comment without posting it"
    )
    args = parser.parse_args(argv)
    try:
        target = Target(args.repository, args.sha, args.pull_request)
        hub = GitHub(target)
        if args.preview:
            rows, _ = survey(hub, target)
            print(compose(target, rows), end="")
            return 0
        keep_current(
            target,
            hub,
            timeout_seconds=args.timeout_seconds,
            settle_seconds=args.settle_seconds,
            poll_seconds=args.poll_seconds,
            report=lambda message: print(message, flush=True),
        )
    except BuildsError as error:
        print(f"test-builds: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
