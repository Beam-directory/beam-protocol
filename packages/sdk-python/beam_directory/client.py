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

    # ── Natural Language Communication ────────────────────────────────────────

    def thread(
        self,
        to: BeamIdString,
        *,
        language: str = "en",
        timeout_ms: int = 60_000,
    ) -> "BeamThread":
        """Start a multi-turn conversation thread."""
        return BeamThread(self, to, language=language, timeout_ms=timeout_ms)

    async def talk(
        self,
        to: BeamIdString,
        message: str,
        *,
        context: Optional[dict[str, Any]] = None,
        language: str = "en",
        timeout_ms: int = 60_000,
        thread_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """
        Send a natural language message to another agent.

        The receiving agent uses its LLM to interpret and respond.
        Returns a dict with 'message' (str), 'structured' (optional dict),
        and 'raw' (ResultFrame).

        Example::

            reply = await client.talk(
                "clara@coppen.beam.directory",
                "Was weißt du über Chris Schnorrenberg?"
            )
            print(reply["message"])  # Natural language response
        """
        if not message:
            raise ValueError("Message must be non-empty")
        if len(message) > 32768:
            raise ValueError("Message exceeds maximum length of 32768 characters")

        params: dict[str, Any] = {"message": message}
        if context:
            params["context"] = context
        if language != "en":
            params["language"] = language
        if thread_id:
            params["threadId"] = thread_id

        result = await self.send(
            to=to,
            intent="conversation.message",
            params=params,
            timeout_ms=timeout_ms,
        )

        return {
            "message": result.payload.get("message", "") if result.payload else "",
            "structured": result.payload.get("structured") if result.payload else None,
            "raw": result,
        }

    def on_talk(
        self,
        handler: Callable[
            [str, BeamIdString, IntentFrame],
            Coroutine[Any, Any, tuple[str, Optional[dict[str, Any]]]],
        ],
    ) -> None:
        """
        Register a natural language message handler.

        The handler receives (message, from_id, frame) and must return
        (reply_message, optional_structured_data).

        Example::

            async def handle_talk(message, from_id, frame):
                answer = await my_llm.generate(message)
                return answer, {"confidence": 0.95}

            client.on_talk(handle_talk)
        """
        async def _wrapper(frame: IntentFrame) -> ResultFrame:
            msg = frame.params.get("message", "") if frame.params else ""
            start = time.time()
            reply_msg, structured = await handler(msg, frame.from_id, frame)
            latency = int((time.time() - start) * 1000)
            payload: dict[str, Any] = {"message": reply_msg}
            if structured:
                payload["structured"] = structured
            return create_result_frame(
                success=True,
                nonce=frame.nonce,
                payload=payload,
                latency=latency,
            )

        self._intent_handlers["conversation.message"] = _wrapper

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


class BeamThread:
    """
    Multi-turn conversation thread between two agents.

    Example::

        chat = client.thread("clara@coppen.beam.directory")
        r1 = await chat.say("Was weißt du über Chris?")
        r2 = await chat.say("Und seine Pipeline?")  # keeps context
    """

    def __init__(
        self,
        client: BeamClient,
        to: "BeamIdString",
        *,
        language: str = "en",
        timeout_ms: int = 60_000,
    ) -> None:
        import uuid
        self.thread_id = str(uuid.uuid4())
        self._client = client
        self._to = to
        self._language = language
        self._timeout_ms = timeout_ms

    async def say(
        self,
        message: str,
        context: "Optional[dict[str, Any]]" = None,
    ) -> dict[str, Any]:
        """Send a message in this thread."""
        return await self._client.talk(
            self._to,
            message,
            context=context,
            language=self._language,
            timeout_ms=self._timeout_ms,
            thread_id=self.thread_id,
        )
