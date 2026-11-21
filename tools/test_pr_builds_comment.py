"""The builds comment lists what a commit's workflows left, and only that."""

import contextlib
import io
import json
import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse

from tools import pr_builds_comment as builds


ROOT = Path(__file__).resolve().parents[1]
SHA = "a" * 40
TARGET = builds.Target("Novalist-Project/novalist-official", SHA, 80)
RUNS = "https://github.com/Novalist-Project/novalist-official/actions/runs"
PLATFORMS = ("windows-x64", "macos-arm64", "macos-x64", "linux-x64")


def run(run_id, path, status="completed", **changes):
    result = {"id": run_id, "path": path, "status": status, "head_sha": SHA}
    result.update(changes)
    return result


def artifact(artifact_id, name, **changes):
    result = {
        "id": artifact_id,
        "name": name,
        "expired": False,
        "size_in_bytes": 290945002,
        "expires_at": "2026-11-29T16:56:46Z",
    }
    result.update(changes)
    return result


def preview(artifact_id, platform, attempt=1, **changes):
    name = f"novalist-preview-{platform}-{SHA}-{attempt}"
    return artifact(artifact_id, name, **changes)


def android(artifact_id, runtime, **changes):
    name = f"novalist-android-development-android-{runtime}"
    return artifact(artifact_id, name, **changes)


def state(runs, artifacts=None):
    return {"runs": runs, "artifacts": artifacts or {}}


FINISHED = state(
    [run(10, builds.PREVIEWS), run(20, builds.ANDROID)],
    {
        10: [preview(100 + index, name) for index, name in enumerate(PLATFORMS)],
        20: [android(200, "arm64"), android(201, "x64")],
    },
)


class Hub:
    """GitHub as the comment sees it: one state per look at the runs."""

    def __init__(self, timeline, comments=()):
        self.timeline = list(timeline)
        self.listed = list(comments)
        self.looks = 0
        self.comment_reads = 0
        self.created = []
        self.updated = []
        self.current = None

    def runs(self):
        self.current = self.timeline[min(self.looks, len(self.timeline) - 1)]
        self.looks += 1
        if isinstance(self.current, Exception):
            raise self.current
        return self.current["runs"]

    def artifacts(self, run_id):
        return self.current["artifacts"].get(run_id, [])

    def comments(self):
        self.comment_reads += 1
        return self.listed

    def create(self, body):
        self.created.append(body)
        return 900

    def update(self, comment_id, body):
        self.updated.append((comment_id, body))


class Clock:
    def __init__(self):
        self.now = 0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def rows_of(timeline_state):
    return builds.survey(Hub([timeline_state]), TARGET)


class SurveyTests(unittest.TestCase):
    def test_every_build_of_the_commit_is_listed_in_table_order(self):
        rows, pending = rows_of(FINISHED)
        self.assertFalse(pending)
        self.assertEqual(
            [row.label for row in rows], [build.label for build in builds.BUILDS]
        )
        self.assertEqual({row.state for row in rows}, {"ready"})
        self.assertEqual(rows[0].url, f"{RUNS}/10/artifacts/100")
        self.assertEqual(rows[4].url, f"{RUNS}/20/artifacts/200")
        self.assertEqual(rows[0].size, 290945002)
        self.assertEqual(rows[0].expires, "2026-11-29T16:56:46Z")

    def test_a_workflow_that_did_not_run_adds_no_rows(self):
        rows, pending = rows_of(
            state([run(20, builds.ANDROID)], {20: [android(200, "arm64")]})
        )
        self.assertFalse(pending)
        self.assertEqual(
            [(row.label, row.state) for row in rows],
            [
                ("Android ARM64 (phones and tablets)", "ready"),
                ("Android x64 (emulators)", "missing"),
            ],
        )
        self.assertEqual(rows[1].url, f"{RUNS}/20")

    def test_other_commits_and_other_workflows_are_ignored(self):
        rows, pending = rows_of(
            state(
                [
                    run(1, ".github/workflows/ci.yml", status="in_progress"),
                    run(2, builds.PREVIEWS, head_sha="b" * 40, status="queued"),
                ],
                {1: [preview(100, "windows-x64")], 2: [preview(101, "windows-x64")]},
            )
        )
        self.assertEqual((rows, pending), ([], False))

    def test_an_artifact_counts_only_for_the_workflow_that_builds_it(self):
        rows, _ = rows_of(
            state([run(20, builds.ANDROID)], {20: [preview(100, "windows-x64")]})
        )
        self.assertEqual({row.state for row in rows}, {"missing"})
        self.assertEqual({row.workflow for row in rows}, {builds.ANDROID})

    def test_unfinished_builds_are_reported_as_building(self):
        rows, pending = rows_of(
            state(
                [run(10, builds.PREVIEWS, status="in_progress")],
                {10: [preview(100, "windows-x64")]},
            )
        )
        self.assertTrue(pending)
        self.assertEqual(
            [row.state for row in rows], ["ready", "building", "building", "building"]
        )
        self.assertEqual(rows[1].url, f"{RUNS}/10")

    def test_every_status_but_completed_keeps_the_wait_open(self):
        for status in ("queued", "requested", "waiting", "pending", "in_progress"):
            with self.subTest(status=status):
                _, pending = rows_of(state([run(10, builds.PREVIEWS, status=status)]))
                self.assertTrue(pending)

    def test_newest_artifact_wins_across_runs_and_attempts(self):
        rows, pending = rows_of(
            state(
                [run(11, builds.PREVIEWS, status="in_progress"), run(10, builds.PREVIEWS)],
                {
                    10: [
                        preview(100, "windows-x64"),
                        preview(150, "windows-x64", attempt=2),
                        preview(101, "linux-x64"),
                    ],
                    11: [preview(160, "linux-x64")],
                },
            )
        )
        self.assertTrue(pending)
        ready = {row.label: row.url for row in rows if row.state == "ready"}
        self.assertEqual(
            ready,
            {
                "Windows x64": f"{RUNS}/10/artifacts/150",
                "Linux x64": f"{RUNS}/11/artifacts/160",
            },
        )
        waiting = [row for row in rows if row.state == "building"]
        self.assertEqual({row.url for row in waiting}, {f"{RUNS}/11"})

    def test_expired_and_unrelated_artifacts_are_not_offered(self):
        rows, _ = rows_of(
            state(
                [run(10, builds.PREVIEWS)],
                {
                    10: [
                        preview(100, "windows-x64", expired=True),
                        artifact(101, "writing-feasibility-evidence"),
                        artifact(102, f"novalist-preview-linux-x64-{SHA}-1-extra"),
                        artifact(103, "novalist-preview-linux-x64-abc-1"),
                    ]
                },
            )
        )
        self.assertEqual({row.state for row in rows}, {"missing"})

    def test_missing_size_or_expiry_does_not_drop_the_download(self):
        rows, _ = rows_of(
            state(
                [run(20, builds.ANDROID)],
                {20: [android(200, "arm64", size_in_bytes=None, expires_at=None)]},
            )
        )
        self.assertEqual((rows[0].state, rows[0].size, rows[0].expires), ("ready", 0, ""))

    def test_malformed_metadata_is_rejected(self):
        invalid = (
            state([None]),
            state([run(None, builds.PREVIEWS)]),
            state([run(10, builds.PREVIEWS, status=None)]),
            state([run(10, builds.PREVIEWS)], {10: [None]}),
            state([run(10, builds.PREVIEWS)], {10: [artifact(None, "x")]}),
            state([run(10, builds.PREVIEWS)], {10: [artifact(100, None)]}),
        )
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(builds.BuildsError):
                rows_of(payload)


class ComposeTests(unittest.TestCase):
    def body(self, timeline_state=FINISHED):
        rows, _ = rows_of(timeline_state)
        return builds.compose(TARGET, rows)

    def test_comment_links_each_build_with_size_and_expiry(self):
        body = self.body()
        self.assertTrue(body.startswith(builds.MARKER + "\n### Test builds\n"))
        self.assertTrue(body.endswith(".\n"))
        self.assertIn(f"Built from {SHA}.", body)
        self.assertIn(
            f"| Windows x64 | [Download]({RUNS}/10/artifacts/100) | 277 MB | 2026-11-29 |",
            body,
        )
        self.assertIn(
            f"| Android x64 (emulators) | [Download]({RUNS}/20/artifacts/201) |", body
        )
        self.assertEqual(body.count("[Download]("), len(builds.BUILDS))

    def test_guides_link_the_documents_of_the_commit(self):
        body = self.body()
        docs = f"https://github.com/{TARGET.repository}/blob/{SHA}/docs"
        self.assertIn(f"]({docs}/branch-preview.md).", body)
        self.assertIn(f"]({docs}/android-development.md).", body)

    def test_guides_appear_only_for_workflows_that_ran(self):
        body = self.body(state([run(20, builds.ANDROID)], {20: [android(200, "x64")]}))
        self.assertIn("android-development.md", body)
        self.assertNotIn("branch-preview.md", body)
        self.assertNotIn("Windows", body)

    def test_unfinished_and_absent_builds_link_their_run(self):
        building = self.body(state([run(10, builds.PREVIEWS, status="queued")]))
        self.assertIn(f"| Windows x64 | Building ([run]({RUNS}/10)) | | |", building)
        absent = self.body(state([run(10, builds.PREVIEWS)]))
        self.assertIn(f"| Linux x64 | Not built ([run]({RUNS}/10)) | | |", absent)

    def test_tiny_or_unknown_sizes_and_odd_dates_stay_readable(self):
        body = self.body(
            state(
                [run(20, builds.ANDROID)],
                {
                    20: [
                        android(200, "arm64", size_in_bytes=12, expires_at="soon"),
                        android(201, "x64", size_in_bytes=None, expires_at=None),
                    ]
                },
            )
        )
        self.assertEqual(body.count(") | 1 MB |  |"), 2)

    def test_comment_is_plain_text_without_pictographs(self):
        self.assertTrue(self.body().isascii())


class CommentTests(unittest.TestCase):
    def mine(self, body, comment_id=7):
        return {"id": comment_id, "body": body, "user": {"login": builds.AUTHOR}}

    def test_first_run_creates_the_comment_and_repeats_write_nothing(self):
        hub = Hub([FINISHED])
        comment = builds.Comment(hub)
        self.assertTrue(comment.show("one"))
        self.assertFalse(comment.show("one"))
        self.assertTrue(comment.show("two"))
        self.assertEqual(hub.created, ["one"])
        self.assertEqual(hub.updated, [(900, "two")])
        self.assertEqual(hub.comment_reads, 1)

    def test_an_earlier_comment_is_edited_in_place(self):
        hub = Hub([FINISHED], [self.mine("unrelated"), self.mine(builds.MARKER + "old")])
        self.assertTrue(builds.Comment(hub).show(builds.MARKER + "new"))
        self.assertEqual(hub.created, [])
        self.assertEqual(hub.updated, [(7, builds.MARKER + "new")])

    def test_an_identical_earlier_comment_is_left_untouched(self):
        hub = Hub([FINISHED], [self.mine(builds.MARKER + "same")])
        self.assertFalse(builds.Comment(hub).show(builds.MARKER + "same"))
        self.assertEqual((hub.created, hub.updated), ([], []))

    def test_comments_by_anyone_else_are_never_edited(self):
        others = [
            {"id": 1, "body": builds.MARKER, "user": {"login": "someone"}},
            {"id": 2, "body": builds.MARKER, "user": None},
            {"id": 3, "body": None, "user": {"login": builds.AUTHOR}},
            {"id": "4", "body": builds.MARKER, "user": {"login": builds.AUTHOR}},
        ]
        hub = Hub([FINISHED], others)
        self.assertTrue(builds.Comment(hub).show(builds.MARKER + "new"))
        self.assertEqual(hub.created, [builds.MARKER + "new"])
        self.assertEqual(hub.updated, [])

    def test_an_invalid_comment_list_is_rejected(self):
        with self.assertRaises(builds.BuildsError):
            builds.Comment(Hub([FINISHED], [None])).show("body")


class KeepCurrentTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.messages = []

    def keep(self, hub, **options):
        return builds.keep_current(
            TARGET,
            hub,
            clock=self.clock,
            sleep=self.clock.sleep,
            report=self.messages.append,
            **options,
        )

    def test_comment_follows_the_builds_until_all_have_finished(self):
        started = state(
            [
                run(10, builds.PREVIEWS, status="queued"),
                run(20, builds.ANDROID, status="in_progress"),
            ]
        )
        halfway = state(
            [run(10, builds.PREVIEWS, status="in_progress"), run(20, builds.ANDROID)],
            {10: [preview(100, "windows-x64")], 20: FINISHED["artifacts"][20]},
        )
        hub = Hub([started, halfway, FINISHED])
        self.assertTrue(self.keep(hub))
        self.assertEqual(len(hub.created), 1)
        self.assertEqual(hub.created[0].count("Building"), 6)
        self.assertEqual(len(hub.updated), 2)
        self.assertEqual(hub.updated[0][1].count("[Download]("), 3)
        self.assertEqual(hub.updated[1][1].count("[Download]("), 6)
        self.assertEqual(self.clock.sleeps, [30, 30, 30, 30])
        self.assertEqual(
            self.messages,
            [
                "Comment updated: 0 of 6 builds available.",
                "Comment updated: 3 of 6 builds available.",
                "Comment updated: 6 of 6 builds available.",
            ],
        )

    def test_finished_builds_are_listed_at_once_but_late_workflows_get_time(self):
        late = state(
            [run(10, builds.PREVIEWS), run(20, builds.ANDROID, status="queued")],
            FINISHED["artifacts"] | {20: []},
        )
        hub = Hub([state([run(10, builds.PREVIEWS)], FINISHED["artifacts"]), late, FINISHED])
        self.assertTrue(self.keep(hub))
        self.assertNotIn("Android", hub.created[0])
        self.assertEqual(hub.updated[-1][1].count("[Download]("), 6)

    def test_a_commit_without_builds_leaves_the_pull_request_alone(self):
        hub = Hub([state([run(1, ".github/workflows/ci.yml")])])
        self.assertFalse(self.keep(hub))
        self.assertEqual((hub.created, hub.updated, hub.comment_reads), ([], [], 0))
        self.assertEqual(self.clock.sleeps, [30, 30, 30, 30])
        self.assertEqual(self.messages, [f"No build workflow ran for {SHA}; nothing to list."])

    def test_settle_time_can_be_switched_off(self):
        hub = Hub([FINISHED])
        self.assertTrue(self.keep(hub, settle_seconds=0))
        self.assertEqual(self.clock.sleeps, [])

    def test_builds_that_never_finish_time_out_after_listing_what_exists(self):
        hub = Hub([state([run(10, builds.PREVIEWS, status="in_progress")])])
        with self.assertRaisesRegex(builds.BuildsError, "Timed out"):
            self.keep(hub, timeout_seconds=70)
        self.assertEqual(self.clock.sleeps, [30, 30, 10])
        self.assertEqual(len(hub.created), 1)

    def test_brief_outages_are_ridden_out(self):
        outage = builds.Unavailable("GitHub answered HTTP 502 to GET actions/runs.")
        hub = Hub([outage, outage, outage, FINISHED])
        self.assertTrue(self.keep(hub, settle_seconds=0))
        self.assertEqual(self.clock.sleeps, [30, 30, 30])
        self.assertEqual(self.messages[0], f"{outage} Trying again.")
        self.assertEqual(len(hub.created), 1)

    def test_a_lasting_outage_fails_and_counts_only_consecutive_failures(self):
        outage = builds.Unavailable("down")
        waiting = state([run(10, builds.PREVIEWS, status="queued")])
        hub = Hub([outage, outage, outage, waiting, outage, outage, outage, outage])
        with self.assertRaises(builds.Unavailable):
            self.keep(hub)
        self.assertEqual(hub.looks, 8)

    def test_a_refusal_fails_at_once(self):
        hub = Hub([builds.BuildsError("GitHub answered HTTP 403 to GET actions/runs.")])
        with self.assertRaisesRegex(builds.BuildsError, "HTTP 403"):
            self.keep(hub)
        self.assertEqual(self.clock.sleeps, [])

    def test_invalid_timing_options_are_rejected(self):
        for options in (
            {"timeout_seconds": 0},
            {"settle_seconds": -1},
            {"poll_seconds": 0},
            {"poll_seconds": 61},
        ):
            with self.subTest(options=options), self.assertRaises(builds.BuildsError):
                self.keep(Hub([FINISHED]), **options)

    def test_target_requires_repository_full_sha_and_pull_request(self):
        for arguments in (
            ("bad", SHA, 80),
            (TARGET.repository, "abc", 80),
            (TARGET.repository, "A" * 40, 80),
            (TARGET.repository, SHA, 0),
        ):
            with self.subTest(arguments=arguments), self.assertRaises(builds.BuildsError):
                builds.Target(*arguments)


def answers(*payloads):
    return [io.StringIO(json.dumps(payload)) for payload in payloads]


class GitHubTests(unittest.TestCase):
    def setUp(self):
        token = patch.dict(os.environ, {"GH_TOKEN": "fixture-token"})
        token.start()
        self.addCleanup(token.stop)
        self.hub = builds.GitHub(TARGET)

    def test_runs_are_read_for_the_exact_commit(self):
        payload = {"total_count": 1, "workflow_runs": [run(10, builds.PREVIEWS)]}
        with patch.object(builds, "urlopen", side_effect=answers(payload)) as opener:
            self.assertEqual(self.hub.runs(), payload["workflow_runs"])
        request = opener.call_args.args[0]
        parsed = urlparse(request.full_url)
        self.assertEqual(parsed.netloc, "api.github.com")
        self.assertEqual(parsed.path, f"/repos/{TARGET.repository}/actions/runs")
        self.assertEqual(
            parse_qs(parsed.query),
            {"head_sha": [SHA], "per_page": ["100"], "page": ["1"]},
        )
        self.assertEqual(request.get_method(), "GET")
        self.assertIsNone(request.data)
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-token")
        self.assertNotIn("fixture-token", request.full_url)
        self.assertEqual(opener.call_args.kwargs["timeout"], 30)

    def test_artifacts_and_comments_use_their_own_endpoints(self):
        with patch.object(
            builds, "urlopen", side_effect=answers({"artifacts": [{"id": 1}]}, [{"id": 2}])
        ) as opener:
            self.assertEqual(self.hub.artifacts(10), [{"id": 1}])
            self.assertEqual(self.hub.comments(), [{"id": 2}])
        paths = [urlparse(call.args[0].full_url).path for call in opener.call_args_list]
        self.assertEqual(
            paths,
            [
                f"/repos/{TARGET.repository}/actions/runs/10/artifacts",
                f"/repos/{TARGET.repository}/issues/80/comments",
            ],
        )

    def test_full_pages_are_followed_to_the_end(self):
        full = [{"id": index} for index in range(100)]
        with patch.object(
            builds, "urlopen", side_effect=answers(full, [{"id": 100}])
        ) as opener:
            self.assertEqual(len(self.hub.comments()), 101)
        pages = [
            parse_qs(urlparse(call.args[0].full_url).query)["page"]
            for call in opener.call_args_list
        ]
        self.assertEqual(pages, [["1"], ["2"]])

    def test_endless_or_misshapen_answers_are_rejected(self):
        full = [{"id": index} for index in range(100)]
        with patch.object(builds, "urlopen", side_effect=answers(*[full] * 10)):
            with self.assertRaisesRegex(builds.BuildsError, "Too many"):
                self.hub.comments()
        for payload in ({"artifacts": {}}, [], "text", {}):
            with (
                self.subTest(payload=payload),
                patch.object(builds, "urlopen", side_effect=answers(payload)),
                self.assertRaisesRegex(builds.BuildsError, "unexpected answer"),
            ):
                self.hub.artifacts(10)

    def test_comment_is_created_and_edited_through_the_issue_endpoints(self):
        with patch.object(
            builds, "urlopen", side_effect=answers({"id": 55}, {"id": 55})
        ) as opener:
            self.assertEqual(self.hub.create("first"), 55)
            self.hub.update(55, "second")
        created, edited = (call.args[0] for call in opener.call_args_list)
        self.assertEqual(created.get_method(), "POST")
        self.assertEqual(
            urlparse(created.full_url).path,
            f"/repos/{TARGET.repository}/issues/80/comments",
        )
        self.assertEqual(json.loads(created.data), {"body": "first"})
        self.assertEqual(edited.get_method(), "PATCH")
        self.assertEqual(
            urlparse(edited.full_url).path,
            f"/repos/{TARGET.repository}/issues/comments/55",
        )
        self.assertEqual(json.loads(edited.data), {"body": "second"})

    def test_an_unconfirmed_new_comment_is_an_error(self):
        for payload in ({}, [], {"id": "55"}):
            with (
                self.subTest(payload=payload),
                patch.object(builds, "urlopen", side_effect=answers(payload)),
                self.assertRaisesRegex(builds.BuildsError, "did not confirm"),
            ):
                self.hub.create("body")

    def test_outages_can_be_retried_and_refusals_cannot(self):
        retried = (
            HTTPError("url", 502, "fixture-token", {}, None),
            HTTPError("url", 429, "fixture-token", {}, None),
            URLError("fixture-token"),
            TimeoutError("fixture-token"),
        )
        refused = (
            HTTPError("url", 403, "fixture-token", {}, None),
            HTTPError("url", 404, "fixture-token", {}, None),
        )
        for error in retried + refused:
            with (
                self.subTest(error=str(error)),
                patch.object(builds, "urlopen", side_effect=error),
                self.assertRaises(builds.BuildsError) as caught,
            ):
                self.hub.runs()
            self.assertEqual(
                isinstance(caught.exception, builds.Unavailable), error in retried
            )
            self.assertNotIn("fixture-token", str(caught.exception))

    def test_invalid_json_counts_as_an_outage(self):
        with patch.object(builds, "urlopen", return_value=io.StringIO("<html>")):
            with self.assertRaises(builds.Unavailable):
                self.hub.runs()

    def test_missing_token_fails_before_network_access(self):
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(builds, "urlopen") as opener,
            self.assertRaisesRegex(builds.BuildsError, "GH_TOKEN is required"),
        ):
            self.hub.runs()
        opener.assert_not_called()


class CommandLineTests(unittest.TestCase):
    ARGUMENTS = ["--repository", TARGET.repository, "--sha", SHA, "--pull-request", "80"]

    def test_preview_prints_the_comment_and_writes_nothing(self):
        hub = Hub([FINISHED])
        stdout = io.StringIO()
        with (
            patch.object(builds, "GitHub", return_value=hub),
            contextlib.redirect_stdout(stdout),
        ):
            code = builds.main(self.ARGUMENTS + ["--preview"])
        self.assertEqual(code, 0)
        rows, _ = rows_of(FINISHED)
        self.assertEqual(stdout.getvalue(), builds.compose(TARGET, rows))
        self.assertEqual((hub.created, hub.updated, hub.comment_reads), ([], [], 0))

    def test_default_run_waits_with_the_given_timings(self):
        with (
            patch.object(builds, "GitHub") as hub,
            patch.object(builds, "keep_current", return_value=True) as keep,
        ):
            code = builds.main(
                self.ARGUMENTS
                + ["--timeout-seconds", "90", "--settle-seconds", "5", "--poll-seconds", "2"]
            )
        self.assertEqual(code, 0)
        self.assertEqual(keep.call_args.args, (TARGET, hub.return_value))
        options = keep.call_args.kwargs
        self.assertEqual(
            (options["timeout_seconds"], options["settle_seconds"], options["poll_seconds"]),
            (90, 5, 2),
        )
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            options["report"]("progress")
        self.assertEqual(stdout.getvalue(), "progress\n")

    def test_failures_are_reported_with_a_failing_exit_code(self):
        cases = (
            (self.ARGUMENTS, "GH_TOKEN is required"),
            (self.ARGUMENTS[:3] + ["abc", "--pull-request", "80"], "full lowercase SHA"),
        )
        for arguments, message in cases:
            stderr = io.StringIO()
            with (
                self.subTest(message=message),
                patch.dict(os.environ, {}, clear=True),
                contextlib.redirect_stderr(stderr),
            ):
                self.assertEqual(builds.main(arguments + ["--settle-seconds", "0"]), 1)
            self.assertTrue(stderr.getvalue().startswith("test-builds: "))
            self.assertIn(message, stderr.getvalue())


class WorkflowContractTests(unittest.TestCase):
    def workflow(self, path):
        return (ROOT / path).read_text(encoding="utf-8")

    def matching(self, workflow, name):
        return [
            build
            for build in builds.BUILDS
            if build.workflow == workflow and re.fullmatch(build.artifact, name)
        ]

    def test_every_uploaded_build_has_exactly_one_row(self):
        previews = self.workflow(builds.PREVIEWS)
        self.assertIn(
            "name: novalist-preview-${{ matrix.platform }}-${{ github.sha }}"
            "-${{ github.run_attempt }}",
            previews,
        )
        platforms = re.findall(r"(?m)^\s+- platform: (\S+)$", previews)
        self.assertEqual(sorted(platforms), sorted(PLATFORMS))
        phones = self.workflow(builds.ANDROID)
        self.assertIn("name: novalist-android-development-${{ matrix.runtime }}", phones)
        runtimes = re.search(r"(?m)^\s+runtime: \[([^\]]+)\]$", phones)[1].split(", ")
        names = [
            (builds.PREVIEWS, f"novalist-preview-{platform}-{SHA}-3")
            for platform in platforms
        ] + [
            (builds.ANDROID, f"novalist-android-development-{runtime}")
            for runtime in runtimes
        ]
        matched = []
        for workflow, name in names:
            with self.subTest(name=name):
                rows = self.matching(workflow, name)
                self.assertEqual(len(rows), 1)
                matched += rows
        self.assertEqual(set(matched), set(builds.BUILDS))

    def test_each_listed_workflow_has_a_guide_that_exists(self):
        self.assertEqual(set(builds.GUIDES), {build.workflow for build in builds.BUILDS})
        for _, _, path in builds.GUIDES.values():
            with self.subTest(path=path):
                self.assertTrue((ROOT / path).is_file())

    def test_comment_workflow_writes_only_for_this_repository(self):
        workflow = self.workflow(".github/workflows/test-builds.yml")
        self.assertRegex(workflow, r"(?m)^on:\n  pull_request:\n")
        self.assertNotIn("pull_request_target", workflow)
        self.assertRegex(workflow, r"(?m)^permissions:\n  contents: read\n")
        self.assertEqual(workflow.count("pull-requests: write"), 1)
        self.assertIn(
            "if: github.event.pull_request.head.repo.full_name == github.repository",
            workflow,
        )
        self.assertIn("BUILDS_SHA: ${{ github.event.pull_request.head.sha }}", workflow)
        self.assertIn("GH_TOKEN: ${{ github.token }}", workflow)
        self.assertIn("python3 tools/pr_builds_comment.py", workflow)
        self.assertIn("cancel-in-progress: true", workflow)


if __name__ == "__main__":
    unittest.main()
