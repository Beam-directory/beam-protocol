import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from beam_crewai import BeamAgent


class FakeResult:
    def __init__(self, *, success=True, payload=None, error=None):
        self.success = success
        self.payload = payload
        self.error = error


class FakeClient:
    def __init__(self):
        self.beam_id = "sender@acme.beam.directory"
        self.last_send = None
        self.last_talk = None
        self.last_register = None

    async def register(self, display_name, capabilities):
        self.last_register = (display_name, capabilities)
        return {"beamId": self.beam_id, "displayName": display_name}

    async def send(self, *, to, intent, params, timeout_ms):
        self.last_send = {
            "to": to,
            "intent": intent,
            "params": params,
            "timeout_ms": timeout_ms,
        }
        return FakeResult(success=True, payload={"echo": params})

    async def talk(self, *, to, message, context, language, timeout_ms, thread_id):
        self.last_talk = {
            "to": to,
            "message": message,
            "context": context,
            "language": language,
            "timeout_ms": timeout_ms,
            "thread_id": thread_id,
        }
        return {
            "message": f"reply:{message}",
            "structured": {"language": language},
            "raw": FakeResult(success=True, payload={"message": f"reply:{message}"}),
        }

    def thread(self, to, *, language, timeout_ms):
        return {"to": to, "language": language, "timeout_ms": timeout_ms}


class BeamAgentTests(unittest.TestCase):
    def test_send_intent_sync_uses_default_recipient(self):
        client = FakeClient()
        agent = BeamAgent(client=client, default_recipient="target@partner.beam.directory")

        result = agent.send_intent_sync(intent="query.status", params={"detail": "full"})

        self.assertTrue(result.success)
        self.assertEqual(client.last_send["to"], "target@partner.beam.directory")
        self.assertEqual(client.last_send["intent"], "query.status")

    def test_talk_sync_forwards_context(self):
        client = FakeClient()
        agent = BeamAgent(client=client, default_recipient="target@partner.beam.directory")

        reply = agent.talk_sync(
            "hello",
            context={"ticket": 42},
            language="de",
            timeout_ms=1234,
        )

        self.assertEqual(reply["message"], "reply:hello")
        self.assertEqual(client.last_talk["context"], {"ticket": 42})
        self.assertEqual(client.last_talk["language"], "de")
        self.assertEqual(client.last_talk["timeout_ms"], 1234)

    def test_requires_recipient_when_missing(self):
        agent = BeamAgent(client=FakeClient())

        with self.assertRaises(ValueError):
            agent.send_intent_sync(intent="ping")

    def test_thread_uses_default_recipient(self):
        agent = BeamAgent(client=FakeClient(), default_recipient="thread@partner.beam.directory")

        thread = agent.thread(language="fr", timeout_ms=999)

        self.assertEqual(thread["to"], "thread@partner.beam.directory")
        self.assertEqual(thread["language"], "fr")

    def test_create_uses_lazy_beam_sdk_imports(self):
        beam_directory_module = types.ModuleType("beam_directory")
        client_module = types.ModuleType("beam_directory.client")
        identity_module = types.ModuleType("beam_directory.identity")

        class FakeBeamIdentity:
            @classmethod
            def generate(cls, *, agent_name, org_name):
                identity = cls()
                identity.beam_id = f"{agent_name}@{org_name}.beam.directory"
                return identity

        class FakeBeamClientCtor:
            def __init__(self, *, identity, directory_url):
                self.beam_id = identity.beam_id
                self.directory_url = directory_url

        identity_module.BeamIdentity = FakeBeamIdentity
        client_module.BeamClient = FakeBeamClientCtor

        original_modules = {
            name: sys.modules.get(name)
            for name in ("beam_directory", "beam_directory.client", "beam_directory.identity")
        }

        try:
            sys.modules["beam_directory"] = beam_directory_module
            sys.modules["beam_directory.client"] = client_module
            sys.modules["beam_directory.identity"] = identity_module

            agent = BeamAgent.create(
                agent_name="researcher",
                org_name="acme",
                directory_url="https://api.beam.directory",
            )

            self.assertEqual(agent.beam_id, "researcher@acme.beam.directory")
        finally:
            for name, module in original_modules.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module


if __name__ == "__main__":
    unittest.main()

