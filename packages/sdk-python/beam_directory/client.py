"""BeamClient — high-level client for sending and receiving intents."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, Coroutine, Optional

import httpx

from .directory import BeamDirectory
from .frames import create_intent_frame, create_result_frame
from .identity import BeamIdentity
from .types import (
    AgentRecord,
    AgentRegistration,
    AgentSearchQuery,
    BeamClientConfig,
    BeamIdString,
    IntentFrame,
    ResultFrame,
)

IntentHandler = Callable[
    [IntentFrame],
    Coroutine[Any, Any, ResultFrame],
]


class BeamClient:
    """
    High-level Beam Protocol client.

    Handles registration, intent sending (HTTP + WebSocket), and intent
    receiving.

    Usage::

        identity = BeamIdentity.generate("jarvis", "coppen")
        client = BeamClient(identity=identity, directory_url="http://localhost:3100")

        await client.register("Jarvis", ["query", "answer"])
        result = await client.send(
            "other@org.beam.directory",
            "greet",
            {"message": "hello"}
        )
    """

    def __init__(
        self,
        identity: BeamIdentity,
        directory_url: str,
    ) -> None:
        self._identity = identity
        self._directory_url = directory_url.rstrip("/")
        self._directory = BeamDirectory(
            config=__import__("beam_directory.types", fromlist=["DirectoryConfig"]).DirectoryConfig(
                base_url=directory_url
            )
        )
        self._intent_handlers: dict[str, IntentHandler] = {}
        self._ws_task: Optional[asyncio.Task[None]] = None

    @classmethod
    def from_config(cls, config: BeamClientConfig) -> "BeamClient":
        """Construct from a BeamClientConfig / serialised identity."""
        identity = BeamIdentity.from_data(config.identity)
        return cls(identity=identity, directory_url=config.directory_url)

    # ── Properties ─────────────────────────────────────────────────────────────

    @property
    def beam_id(self) -> BeamIdString:
        return self._identity.beam_id

    @property
    def directory(self) -> BeamDirectory:
        return self._directory

    # ── Registration ───────────────────────────────────────────────────────────

    async def register(
        self, display_name: str, capabilities: Optional[list[str]] = None
    ) -> AgentRecord:
        """Register this agent with the directory."""
        reg = self._identity.to_registration(display_name, capabilities or [])
        return await self._directory.register(reg)

    # ── Sending ────────────────────────────────────────────────────────────────

    async def send(
        self,
        to: BeamIdString,
        intent: str,
        params: Optional[dict[str, Any]] = None,
        timeout_ms: int = 30_000,
    ) -> ResultFrame:
        """
        Send an intent to another agent.

        Tries HTTP first (via directory routing endpoint), falls back to
        a direct WebSocket connection if available.
        """
        frame = create_intent_frame(
            intent=intent,
            from_id=self._identity.beam_id,
            to_id=to,
            params=params or {},
            identity=self._identity,
        )
        return await self._send_via_http(frame, timeout_ms)

    # ── Intent handling ────────────────────────────────────────────────────────

    def on_intent(self, intent: str) -> Callable[[IntentHandler], IntentHandler]:
        """Decorator to register an intent handler."""
        def decorator(fn: IntentHandler) -> IntentHandler:
            self._intent_handlers[intent] = fn
            return fn
        return decorator

    async def handle_intent(self, frame: IntentFrame) -> ResultFrame:
        """Dispatch an incoming IntentFrame to the registered handler."""
        handler = self._intent_handlers.get(frame.intent)
        start = time.time()
        if handler is None:
            return create_result_frame(
                success=False,
                nonce=frame.nonce,
                error=f"No handler for intent: {frame.intent!r}",
                error_code="INTENT_NOT_FOUND",
                latency=int((time.time() - start) * 1000),
            )
        try:
            result = await handler(frame)
            return result
        except Exception as exc:
            return create_result_frame(
                success=False,
                nonce=frame.nonce,
                error=str(exc),
                error_code="HANDLER_ERROR",
                latency=int((time.time() - start) * 1000),
            )

    # ── Private ────────────────────────────────────────────────────────────────

    async def _send_via_http(
        self, frame: IntentFrame, timeout_ms: int
    ) -> ResultFrame:
        """Route an intent via the directory's HTTP endpoint."""
        timeout = timeout_ms / 1000
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{self._directory_url}/intents/send",
                json=frame.to_dict(),
                timeout=timeout,
            )
        if not res.is_success:
            try:
                body = res.json()
                msg = body.get("error", res.text)
            except Exception:
                msg = res.text
            return create_result_frame(
                success=False,
                nonce=frame.nonce,
                error=f"HTTP {res.status_code}: {msg}",
                error_code="DELIVERY_FAILED",
            )
        data: Any = res.json()
        return ResultFrame.from_dict(data)
