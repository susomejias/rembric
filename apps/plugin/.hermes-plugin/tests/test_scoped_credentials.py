from __future__ import annotations

import contextvars
import io
import json
import os
import threading
import types
import unittest
from contextlib import contextmanager, redirect_stderr
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError

from _loader import fresh_plugin


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return b'{"created":true,"formatted":"recalled","lines":["notice"]}'


class ScopedCredentialsTest(unittest.TestCase):
    def setUp(self):
        self.mod = fresh_plugin(env={
            "REMBRIC_SERVER_URL": "https://decoy.example",
            "REMBRIC_API_TOKEN": "decoy-token",
            "REMBRIC_PROJECT_SLUG": "decoy",
        })
        self.scope = contextvars.ContextVar("profile")
        self.secret = types.ModuleType("agent.secret_scope")
        self.secret.__dict__["get_secret"] = lambda key: self.scope.get().get(key)
        self.memory = types.ModuleType("agent.memory_provider")
        self.memory.__dict__["spawn_context_thread"] = self.spawn
        self.addCleanup(patch.stopall)
        patch.dict("sys.modules", {
            "agent": types.ModuleType("agent"),
            "agent.secret_scope": self.secret,
            "agent.memory_provider": self.memory,
        }).start()
        self.calls = []
        self.workers = []
        self.worker_scopes = []
        patch.object(self.mod, "_slug_from_dotrembric", return_value=None).start()
        patch.object(self.mod, "urlopen", side_effect=self.request).start()
        self.stderr = io.StringIO()
        redirect = redirect_stderr(self.stderr)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    @contextmanager
    def profile(self, server="https://alpha.example", token=None, slug="shared"):
        token = token or "alpha-token"
        settings: dict[str, str | None] = {"REMBRIC_SERVER_URL": server, "REMBRIC_API_TOKEN": token,
                    "REMBRIC_PROJECT_SLUG": slug}
        handle = self.scope.set(settings)
        try:
            yield settings
        finally:
            self.scope.reset(handle)

    def request(self, req, **kwargs):
        self.calls.append((req.full_url, req.get_header("Authorization"),
                           json.loads(req.data) if req.data else None))
        return Response()

    def spawn(self, target, *, name, daemon=True, args=(), kwargs=None):
        context = contextvars.copy_context()

        def run():
            self.worker_scopes.append(self.scope.get())
            target(*args, **(kwargs or {}))

        thread = threading.Thread(target=context.run, args=(run,), name=name, daemon=daemon)
        self.workers.append(thread)
        return types.SimpleNamespace(start=lambda: None)

    def drain(self):
        for thread in self.workers:
            thread.start()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        self.workers.clear()

    def test_two_instances_route_every_lifecycle_with_same_slug(self):
        providers = []
        for server, token, session in (("https://alpha.example", "alpha-token", "a"),
                                       ("https://beta.example", "beta-token", "b")):
            with self.profile(server, token) as settings:
                provider = self.mod.RembricMemoryProvider()
                self.assertTrue(provider.is_available())
                provider.initialize(session, cwd="/workspace")
                providers.append((provider, settings, session))
        for provider, settings, session in reversed(providers):
            self.calls.clear()
            provider.queue_prefetch("query")
            self.assertIn("recalled", provider.prefetch("query"))
            with self.profile(settings["REMBRIC_SERVER_URL"], settings["REMBRIC_API_TOKEN"]):
                provider.sync_turn("question", "answer")
            self.assertEqual(len(self.workers), 1)
            self.drain()
            provider.on_pre_compress([{"role": "user", "content": "question"}])
            provider.on_session_switch(session + "-new")
            provider.on_session_switch(session)
            provider.on_session_end([])
            suffixes = ["/memory/recall", f"/sessions/{session}/summary",
                        f"/sessions/{session}/turn", f"/sessions/{session}/summary",
                        f"/sessions/{session}/end", "/sessions",
                        f"/sessions/{session}-new/resume", f"/sessions/{session}-new/end",
                        "/sessions", f"/sessions/{session}/end"]
            self.assertEqual([url for url, _, _ in self.calls],
                             [settings["REMBRIC_SERVER_URL"] + "/api/shared" + s for s in suffixes])
            self.assertEqual({auth for _, auth, _ in self.calls},
                             {"Bearer " + settings["REMBRIC_API_TOKEN"]})
            self.assertEqual(self.worker_scopes[-1], settings)

    def test_health_and_initialize_use_scoped_values_not_environment(self):
        for server, token in (("https://alpha.example", "alpha-token"),
                              ("https://alpha.example", "other-token")):
            with self.profile(server, token):
                provider = self.mod.RembricMemoryProvider()
                self.assertTrue(provider.is_available())
                provider.initialize("same-session", cwd="/workspace")
            self.assertEqual(self.calls[-3:], [
                (server + "/healthz", "Bearer " + token, None),
                (server + "/api/shared/sessions", "Bearer " + token,
                 {"id": "same-session", "cwd": "/workspace", "agent": "hermes"}),
                (server + "/api/shared/sessions/same-session/resume", "Bearer " + token, {}),
            ])

    def test_worker_captures_binding_before_scope_exit_and_session_switch(self):
        with self.profile() as settings:
            provider = self.mod.RembricMemoryProvider()
            provider.initialize("old", cwd="/workspace")
            provider.sync_turn("q", "a")
        self.assertEqual(len(self.workers), 1)
        provider.on_session_switch("new")
        self.calls.clear()
        with self.profile("https://wrong.example", "wrong-token", "wrong"):
            self.drain()
        self.assertEqual([url for url, _, _ in self.calls], [
            "https://alpha.example/api/shared/sessions/old/summary",
            "https://alpha.example/api/shared/sessions/old/turn",
        ])
        self.assertEqual({auth for _, auth, _ in self.calls}, {"Bearer alpha-token"})
        self.assertEqual(self.worker_scopes, [settings])

    def assert_disabled(self):
        provider = self.mod.RembricMemoryProvider()
        self.assertFalse(provider.is_available())
        provider.initialize("disabled", cwd="/workspace")
        provider.queue_prefetch("query")
        provider.sync_turn("q", "a")
        provider.on_pre_compress([{"role": "user", "content": "q"}])
        provider.on_session_switch("other")
        provider.on_session_end([])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.workers, [])
        self.assertIn("[rembric]", self.stderr.getvalue())
        for value in ("decoy-token", "alpha-token", "SECRET-ERROR"):
            self.assertNotIn(value, self.stderr.getvalue())

    def test_single_profile_host_api_can_natively_read_environment(self):
        with patch.object(self.secret, "get_secret", os.environ.get):
            provider = self.mod.RembricMemoryProvider()
            self.assertTrue(provider.is_available())
            provider.initialize("single", cwd="/workspace")
        self.assertEqual(self.calls[-1][:2],
                         ("https://decoy.example/api/decoy/sessions/single/resume", "Bearer decoy-token"))

    def test_missing_scoped_slug_does_not_use_environment_slug(self):
        with self.profile() as settings:
            settings.pop("REMBRIC_PROJECT_SLUG")
            provider = self.mod.RembricMemoryProvider()
            provider.initialize("missing-slug", cwd="/workspace")
            provider.queue_prefetch("query")
        self.assertEqual(self.calls, [])
        self.assertIn("no project slug", self.stderr.getvalue())

    def test_dotrembric_wins_over_scoped_default(self):
        with self.profile(), patch.object(self.mod, "_slug_from_dotrembric", return_value="local"):
            provider = self.mod.RembricMemoryProvider()
            provider.initialize("local", cwd="/workspace")
        self.assertEqual(self.calls[0][0], "https://alpha.example/api/local/sessions")

    def test_http_helper_requires_explicit_token(self):
        self.assertIsNone(self.mod._api_request("https://alpha.example", "shared", "/sessions", {}, None))
        self.assertEqual(self.calls, [])
        self.assertIn("missing base/token/slug", self.stderr.getvalue())

    def test_missing_required_secrets_never_use_environment(self):
        for key in ("REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN"):
            with self.subTest(key=key), self.profile() as settings:
                settings[key] = None
                self.assert_disabled()
                self.assertIn("missing profile REMBRIC_SERVER_URL or REMBRIC_API_TOKEN", self.stderr.getvalue())
                self.stderr.seek(0)
                self.stderr.truncate(0)

    def test_scope_error_never_uses_environment_or_leaks_exception(self):
        with patch.object(self.secret, "get_secret", side_effect=RuntimeError("SECRET-ERROR alpha-token")):
            self.assert_disabled()

    def test_absent_secret_api_never_uses_environment(self):
        with patch.dict("sys.modules", {"agent.secret_scope": None}):
            self.assert_disabled()

    def test_missing_secret_callable_never_uses_environment(self):
        delattr(self.secret, "get_secret")
        self.assert_disabled()

    def test_absent_thread_api_disables_initialization(self):
        delattr(self.memory, "spawn_context_thread")
        for _ in range(2):
            with self.profile():
                provider = self.mod.RembricMemoryProvider()
                provider.initialize("disabled", cwd="/workspace")
                provider.sync_turn("q", "a")
            self.assertEqual(self.calls, [])
            self.assertEqual(self.workers, [])
            self.assertIn("update Hermes", self.stderr.getvalue())
            self.memory.__dict__["spawn_context_thread"] = None

    def test_thread_factory_or_start_error_is_safe(self):
        for factory in (lambda *a, **k: (_ for _ in ()).throw(RuntimeError("SECRET-ERROR")),
                        lambda *a, **k: types.SimpleNamespace(start=lambda: (_ for _ in ()).throw(RuntimeError("SECRET-ERROR")))):
            with self.profile(), patch.object(self.memory, "spawn_context_thread", factory):
                provider = self.mod.RembricMemoryProvider()
                provider.initialize("a", cwd="/workspace")
                self.calls.clear()
                provider.sync_turn("q", "a")
            self.assertEqual(self.calls, [])
            self.assertIn("[rembric]", self.stderr.getvalue())
            self.assertNotIn("SECRET-ERROR", self.stderr.getvalue())

    def test_http_errors_do_not_leak_credentials(self):
        with self.profile():
            provider = self.mod.RembricMemoryProvider()
            provider.initialize("a", cwd="/workspace")
        errors = (RuntimeError("SECRET-ERROR alpha-token"),
                  HTTPError("https://alpha.example", 403, "SECRET-ERROR alpha-token", Message(),
                            io.BytesIO(b"SECRET-ERROR alpha-token")))
        for error in errors:
            with self.subTest(error=type(error).__name__), patch.object(self.mod, "urlopen", side_effect=error):
                provider.queue_prefetch("query")
                self.assertNotIn("SECRET-ERROR", self.stderr.getvalue())
                self.assertNotIn("alpha-token", self.stderr.getvalue())
                self.assertIn("[rembric]", self.stderr.getvalue())
        errors[1].close()


if __name__ == "__main__":
    unittest.main()
