"""Project resolution by `.rembric` walk, scoped default and repository fingerprint.

Fixtures are real git repositories built once under a scratch directory
outside the worktree; the resolve endpoint and the session API are a stub
HTTP server, so every request the provider makes is observed on the wire.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from unittest.mock import patch

from _loader import fresh_plugin

_GIT_ENV = {
    "GIT_AUTHOR_NAME": "Fixture",
    "GIT_AUTHOR_EMAIL": "fixture@example.com",
    "GIT_COMMITTER_NAME": "Fixture",
    "GIT_COMMITTER_EMAIL": "fixture@example.com",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
}

SCRATCH: Path
FIX: dict[str, Path] = {}
SHA: dict[str, str] = {}


def tearDownModule() -> None:
    shutil.rmtree(SCRATCH, ignore_errors=True)


def _clean_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(_GIT_ENV)
    return env


def git(cwd: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", *args], cwd=cwd, env=_clean_env(), check=True, capture_output=True, text=True
    )
    return done.stdout.strip()


def _repo(path: Path, *commits: str) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    for name in commits:
        (path / f"{name}.txt").write_text(name)
        git(path, "add", "-A")
        git(path, "commit", "-q", "-m", name)
    return path


def setUpModule() -> None:
    global SCRATCH
    SCRATCH = Path(tempfile.mkdtemp(prefix="rembric-hermes-resolve-"))
    lib = _repo(SCRATCH / "lib", "l1")
    SHA["lib_root"] = git(lib, "rev-parse", "HEAD")

    two = _repo(SCRATCH / "two-root", "a1")
    SHA["own_root"] = git(two, "rev-parse", "HEAD")
    git(two, "fetch", "-q", str(lib), "main")
    git(two, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "FETCH_HEAD")
    (two / "a2.txt").write_text("a2")
    git(two, "add", "-A")
    git(two, "commit", "-q", "-m", "a2")
    git(two, "checkout", "-q", "-b", "feature")
    (two / "f.txt").write_text("f")
    git(two, "add", "-A")
    git(two, "commit", "-q", "-m", "f")
    git(two, "checkout", "-q", "main")
    (two / "src" / "deep").mkdir(parents=True)
    FIX["two_root"] = two
    FIX["feature_wt"] = SCRATCH / "feature-wt"
    git(two, "worktree", "add", "-q", str(FIX["feature_wt"]), "feature")

    orphan = _repo(SCRATCH / "orphan", "m1")
    SHA["orphan_main"] = git(orphan, "rev-parse", "HEAD")
    git(orphan, "checkout", "-q", "--orphan", "other")
    (orphan / "o.txt").write_text("o")
    git(orphan, "add", "-A")
    git(orphan, "commit", "-q", "-m", "o1")
    SHA["orphan_root"] = git(orphan, "rev-parse", "HEAD")
    FIX["orphan"] = orphan

    FIX["shallow"] = SCRATCH / "shallow"
    subprocess.run(
        ["git", "clone", "-q", "--depth", "1", f"file://{two}", str(FIX["shallow"])],
        env=_clean_env(), check=True, capture_output=True,
    )
    FIX["empty"] = SCRATCH / "empty"
    FIX["empty"].mkdir()
    git(FIX["empty"], "init", "-q")
    FIX["plain"] = SCRATCH / "plain"
    FIX["plain"].mkdir()

    for name in ("bound", "explicit_root", "mono", "creds"):
        FIX[name] = _repo(SCRATCH / name, "c1")
        SHA[name] = git(FIX[name], "rev-parse", "HEAD")
    (FIX["explicit_root"] / ".rembric").write_text("PROJECT_SLUG=sandbox\n")
    (FIX["explicit_root"] / "src").mkdir()
    (FIX["mono"] / ".rembric").write_text("PROJECT_SLUG=mono\n")
    (FIX["mono"] / "packages" / "api" / "src").mkdir(parents=True)
    (FIX["mono"] / "packages" / "web").mkdir(parents=True)
    (FIX["mono"] / "packages" / "api" / ".rembric").write_text("PROJECT_SLUG=api\n")
    git(FIX["creds"], "remote", "add", "origin", "https://user:secret@git.example.com/Acme/Shop.git")
    git(FIX["creds"], "remote", "add", "upstream", "git@github.com:Acme/Shop.git")

    outer = SCRATCH / "outer"
    outer.mkdir()
    (outer / ".rembric").write_text("PROJECT_SLUG=other\n")
    FIX["under_outer"] = _repo(outer / "shop", "s1")
    SHA["under_outer"] = git(FIX["under_outer"], "rev-parse", "HEAD")
    (FIX["under_outer"] / "src").mkdir()

    plain_marked = SCRATCH / "plain-marked"
    plain_marked.mkdir()
    (plain_marked / ".rembric").write_text("PROJECT_SLUG=gamma\n")
    FIX["plain_marked"] = plain_marked
    FIX["home"] = SCRATCH / "home"
    FIX["home"].mkdir()


class _Stub:
    """Records every request; `answer(path, body)` returns (status, payload, delay)."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.answer: Callable[[str, Any], tuple[int, Any, float]] = lambda p, b: (200, {"ok": True}, 0)
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                body = json.loads(raw) if raw else None
                stub.requests.append(
                    {"path": self.path, "headers": dict(self.headers), "body": body, "raw": raw}
                )
                status, payload, delay = stub.answer(self.path, body)
                if delay:
                    time.sleep(delay)
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

            def log_message(self, *_a: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def paths(self) -> list[str]:
        return [r["path"] for r in self.requests]

    def resolve_bodies(self) -> list[Any]:
        return [r["body"] for r in self.requests if r["path"] == "/api/repositories/resolve"]


def _resolver(resolve: tuple[int, Any, float]) -> Callable[[str, Any], tuple[int, Any, float]]:
    def answer(path: str, _body: Any) -> tuple[int, Any, float]:
        if path == "/api/repositories/resolve":
            return resolve
        return 200, {"ok": True, "created": True}, 0

    return answer


BOUND_SHOP = (200, {"ok": True, "outcome": "bound", "slug": "shop"}, 0)
UNBOUND = (200, {"ok": True, "outcome": "unbound", "reason": "not_bound"}, 0)
NO_FINGERPRINT = (200, {"ok": True, "outcome": "unbound", "reason": "no_fingerprint"}, 0)
NOT_FOUND = (404, {"ok": False, "code": "not_found"}, 0)


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        env_patch = patch.dict(os.environ)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        for key in [k for k in os.environ if k.startswith("GIT_")]:
            del os.environ[key]
        os.environ.update(_GIT_ENV)
        self.stub = _Stub()
        self.addCleanup(self.stub.stop)
        self.stderr = io.StringIO()

    def plugin(self, profile_slug: str | None = None) -> Any:
        env = {"REMBRIC_SERVER_URL": self.stub.url, "REMBRIC_API_TOKEN": "tok-XXXX"}
        if profile_slug:
            env["REMBRIC_PROJECT_SLUG"] = profile_slug
        mod = fresh_plugin(env=env, home=str(FIX["home"]))
        os.environ.update(_GIT_ENV)
        return mod

    def start(self, cwd: Path, resolve: tuple[int, Any, float] = BOUND_SHOP,
              profile_slug: str | None = None, session: str = "S1") -> Any:
        self.stub.answer = _resolver(resolve)
        self.mod = self.plugin(profile_slug)
        provider = self.mod.RembricMemoryProvider()
        with contextlib.redirect_stderr(self.stderr):
            provider.initialize(session, cwd=str(cwd))
        return provider

    def session_paths(self, slug: str, session: str = "S1") -> list[str]:
        return [f"/api/{slug}/sessions", f"/api/{slug}/sessions/{session}/resume"]

    def run_full_lifecycle(self, provider: Any) -> None:
        with contextlib.redirect_stderr(self.stderr):
            provider.queue_prefetch("what did we do")
            provider.sync_turn("q", "a", messages=[{"role": "user", "content": "q"}])
            if provider._sync_lock.acquire(timeout=5.0):
                provider._sync_lock.release()
            provider.on_pre_compress([{"role": "user", "content": "q"}])
            provider.on_session_switch("S2")
            provider.on_session_end([{"role": "assistant", "content": "a"}])


class FingerprintTest(_Base):
    def fingerprint(self, cwd: Path) -> tuple[str | None, str | None]:
        return self.plugin()._repository_fingerprint(str(cwd))

    def test_two_root_repository_fingerprints_by_its_own_history_from_main_and_a_feature_branch(self) -> None:
        self.assertEqual(
            sorted(git(FIX["two_root"], "rev-list", "--max-parents=0", "HEAD").split()),
            sorted([SHA["own_root"], SHA["lib_root"]]),
        )
        self.assertEqual(self.fingerprint(FIX["two_root"]), (SHA["own_root"], None))
        self.assertEqual(self.fingerprint(FIX["feature_wt"]), (SHA["own_root"], None))

    def test_orphan_branch_is_its_own_identity(self) -> None:
        self.assertEqual(self.fingerprint(FIX["orphan"]), (SHA["orphan_root"], None))
        self.assertNotEqual(SHA["orphan_root"], SHA["orphan_main"])

    def test_shallow_clone_has_no_fingerprint_although_root_lookup_returns_the_boundary(self) -> None:
        boundary = git(FIX["shallow"], "rev-list", "--first-parent", "--max-parents=0", "HEAD")
        self.assertTrue(boundary)
        self.assertNotEqual(boundary, SHA["own_root"])
        self.assertEqual(self.fingerprint(FIX["shallow"]), (None, "shallow"))

    def test_repository_without_commits_has_no_fingerprint(self) -> None:
        self.assertEqual(self.fingerprint(FIX["empty"]), (None, "no_commit"))

    def test_linked_worktree_shares_the_fingerprint(self) -> None:
        self.assertEqual(self.fingerprint(FIX["feature_wt"]), self.fingerprint(FIX["two_root"]))

    def test_inherited_git_dir_does_not_redirect_the_fingerprint(self) -> None:
        other = FIX["orphan"]
        with patch.dict(os.environ, {"GIT_DIR": str(other / ".git"), "GIT_WORK_TREE": str(other)}):
            self.assertEqual(self.fingerprint(FIX["two_root"]), (SHA["own_root"], None))


class RemoteNormalizationTest(_Base):
    def test_equivalent_remotes_normalize_to_one_form(self) -> None:
        mod = self.plugin()
        for url in (
            "git@github.com:Acme/Shop.git",
            "https://github.com/acme/shop/",
            "ssh://git@github.com:22/acme/shop.git",
            "https://github.com/acme/shop.git?ref=x",
        ):
            with self.subTest(url=url):
                self.assertEqual(mod._normalize_remote(url), "github.com/acme/shop")

    def test_credentials_are_stripped(self) -> None:
        mod = self.plugin()
        self.assertEqual(
            mod._normalize_remote("https://user:secret@git.example.com/acme/shop.git"),
            "git.example.com/acme/shop",
        )
        self.assertEqual(
            mod._normalize_remote("https://user:se/cr@et@git.example.com/acme/shop"),
            "git.example.com/acme/shop",
        )

    def test_nested_groups_are_kept(self) -> None:
        self.assertEqual(
            self.plugin()._normalize_remote("git@gitlab.com:Group/Sub/Repo.git"),
            "gitlab.com/group/sub/repo",
        )

    def test_local_path_remotes_are_not_sent(self) -> None:
        mod = self.plugin()
        for url in ("/srv/git/shop.git", "../shop", "file:///home/u/shop.git", "C:/repos/shop"):
            with self.subTest(url=url):
                self.assertIsNone(mod._normalize_remote(url))


class ResolutionCascadeTest(_Base):
    def test_bound_fingerprint_resolves_when_no_slug_source_is_set(self) -> None:
        provider = self.start(FIX["two_root"], BOUND_SHOP)
        self.assertEqual(provider._slug, "shop")
        self.assertEqual(
            self.stub.paths(), ["/api/repositories/resolve", *self.session_paths("shop")]
        )
        self.assertEqual(
            self.stub.resolve_bodies(),
            [{"fingerprint": SHA["own_root"], "remotes": [], "rootName": "two-root"}],
        )
        resolve = self.stub.requests[0]
        self.assertEqual(resolve["headers"]["Authorization"], "Bearer tok-XXXX")
        self.assertNotIn(str(SCRATCH), resolve["raw"].decode())

    def test_dotrembric_at_checkout_root_applies_to_a_subdirectory(self) -> None:
        provider = self.start(FIX["explicit_root"] / "src", BOUND_SHOP)
        self.assertEqual(provider._slug, "sandbox")
        self.assertEqual(self.stub.paths()[1:], self.session_paths("sandbox"))

    def test_nearest_nested_dotrembric_wins_and_reports_its_source(self) -> None:
        provider = self.start(FIX["mono"] / "packages" / "api" / "src", BOUND_SHOP)
        self.assertEqual(provider._slug, "api")
        self.assertEqual(
            self.stub.resolve_bodies()[0]["explicit"], {"slug": "api", "source": "rembric-nested"}
        )

    def test_root_dotrembric_reports_root_source_from_a_sibling_package(self) -> None:
        provider = self.start(FIX["mono"] / "packages" / "web", BOUND_SHOP)
        self.assertEqual(provider._slug, "mono")
        self.assertEqual(
            self.stub.resolve_bodies()[0]["explicit"], {"slug": "mono", "source": "rembric-root"}
        )

    def test_walk_stops_at_the_checkout_root(self) -> None:
        provider = self.start(FIX["under_outer"] / "src", BOUND_SHOP)
        self.assertEqual(provider._slug, "shop")
        self.assertEqual(
            self.stub.resolve_bodies(),
            [{"fingerprint": SHA["under_outer"], "remotes": [], "rootName": "shop"}],
        )

    def test_walk_stops_at_the_checkout_root_and_falls_to_scoped_default(self) -> None:
        provider = self.start(FIX["under_outer"] / "src", BOUND_SHOP, profile_slug="alpha")
        self.assertEqual(provider._slug, "alpha")
        self.assertEqual(
            self.stub.resolve_bodies()[0]["explicit"], {"slug": "alpha", "source": "env"}
        )

    def test_linked_worktree_without_dotrembric_resolves_by_fingerprint(self) -> None:
        (FIX["two_root"] / ".rembric").write_text("PROJECT_SLUG=local-only\n")
        self.addCleanup((FIX["two_root"] / ".rembric").unlink)
        provider = self.start(FIX["feature_wt"], BOUND_SHOP)
        self.assertEqual(provider._slug, "shop")
        self.assertEqual(self.stub.resolve_bodies()[0]["fingerprint"], SHA["own_root"])

    def test_remotes_are_normalized_and_credentials_never_sent(self) -> None:
        self.start(FIX["creds"], BOUND_SHOP)
        self.assertEqual(
            self.stub.resolve_bodies(),
            [{"fingerprint": SHA["creds"],
              "remotes": ["git.example.com/acme/shop", "github.com/acme/shop"]}],
        )
        for request in self.stub.requests:
            self.assertNotIn(b"secret", request["raw"])
            self.assertNotIn("secret", json.dumps(request["headers"]))
        self.assertNotIn("secret", self.stderr.getvalue())

    def test_explicit_selection_wins_and_conflict_is_reported(self) -> None:
        conflict = (200, {"ok": True, "outcome": "explicit", "slug": "sandbox",
                          "conflict": {"boundSlugs": ["shop"]}}, 0)
        provider = self.start(FIX["explicit_root"], conflict)
        self.assertEqual(provider._slug, "sandbox")
        self.assertEqual(
            self.stub.resolve_bodies(),
            [{"fingerprint": SHA["explicit_root"], "remotes": [], "rootName": "explicit_root",
              "explicit": {"slug": "sandbox", "source": "rembric-root"}}],
        )
        self.assertEqual(self.stub.paths()[1:], self.session_paths("sandbox"))
        notice = provider.prefetch("q")
        for word in ("shop", "sandbox", ".rembric"):
            self.assertIn(word, notice)

    def test_explicit_selection_without_conflict_adds_no_notice(self) -> None:
        echo = (200, {"ok": True, "outcome": "explicit", "slug": "sandbox", "conflict": None}, 0)
        provider = self.start(FIX["explicit_root"], echo)
        self.assertEqual(provider._slug, "sandbox")
        self.assertNotIn("bound", provider.prefetch("q"))

    def test_explicit_selection_survives_a_server_without_the_endpoint(self) -> None:
        provider = self.start(FIX["explicit_root"], NOT_FOUND)
        self.assertEqual(provider._slug, "sandbox")
        self.assertEqual(self.stub.paths()[1:], self.session_paths("sandbox"))

    def test_scoped_default_is_an_explicit_selection_inside_git(self) -> None:
        provider = self.start(FIX["two_root"], BOUND_SHOP, profile_slug="alpha")
        self.assertEqual(provider._slug, "alpha")
        self.assertEqual(
            self.stub.resolve_bodies()[0]["explicit"], {"slug": "alpha", "source": "env"}
        )
        self.assertEqual(self.stub.paths()[1:], self.session_paths("alpha"))

    def test_explicit_selection_without_fingerprint_skips_the_resolve_call(self) -> None:
        (FIX["empty"] / ".rembric").write_text("PROJECT_SLUG=gamma\n")
        self.addCleanup((FIX["empty"] / ".rembric").unlink)
        provider = self.start(FIX["empty"], BOUND_SHOP)
        self.assertEqual(provider._slug, "gamma")
        self.assertEqual(self.stub.paths(), self.session_paths("gamma"))


class NoProjectInsideGitTest(_Base):
    def assert_no_session(self, provider: Any) -> None:
        self.assertIsNone(provider._slug)
        before = list(self.stub.paths())
        self.run_full_lifecycle(provider)
        self.assertEqual(self.stub.paths(), before)
        self.assertFalse(any(p.startswith("/api/") and "/sessions" in p for p in before))

    def test_unbound_fingerprint_skips_session_posts_and_explains(self) -> None:
        provider = self.start(FIX["two_root"], UNBOUND)
        self.assertEqual(self.stub.paths(), ["/api/repositories/resolve"])
        self.assert_no_session(provider)
        fp12 = SHA["own_root"][:12]
        self.assertIn("unbound", self.stderr.getvalue())
        self.assertIn(fp12, self.stderr.getvalue())
        notice = self.start(FIX["two_root"], UNBOUND).prefetch("q")
        self.assertIn("not bound", notice)
        self.assertIn(fp12, notice)
        self.assertIn("default project", notice)
        self.assertIn("next session", notice)
        self.assertIn("dashboard", notice)
        self.assertIn(".rembric", notice)
        self.assertNotIn("project.bind_repository", notice)
        self.assertNotIn(SHA["own_root"], notice)

    def test_unknown_remote_is_unbound(self) -> None:
        provider = self.start(
            FIX["creds"], (200, {"ok": True, "outcome": "unbound", "reason": "unknown_remote"}, 0)
        )
        self.assert_no_session(provider)

    def test_shallow_clone_sends_no_fingerprint_and_names_the_cause(self) -> None:
        provider = self.start(FIX["shallow"], NO_FINGERPRINT)
        body = self.stub.resolve_bodies()[0]
        self.assertEqual(body, {"fingerprint": None, "remotes": []})
        boundary = git(FIX["shallow"], "rev-parse", "HEAD")
        self.assertNotIn(boundary.encode(), self.stub.requests[0]["raw"])
        self.assert_no_session(provider)
        notice = self.start(FIX["shallow"], NO_FINGERPRINT).prefetch("q")
        self.assertIn("shallow clone", notice)
        self.assertIn("full clone", notice)

    def test_repository_without_commits_sends_null_fingerprint(self) -> None:
        provider = self.start(FIX["empty"], NO_FINGERPRINT)
        self.assertEqual(self.stub.resolve_bodies(), [{"fingerprint": None, "remotes": []}])
        self.assert_no_session(provider)
        self.assertIn("first commit", self.start(FIX["empty"], NO_FINGERPRINT).prefetch("q"))

    def test_ambiguous_binding_resolves_no_project(self) -> None:
        ambiguous = (409, {"ok": False, "code": "repository_ambiguous", "slugs": ["sandbox", "shop"]}, 0)
        provider = self.start(FIX["two_root"], ambiguous)
        self.assert_no_session(provider)
        self.assertIn("ambiguous", self.stderr.getvalue())
        notice = self.start(FIX["two_root"], ambiguous).prefetch("q")
        self.assertIn("sandbox", notice)
        self.assertIn("shop", notice)

    def test_server_without_the_endpoint_never_falls_back_to_the_default_project(self) -> None:
        provider = self.start(FIX["two_root"], NOT_FOUND)
        self.assert_no_session(provider)
        err = self.stderr.getvalue()
        self.assertIn("HTTP 404", err)
        self.assertIn("update the Rembric server", err)
        self.assertIn(".rembric", err)

    def test_timeout_is_not_treated_as_unbound(self) -> None:
        self.stub.answer = _resolver((200, {"ok": True, "outcome": "unbound", "reason": "not_bound"}, 1.5))
        self.mod = self.plugin()
        self.mod._RESOLVE_TIMEOUT_SEC = 0.3
        provider = self.mod.RembricMemoryProvider()
        with contextlib.redirect_stderr(self.stderr):
            provider.initialize("S1", cwd=str(FIX["two_root"]))
        self.assert_no_session(provider)
        self.assertIn("timeout", self.stderr.getvalue())
        self.assertNotIn("not bound", provider.prefetch("q"))

    def test_malformed_success_body_is_not_treated_as_unbound(self) -> None:
        for payload in (
            b"not json",
            {"ok": True, "outcome": "bound", "slug": "Bad_Slug"},
            {"outcome": "unbound", "reason": "not_bound"},
            {"ok": True, "outcome": "unbound"},
        ):
            with self.subTest(payload=payload):
                provider = self.start(FIX["two_root"], (200, payload, 0))
                self.assert_no_session(provider)
                self.assertNotIn("not bound", provider.prefetch("q"))


class OncePerSessionTest(_Base):
    def test_outcome_is_fixed_for_the_session(self) -> None:
        provider = self.start(FIX["two_root"], BOUND_SHOP)
        self.stub.answer = _resolver((200, {"ok": True, "outcome": "bound", "slug": "store"}, 0))
        self.run_full_lifecycle(provider)
        self.assertEqual(self.stub.paths().count("/api/repositories/resolve"), 1)
        self.assertEqual(provider._slug, "shop")
        self.assertFalse(any(p.startswith("/api/store/") for p in self.stub.paths()))
        self.assertIn("/api/shop/sessions/S2/resume", self.stub.paths())


class OutsideGitRegressionTest(_Base):
    def test_dotrembric_in_cwd_still_wins_outside_git(self) -> None:
        provider = self.start(FIX["plain_marked"], BOUND_SHOP, profile_slug="alpha")
        self.assertEqual(provider._slug, "gamma")
        self.assertEqual(self.stub.paths(), self.session_paths("gamma"))

    def test_scoped_default_still_applies_outside_git(self) -> None:
        provider = self.start(FIX["plain"], BOUND_SHOP, profile_slug="alpha")
        self.assertEqual(provider._slug, "alpha")
        self.assertEqual(self.stub.paths(), self.session_paths("alpha"))

    def test_no_source_outside_git_makes_no_request(self) -> None:
        provider = self.start(FIX["plain"], BOUND_SHOP)
        self.assertIsNone(provider._slug)
        self.run_full_lifecycle(provider)
        self.assertEqual(self.stub.paths(), [])
        self.assertIn("no project slug", self.stderr.getvalue())
        self.assertNotIn("not bound", provider.prefetch("q"))

    def test_parent_dotrembric_is_not_read_outside_git(self) -> None:
        child = FIX["plain_marked"] / "child"
        child.mkdir(exist_ok=True)
        provider = self.start(child, BOUND_SHOP)
        self.assertIsNone(provider._slug)
        self.assertEqual(self.stub.paths(), [])

    def test_dotrembric_in_cwd_still_wins_inside_git(self) -> None:
        provider = self.start(FIX["explicit_root"], NOT_FOUND, profile_slug="alpha")
        self.assertEqual(provider._slug, "sandbox")


if __name__ == "__main__":
    unittest.main()
