"""BeamClient — high-level client for sending and receiving intents."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Coroutine, Optional

import httpx

from .directory import BeamDirectory
from .frames import create_intent_frame, create_result_frame
from .identity import BeamIdentity
from .types import (
    AgentProfile,
    AgentRecord,
    BeamClientConfig,
    BeamIdString,
    BrowseFilters,
    BrowseResult,
    Delegation,
    DirectoryConfig,
    DirectoryStats,
    DomainVerification,
    IntentFrame,
    KeyRotationResult,
    Report,
    ResultFrame,
    BeamIdentityData,
)

IntentHandler = Callable[[IntentFrame], Coroutine[Any, Any, ResultFrame]]


class BeamClient:
    def __init__(
        self,
        identity: BeamIdentity,
        directory_url: str,
    ) -> None:
        self._identity = identity
        self._directory_url = directory_url.rstrip("/")
        self._directory = BeamDirectory(DirectoryConfig(base_url=directory_url))
        self._intent_handlers: dict[str, IntentHandler] = {}
        self._ws_task: Optional[asyncio.Task[None]] = None

    @classmethod
    def from_config(cls, config: BeamClientConfig) -> "BeamClient":
        identity = BeamIdentity.from_data(config.identity)
        return cls(identity=identity, directory_url=config.directory_url)

    @property
    def beam_id(self) -> BeamIdString:
        return self._identity.beam_id

    @property
    def directory(self) -> BeamDirectory:
        return self._directory

    async def register(
        self, display_name: str, capabilities: Optional[list[str]] = None
    ) -> AgentRecord:
        reg = self._identity.to_registration(display_name, capabilities or [])
        return await self._directory.register(reg)

    async def update_profile(
        self,
        fields: dict[str, Optional[str]],
    ) -> AgentProfile:
        data = await self._request(
            "PATCH",
            f"/agents/{self._identity.beam_id}/profile",
            json=fields,
        )
        return AgentProfile.from_dict(data)

    async def verify_domain(self, domain: str) -> DomainVerification:
        data = await self._request(
            "POST",
            f"/agents/{self._identity.beam_id}/verify/domain",
            json={"domain": domain},
        )
        return DomainVerification.from_dict(data, fallback_domain=domain)

    async def check_domain_verification(self) -> DomainVerification:
        data = await self._request(
            "GET",
            f"/agents/{self._identity.beam_id}/verify/domain",
        )
        return DomainVerification.from_dict(data)

    async def rotate_keys(
        self,
        new_key_pair: BeamIdentity | BeamIdentityData,
    ) -> KeyRotationResult:
        identity = (
            new_key_pair
            if isinstance(new_key_pair, BeamIdentity)
            else BeamIdentity.from_data(new_key_pair)
        )
        data = await self._request(
            "POST",
            f"/agents/{self._identity.beam_id}/keys/rotate",
            json={"publicKey": identity.public_key_base64},
        )
        self._identity = identity
        return KeyRotationResult.from_dict(
            data,
            beam_id=self._identity.beam_id,
            public_key=self._identity.public_key_base64,
        )

    async def browse(
        self,
        page: int = 1,
        filters: Optional[BrowseFilters] = None,
    ) -> BrowseResult:
        params = {"page": str(page), **(filters.to_params() if filters else {})}
        try:
            data = await self._request("GET", "/agents/browse", params=params)
            agents = [
                AgentProfile.from_dict(agent)
                for agent in data.get("agents", [])
                if isinstance(agent, dict)
            ]
            return BrowseResult(
                page=data.get("page", page),
                page_size=data.get("pageSize", data.get("page_size", len(agents))),
                total=data.get("total", len(agents)),
                agents=agents,
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:
                raise
            search_query = None
            if filters and filters.capability:
                from .types import AgentSearchQuery

                search_query = AgentSearchQuery(capabilities=[filters.capability])
            agents = await self._directory.search(search_query)
            filtered = [
                AgentProfile.from_dict(
                    {
                        **agent.__dict__,
                        "verificationTier": "verified" if agent.verified else "basic",
                    }
                )
                for agent in agents
                if not filters or not filters.verified_only or agent.verified
            ]
            return BrowseResult(
                page=page,
                page_size=len(filtered),
                total=len(filtered),
                agents=filtered,
            )

    async def get_stats(self) -> DirectoryStats:
        data = await self._request("GET", "/stats")
        return DirectoryStats.from_dict(data)

    async def delegate(
        self,
        target_beam_id: str,
        scope: str,
        expires_in: Optional[int] = None,
    ) -> Delegation:
        data = await self._request(
            "POST",
            "/delegations",
            json={
                "sourceBeamId": self._identity.beam_id,
                "targetBeamId": target_beam_id,
                "scope": scope,
                "expiresIn": expires_in,
            },
        )
        return Delegation.from_dict(data)

    async def report(self, target_beam_id: str, reason: str) -> Report:
        data = await self._request(
            "POST",
            "/reports",
            json={
                "reporterBeamId": self._identity.beam_id,
                "targetBeamId": target_beam_id,
                "reason": reason,
            },
        )
        return Report.from_dict(data)

    async def send(
        self,
        to: BeamIdString,
        intent: str,
        params: Optional[dict[str, Any]] = None,
        timeout_ms: int = 30_000,
    ) -> ResultFrame:
        frame = create_intent_frame(
            intent=intent,
            from_id=self._identity.beam_id,
            to_id=to,
            params=params or {},
            identity=self._identity,
        )
        return await self._send_via_http(frame, timeout_ms)

    def on_intent(self, intent: str) -> Callable[[IntentHandler], IntentHandler]:
        def decorator(fn: IntentHandler) -> IntentHandler:
            self._intent_handlers[intent] = fn
            return fn

        return decorator

    async def handle_intent(self, frame: IntentFrame) -> ResultFrame:
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
            return await handler(frame)
        except Exception as exc:
            return create_result_frame(
                success=False,
                nonce=frame.nonce,
                error=str(exc),
                error_code="INTENT_HANDLER_ERROR",
                latency=int((time.time() - start) * 1000),
            )

    def thread(
        self,
        to: BeamIdString,
        *,
        language: str = "en",
        timeout_ms: int = 60_000,
    ) -> "BeamThread":
        return BeamThread(self, to, language=language, timeout_ms=timeout_ms)

    async def talk(
        self,
        to: BeamIdString,
        message: str,
        context: Optional[dict[str, Any]] = None,
        language: str = "en",
        timeout_ms: int = 60_000,
        thread_id: Optional[str] = None,
    ) -> dict[str, Any]:
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
            "threadId": (
                result.payload.get("threadId") if result.payload else thread_id
            ),
            "raw": result,
        }

    def on_talk(
        self,
        handler: Callable[
            [str, BeamIdString, IntentFrame],
            Coroutine[Any, Any, tuple[str, Optional[dict[str, Any]]]],
        ],
    ) -> None:
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

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, str]] = None,
        json: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient() as client:
            response = await client.request(
                method,
                f"{self._directory_url}{path}",
                params=params,
                json=json,
                headers={"Content-Type": "application/json"},
                timeout=30.0,
            )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise ValueError("Expected object response from directory")
        return body

    async def _send_via_http(
        self, frame: IntentFrame, timeout_ms: int
    ) -> ResultFrame:
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
    def __init__(
        self,
        client: BeamClient,
        to: BeamIdString,
        *,
        language: str = "en",
        timeout_ms: int = 60_000,
    ) -> None:
        self.thread_id = BeamIdentity.generate_nonce()
        self._client = client
        self._to = to
        self._language = language
        self._timeout_ms = timeout_ms

    async def say(
        self,
        message: str,
        context: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return await self._client.talk(
            self._to,
            message,
            context=context,
            language=self._language,
            timeout_ms=self._timeout_ms,
            thread_id=self.thread_id,
        )
