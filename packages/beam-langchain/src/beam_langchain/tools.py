"""LangChain tools for Beam Protocol agent-to-agent communication."""

from __future__ import annotations

import asyncio
import json
import re
from typing import TYPE_CHECKING, Any, ClassVar, Iterable, Optional

if TYPE_CHECKING:
    from beam_directory import BeamClient
from beam_directory.types import AgentRecord, AgentSearchQuery, ResultFrame
from langchain_core.tools import BaseTool
from langchain_core.tools.base import BaseToolkit
from pydantic import BaseModel, Field

DEFAULT_DIRECTORY_URL = "https://api.beam.directory"


def _sanitize_tool_component(value: str) -> str:
    sanitized = re.sub(r"[^a-z0-9]+", "_", value.lower())
    return sanitized.strip("_") or "beam"


def _tool_name(prefix: str, beam_id: str, suffix: str) -> str:
    domainless = beam_id.removesuffix(".beam.directory").replace("@", "_")
    parts = [_sanitize_tool_component(prefix), _sanitize_tool_component(domainless)]
    if suffix:
        parts.append(_sanitize_tool_component(suffix))
    return "_".join(part for part in parts if part)


def _run_coro_sync(coro: Any) -> Any:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    coro.close()
    raise RuntimeError(
        "Beam tools cannot block on an active event loop. Use the async tool interface instead."
    )


def _format_result(result: ResultFrame) -> str:
    if not result.success:
        message = result.error or "Beam intent failed"
        raise RuntimeError(message)

    payload = result.payload or {}
    message = payload.get("message")
    if isinstance(message, str) and message:
        return message
    return json.dumps(payload, sort_keys=True)


class BeamAgentMessageInput(BaseModel):
    """Input schema for natural-language Beam messaging."""

    message: str = Field(..., description="Natural-language message to send to the remote Beam agent.")
    context: Optional[dict[str, Any]] = Field(
        default=None,
        description="Optional structured context the remote agent can use while answering.",
    )
    language: Optional[str] = Field(
        default=None,
        description="Optional language override, for example 'en' or 'de'.",
    )
    timeout_ms: Optional[int] = Field(
        default=None,
        description="Optional request timeout in milliseconds.",
    )
    thread_id: Optional[str] = Field(
        default=None,
        description="Optional Beam thread identifier for multi-turn conversations.",
    )


class BeamIntentInput(BaseModel):
    """Input schema for sending a Beam intent."""

    params: dict[str, Any] = Field(
        default_factory=dict,
        description="JSON-serializable parameters for the Beam intent.",
    )
    timeout_ms: Optional[int] = Field(
        default=None,
        description="Optional request timeout in milliseconds.",
    )


class BeamAgentTool(BaseTool):
    """LangChain tool for Beam `conversation.message`."""

    args_schema: ClassVar[type[BaseModel]] = BeamAgentMessageInput

    name: str
    description: str
    client: Any
    beam_id: str
    default_language: str = "en"
    default_timeout_ms: int = 60_000

    def __init__(
        self,
        *,
        client: BeamClient,
        beam_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        default_language: str = "en",
        default_timeout_ms: int = 60_000,
    ) -> None:
        super().__init__(
            name=name or _tool_name("beam_message", beam_id, "conversation"),
            description=description
            or (
                f"Send a natural-language request to Beam agent {beam_id} via the "
                "conversation.message intent."
            ),
            client=client,
            beam_id=beam_id,
            default_language=default_language,
            default_timeout_ms=default_timeout_ms,
        )

    def _run(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        language: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        thread_id: Optional[str] = None,
        **_: Any,
    ) -> str:
        return _run_coro_sync(
            self._arun(
                message=message,
                context=context,
                language=language,
                timeout_ms=timeout_ms,
                thread_id=thread_id,
            )
        )

    async def _arun(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
        language: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        thread_id: Optional[str] = None,
        **_: Any,
    ) -> str:
        reply = await self.client.talk(
            to=self.beam_id,
            message=message,
            context=context,
            language=language or self.default_language,
            timeout_ms=timeout_ms or self.default_timeout_ms,
            thread_id=thread_id,
        )
        return reply.get("message", "")


class BeamIntentTool(BaseTool):
    """LangChain tool for a specific Beam intent on a remote agent."""

    args_schema: ClassVar[type[BaseModel]] = BeamIntentInput

    name: str
    description: str
    client: Any
    beam_id: str
    intent: str
    default_timeout_ms: int = 30_000

    def __init__(
        self,
        *,
        client: BeamClient,
        beam_id: str,
        intent: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        default_timeout_ms: int = 30_000,
    ) -> None:
        super().__init__(
            name=name or _tool_name("beam", beam_id, intent),
            description=description
            or f"Send Beam intent '{intent}' to remote agent {beam_id}.",
            client=client,
            beam_id=beam_id,
            intent=intent,
            default_timeout_ms=default_timeout_ms,
        )

    def _run(
        self,
        params: Optional[dict[str, Any]] = None,
        timeout_ms: Optional[int] = None,
        **_: Any,
    ) -> str:
        return _run_coro_sync(self._arun(params=params, timeout_ms=timeout_ms))

    async def _arun(
        self,
        params: Optional[dict[str, Any]] = None,
        timeout_ms: Optional[int] = None,
        **_: Any,
    ) -> str:
        result = await self.client.send(
            to=self.beam_id,
            intent=self.intent,
            params=params or {},
            timeout_ms=timeout_ms or self.default_timeout_ms,
        )
        return _format_result(result)


class BeamToolkit(BaseToolkit):
    """Toolkit that exposes Beam agents and intents as LangChain tools."""

    tools: list[BaseTool]

    def __init__(self, *, tools: list[BaseTool]) -> None:
        super().__init__(tools=tools)

    def get_tools(self) -> list[BaseTool]:
        return list(self.tools)

    @classmethod
    def from_records(
        cls,
        client: BeamClient,
        records: Iterable[AgentRecord],
        *,
        include_message_tool: bool = True,
        default_timeout_ms: int = 30_000,
    ) -> "BeamToolkit":
        tools: list[BaseTool] = []
        seen_names: set[str] = set()

        for record in records:
            if include_message_tool:
                message_tool = BeamAgentTool(
                    client=client,
                    beam_id=record.beam_id,
                    name=_tool_name("beam_message", record.beam_id, "conversation"),
                    description=(
                        f"Send a natural-language request to {record.display_name or record.beam_id} "
                        f"({record.beam_id}) via Beam conversation.message."
                    ),
                    default_timeout_ms=max(default_timeout_ms, 60_000),
                )
                if message_tool.name not in seen_names:
                    tools.append(message_tool)
                    seen_names.add(message_tool.name)

            for intent in sorted(set(record.capabilities)):
                if include_message_tool and intent == "conversation.message":
                    continue

                intent_tool = BeamIntentTool(
                    client=client,
                    beam_id=record.beam_id,
                    intent=intent,
                    description=(
                        f"Call Beam intent '{intent}' on {record.display_name or record.beam_id} "
                        f"({record.beam_id})."
                    ),
                    default_timeout_ms=default_timeout_ms,
                )
                if intent_tool.name not in seen_names:
                    tools.append(intent_tool)
                    seen_names.add(intent_tool.name)

        return cls(tools=tools)

    @classmethod
    def from_agents(
        cls,
        client: BeamClient,
        beam_ids: Iterable[str],
        *,
        include_message_tool: bool = True,
        default_timeout_ms: int = 30_000,
    ) -> "BeamToolkit":
        return _run_coro_sync(
            cls.afrom_agents(
                client,
                beam_ids,
                include_message_tool=include_message_tool,
                default_timeout_ms=default_timeout_ms,
            )
        )

    @classmethod
    async def afrom_agents(
        cls,
        client: BeamClient,
        beam_ids: Iterable[str],
        *,
        include_message_tool: bool = True,
        default_timeout_ms: int = 30_000,
    ) -> "BeamToolkit":
        records: list[AgentRecord] = []
        missing: list[str] = []

        for beam_id in beam_ids:
            record = await client.directory.lookup(beam_id)
            if record is None:
                missing.append(beam_id)
                continue
            records.append(record)

        if missing:
            missing_list = ", ".join(missing)
            raise ValueError(f"Beam agents not found in directory: {missing_list}")

        return cls.from_records(
            client,
            records,
            include_message_tool=include_message_tool,
            default_timeout_ms=default_timeout_ms,
        )

    @classmethod
    def from_search(
        cls,
        client: BeamClient,
        query: Optional[AgentSearchQuery] = None,
        *,
        include_message_tool: bool = True,
        default_timeout_ms: int = 30_000,
    ) -> "BeamToolkit":
        return _run_coro_sync(
            cls.afrom_search(
                client,
                query,
                include_message_tool=include_message_tool,
                default_timeout_ms=default_timeout_ms,
            )
        )

    @classmethod
    async def afrom_search(
        cls,
        client: BeamClient,
        query: Optional[AgentSearchQuery] = None,
        *,
        include_message_tool: bool = True,
        default_timeout_ms: int = 30_000,
    ) -> "BeamToolkit":
        records = await client.directory.search(query)
        return cls.from_records(
            client,
            records,
            include_message_tool=include_message_tool,
            default_timeout_ms=default_timeout_ms,
        )

