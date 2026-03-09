"""Tests for Beam LangChain tools and toolkit."""

from __future__ import annotations

import asyncio
import json
import sys
import types
import unittest
from dataclasses import dataclass
from pathlib import Path


def _install_test_stubs() -> None:
    if "pydantic" not in sys.modules:
        pydantic = types.ModuleType("pydantic")

        class BaseModel:
            def __init__(self, **data):
                annotations = {}
                for cls in reversed(self.__class__.mro()):
                    annotations.update(getattr(cls, "__annotations__", {}))

                for name in annotations:
                    if name in data:
                        value = data.pop(name)
                    else:
                        value = getattr(self.__class__, name, None)
                    setattr(self, name, value)

                for name, value in data.items():
                    setattr(self, name, value)

        def Field(default=None, **kwargs):
            if "default_factory" in kwargs:
                return kwargs["default_factory"]()
            return default

        pydantic.BaseModel = BaseModel
        pydantic.Field = Field
        sys.modules["pydantic"] = pydantic

    if "langchain_core" not in sys.modules:
        langchain_core = types.ModuleType("langchain_core")
        tools_mod = types.ModuleType("langchain_core.tools")
        tools_base_mod = types.ModuleType("langchain_core.tools.base")

        BaseModel = sys.modules["pydantic"].BaseModel

        class BaseTool(BaseModel):
            name: str = ""
            description: str = ""

        class BaseToolkit(BaseModel):
            tools: list = []

            def get_tools(self):
                return list(self.tools)

        tools_mod.BaseTool = BaseTool
        tools_mod.BaseToolkit = BaseToolkit
        tools_base_mod.BaseToolkit = BaseToolkit

        sys.modules["langchain_core"] = langchain_core
        sys.modules["langchain_core.tools"] = tools_mod
        sys.modules["langchain_core.tools.base"] = tools_base_mod

    if "beam_directory" not in sys.modules:
        beam_directory = types.ModuleType("beam_directory")
        beam_directory.__path__ = []
        beam_directory_types = types.ModuleType("beam_directory.types")

        @dataclass
        class AgentRecord:
            beam_id: str
            display_name: str
            capabilities: list[str]
            public_key: str
            org: str
            trust_score: float = 0.5
            verified: bool = False
            created_at: str = ""
            last_seen: str = ""

        @dataclass
        class AgentSearchQuery:
            org: str | None = None
            capabilities: list[str] | None = None
            min_trust_score: float | None = None
            limit: int = 20

        @dataclass
        class ResultFrame:
            v: str
            success: bool
            nonce: str
            timestamp: str
            payload: dict | None = None
            error: str | None = None
            error_code: str | None = None
            latency: int | None = None
            signature: str | None = None

        beam_directory_types.AgentRecord = AgentRecord
        beam_directory_types.AgentSearchQuery = AgentSearchQuery
        beam_directory_types.ResultFrame = ResultFrame
        beam_directory.types = beam_directory_types

        sys.modules["beam_directory"] = beam_directory
        sys.modules["beam_directory.types"] = beam_directory_types


ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "beam-langchain" / "src"))

_install_test_stubs()

from beam_directory.types import AgentRecord, AgentSearchQuery, ResultFrame
from beam_langchain import BeamAgentTool, BeamIntentTool, BeamToolkit


class FakeDirectory:
    def __init__(self, records: list[AgentRecord]) -> None:
        self._records = {record.beam_id: record for record in records}
        self.search_queries: list[AgentSearchQuery | None] = []

    async def lookup(self, beam_id: str):
        return self._records.get(beam_id)

    async def search(self, query: AgentSearchQuery | None = None):
        self.search_queries.append(query)
        return list(self._records.values())


class FakeBeamClient:
    def __init__(self, records: list[AgentRecord]) -> None:
        self.directory = FakeDirectory(records)
        self.talk_calls: list[dict[str, object]] = []
        self.send_calls: list[dict[str, object]] = []

    async def talk(
        self,
        *,
        to: str,
        message: str,
        context=None,
        language: str,
        timeout_ms: int,
        thread_id=None,
    ):
        self.talk_calls.append(
            {
                "to": to,
                "message": message,
                "context": context,
                "language": language,
                "timeout_ms": timeout_ms,
                "thread_id": thread_id,
            }
        )
        return {"message": f"reply:{message}"}

    async def send(self, *, to: str, intent: str, params: dict, timeout_ms: int):
        self.send_calls.append(
            {
                "to": to,
                "intent": intent,
                "params": params,
                "timeout_ms": timeout_ms,
            }
        )
        return ResultFrame(
            v="1",
            success=True,
            nonce="nonce-1",
            timestamp="2026-03-08T00:00:00Z",
            payload={"handled": intent, "params": params},
        )


def make_record(*, beam_id: str, display_name: str, capabilities: list[str]) -> AgentRecord:
    return AgentRecord(
        beam_id=beam_id,
        display_name=display_name,
        capabilities=capabilities,
        public_key="public-key",
        org=beam_id.split("@")[1].split(".")[0],
    )


class BeamAgentToolTests(unittest.TestCase):
    def test_arun_sends_conversation_message(self):
        client = FakeBeamClient([])
        tool = BeamAgentTool(client=client, beam_id="helper@demo.beam.directory")

        result = asyncio.run(
            tool._arun(
                message="Status update",
                context={"ticket": 42},
                thread_id="thread-1",
            )
        )

        self.assertEqual(result, "reply:Status update")
        self.assertEqual(client.talk_calls[0]["to"], "helper@demo.beam.directory")
        self.assertEqual(client.talk_calls[0]["language"], "en")
        self.assertEqual(client.talk_calls[0]["thread_id"], "thread-1")


class BeamIntentToolTests(unittest.TestCase):
    def test_arun_sends_intent_and_formats_payload(self):
        client = FakeBeamClient([])
        tool = BeamIntentTool(
            client=client,
            beam_id="search@demo.beam.directory",
            intent="search.docs",
        )

        result = asyncio.run(tool._arun(params={"q": "beam"}))

        self.assertEqual(json.loads(result), {"handled": "search.docs", "params": {"q": "beam"}})
        self.assertEqual(client.send_calls[0]["intent"], "search.docs")


class BeamToolkitTests(unittest.TestCase):
    def test_from_records_creates_message_and_intent_tools(self):
        record = make_record(
            beam_id="researcher@demo.beam.directory",
            display_name="Researcher",
            capabilities=["search.docs", "summarize"],
        )
        toolkit = BeamToolkit.from_records(FakeBeamClient([record]), [record])

        tool_names = [tool.name for tool in toolkit.get_tools()]
        self.assertEqual(len(tool_names), 3)
        self.assertTrue(any(name.startswith("beam_message_") for name in tool_names))
        self.assertIn("beam_researcher_demo_search_docs", tool_names)
        self.assertIn("beam_researcher_demo_summarize", tool_names)

    def test_afrom_agents_looks_up_records(self):
        record = make_record(
            beam_id="planner@demo.beam.directory",
            display_name="Planner",
            capabilities=["plan"],
        )
        client = FakeBeamClient([record])

        toolkit = asyncio.run(BeamToolkit.afrom_agents(client, [record.beam_id]))

        self.assertEqual(len(toolkit.get_tools()), 2)

    def test_afrom_search_uses_directory_search(self):
        record = make_record(
            beam_id="ops@demo.beam.directory",
            display_name="Ops",
            capabilities=["incident.lookup"],
        )
        client = FakeBeamClient([record])
        query = AgentSearchQuery(org="demo", limit=5)

        toolkit = asyncio.run(BeamToolkit.afrom_search(client, query))

        self.assertEqual(len(toolkit.get_tools()), 2)
        self.assertEqual(client.directory.search_queries[0], query)

    def test_afrom_agents_raises_for_missing_records(self):
        client = FakeBeamClient([])

        with self.assertRaisesRegex(ValueError, "missing@demo.beam.directory"):
            asyncio.run(BeamToolkit.afrom_agents(client, ["missing@demo.beam.directory"]))

