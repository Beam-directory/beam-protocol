"""High-level Beam wrapper for CrewAI applications."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from ._runtime import run_sync

if TYPE_CHECKING:
    from beam_directory.client import BeamClient


@dataclass(slots=True)
class BeamAgent:
    """Thin wrapper around the Beam Protocol Python SDK."""

    client: Any
    default_recipient: str | None = None

    @classmethod
    def create(
        cls,
        *,
        agent_name: str,
        org_name: str,
        directory_url: str,
        default_recipient: str | None = None,
    ) -> "BeamAgent":
        """Create a new Beam identity and client."""

        from beam_directory.client import BeamClient
        from beam_directory.identity import BeamIdentity

        identity = BeamIdentity.generate(agent_name=agent_name, org_name=org_name)
        client = BeamClient(identity=identity, directory_url=directory_url)
        return cls(client=client, default_recipient=default_recipient)

    @classmethod
    def from_identity_data(
        cls,
        *,
        identity_data: Any,
        directory_url: str,
        default_recipient: str | None = None,
    ) -> "BeamAgent":
        """Rebuild a Beam wrapper from exported Beam identity data."""

        from beam_directory.client import BeamClient
        from beam_directory.identity import BeamIdentity

        identity = BeamIdentity.from_data(identity_data)
        client = BeamClient(identity=identity, directory_url=directory_url)
        return cls(client=client, default_recipient=default_recipient)

    @property
    def beam_id(self) -> str:
        """Return the local Beam identity string."""

        return self.client.beam_id

    def _resolve_recipient(self, to: str | None) -> str:
        recipient = to or self.default_recipient
        if not recipient:
            raise ValueError("A Beam recipient is required")
        return recipient

    async def register(
        self,
        display_name: str,
        capabilities: Optional[list[str]] = None,
    ) -> Any:
        """Register the local agent in the Beam directory."""

        return await self.client.register(display_name, capabilities or [])

    def register_sync(
        self,
        display_name: str,
        capabilities: Optional[list[str]] = None,
    ) -> Any:
        """Synchronous wrapper around :meth:`register`."""

        return run_sync(self.register(display_name, capabilities))

    async def send_intent(
        self,
        *,
        intent: str,
        params: Optional[dict[str, Any]] = None,
        to: str | None = None,
        timeout_ms: int = 30_000,
    ) -> Any:
        """Send a Beam intent frame to another agent."""

        recipient = self._resolve_recipient(to)
        return await self.client.send(
            to=recipient,
            intent=intent,
            params=params or {},
            timeout_ms=timeout_ms,
        )

    def send_intent_sync(
        self,
        *,
        intent: str,
        params: Optional[dict[str, Any]] = None,
        to: str | None = None,
        timeout_ms: int = 30_000,
    ) -> Any:
        """Synchronous wrapper around :meth:`send_intent`."""

        return run_sync(
            self.send_intent(
                intent=intent,
                params=params,
                to=to,
                timeout_ms=timeout_ms,
            )
        )

    async def talk(
        self,
        message: str,
        *,
        to: str | None = None,
        context: Optional[dict[str, Any]] = None,
        language: str = "en",
        timeout_ms: int = 60_000,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Send a natural-language Beam message to another agent."""

        recipient = self._resolve_recipient(to)
        return await self.client.talk(
            to=recipient,
            message=message,
            context=context,
            language=language,
            timeout_ms=timeout_ms,
            thread_id=thread_id,
        )

    def talk_sync(
        self,
        message: str,
        *,
        to: str | None = None,
        context: Optional[dict[str, Any]] = None,
        language: str = "en",
        timeout_ms: int = 60_000,
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Synchronous wrapper around :meth:`talk`."""

        return run_sync(
            self.talk(
                message,
                to=to,
                context=context,
                language=language,
                timeout_ms=timeout_ms,
                thread_id=thread_id,
            )
        )

    def thread(
        self,
        *,
        to: str | None = None,
        language: str = "en",
        timeout_ms: int = 60_000,
    ) -> Any:
        """Create a Beam conversation thread."""

        recipient = self._resolve_recipient(to)
        return self.client.thread(recipient, language=language, timeout_ms=timeout_ms)

