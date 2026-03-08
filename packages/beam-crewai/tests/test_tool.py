import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from beam_crewai import BeamTool


class FakeRawResult:
    def __init__(self, *, success=True, payload=None, error=None):
        self.success = success
        self.payload = payload
        self.error = error


class FakeBeamAgent:
    def __init__(self):
        self.default_recipient = "default@partner.beam.directory"
        self.calls = []

    def talk_sync(self, message, *, to, context, language, timeout_ms, thread_id=None):
        self.calls.append((message, to, context, language, timeout_ms, thread_id))
        if message == "structured":
            return {
                "message": "",
                "structured": {"status": "ok"},
                "raw": FakeRawResult(success=True, payload={"status": "ok"}),
            }
        if message == "failure":
            return {
                "message": "",
                "structured": None,
                "raw": FakeRawResult(success=False, error="delivery failed"),
            }
        return {
            "message": "beam reply",
            "structured": None,
            "raw": FakeRawResult(success=True, payload={"message": "beam reply"}),
        }

    async def talk(self, message, *, to, context, language, timeout_ms, thread_id=None):
        return self.talk_sync(
            message,
            to=to,
            context=context,
            language=language,
            timeout_ms=timeout_ms,
            thread_id=thread_id,
        )


class BeamToolTests(unittest.TestCase):
    def test_run_returns_text_reply(self):
        tool = BeamTool(beam_agent=FakeBeamAgent())

        result = tool._run("hello")

        self.assertEqual(result, "beam reply")

    def test_run_uses_explicit_recipient_override(self):
        beam_agent = FakeBeamAgent()
        tool = BeamTool(beam_agent=beam_agent)

        tool._run("hello", to="override@partner.beam.directory", language="de")

        self.assertEqual(beam_agent.calls[-1][1], "override@partner.beam.directory")
        self.assertEqual(beam_agent.calls[-1][3], "de")

    def test_run_serializes_structured_reply(self):
        tool = BeamTool(beam_agent=FakeBeamAgent())

        result = tool._run("structured")

        self.assertEqual(result, '{"status": "ok"}')

    def test_run_raises_on_delivery_failure(self):
        tool = BeamTool(beam_agent=FakeBeamAgent())

        with self.assertRaises(RuntimeError):
            tool._run("failure")

    def test_arun_returns_text_reply(self):
        tool = BeamTool(beam_agent=FakeBeamAgent())

        result = asyncio.run(tool._arun("hello", context={"x": 1}))

        self.assertEqual(result, "beam reply")


if __name__ == "__main__":
    unittest.main()

