"""CrewAI tool for sending natural-language messages over Beam Protocol."""

from __future__ import annotations

import json
from typing import Any, Optional

from ._compat import BaseModel, BaseTool, model_field
from .agent import BeamAgent


class BeamToolInput(BaseModel):
    """Input schema for the Beam CrewAI tool."""

    message: str = model_field(..., description="Message to send to the remote Beam agent")
    to: str | None = model_field(None, description="Optional Beam recipient override")
    context: dict[str, Any] | None = model_field(
        None,
        description="Optional structured context sent alongside the message",
    )
    language: str = model_field("en", description="Language hint for the remote agent")
    timeout_ms: int = model_field(60_000, description="Beam request timeout in milliseconds")


class BeamTool(BaseTool):
    """CrewAI-compatible tool that delegates questions to Beam agents."""

    name: str = "beam_message"
    description: str = (
        "Send a natural-language message to a Beam agent and return the reply."
    )
    beam_agent: Any
    default_recipient: str | None = None
    default_language: str = "en"
    args_schema: type[BeamToolInput] = BeamToolInput

    def __init__(
        self,
        *,
        beam_agent: BeamAgent,
        default_recipient: str | None = None,
        default_language: str = "en",
        name: str | None = None,
        description: str | None = None,
    ) -> None:
        init_kwargs: dict[str, Any] = {
            "beam_agent": beam_agent,
            "default_recipient": default_recipient or beam_agent.default_recipient,
            "default_language": default_language,
        }
        if name is not None:
            init_kwargs["name"] = name
        if description is not None:
            init_kwargs["description"] = description
        super().__init__(**init_kwargs)

    def _resolve_recipient(self, to: str | None) -> str | None:
        return to or self.default_recipient

    @staticmethod
    def _format_reply(reply: dict[str, Any]) -> str:
        raw = reply.get("raw")
        if raw is not None and not getattr(raw, "success", True):
            message = getattr(raw, "error", None) or "Beam delivery failed"
            raise RuntimeError(message)

        text = reply.get("message")
        if text:
            return text

        structured = reply.get("structured")
        if structured is not None:
            return json.dumps(structured, ensure_ascii=False, sort_keys=True)

        payload = getattr(raw, "payload", None) if raw is not None else None
        if payload is not None:
            return json.dumps(payload, ensure_ascii=False, sort_keys=True)

        return ""

    def _run(
        self,
        message: str,
        to: str | None = None,
        context: Optional[dict[str, Any]] = None,
        language: str | None = None,
        timeout_ms: int = 60_000,
    ) -> str:
        """Synchronously send a message to a Beam agent."""

        reply = self.beam_agent.talk_sync(
            message,
            to=self._resolve_recipient(to),
            context=context,
            language=language or self.default_language,
            timeout_ms=timeout_ms,
        )
        return self._format_reply(reply)

    async def _arun(
        self,
        message: str,
        to: str | None = None,
        context: Optional[dict[str, Any]] = None,
        language: str | None = None,
        timeout_ms: int = 60_000,
    ) -> str:
        """Asynchronously send a message to a Beam agent."""

        reply = await self.beam_agent.talk(
            message,
            to=self._resolve_recipient(to),
            context=context,
            language=language or self.default_language,
            timeout_ms=timeout_ms,
        )
        return self._format_reply(reply)
