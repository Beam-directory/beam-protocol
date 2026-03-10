"""BeamDirectory — HTTP client for the Beam Directory REST API."""

from __future__ import annotations

from typing import Any, Optional

import httpx

from .types import (
    AgentRecord,
    AgentRegistration,
    AgentSearchQuery,
    BeamIdString,
    DirectoryConfig,
)


class BeamDirectoryError(Exception):
    """Raised when the directory returns an error response."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


class BeamDirectory:
    """
    HTTP client for the Beam Directory REST API.

    Usage::

        dir = BeamDirectory(DirectoryConfig(base_url="https://api.beam.directory"))
        record = await dir.register(registration)
        agent  = await dir.lookup("jarvis@yourorg.beam.directory")
        agents = await dir.search(AgentSearchQuery(org="yourorg"))
    """

    def __init__(self, config: DirectoryConfig) -> None:
        self._base_url = config.base_url.rstrip("/")
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        if config.api_key:
            self._headers["Authorization"] = f"Bearer {config.api_key}"

    # ── Registration ───────────────────────────────────────────────────────────

    async def register(self, registration: AgentRegistration) -> AgentRecord:
        """Register an agent with the directory."""
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{self._base_url}/agents/register",
                json=registration.to_dict(),
                headers=self._headers,
                timeout=30.0,
            )
        self._raise_for_status(res, "Registration failed")
        return AgentRecord.from_dict(res.json())

    # ── Lookup ─────────────────────────────────────────────────────────────────

    async def lookup(self, beam_id: BeamIdString) -> Optional[AgentRecord]:
        """Look up an agent by Beam ID. Returns None if not found."""
        async with httpx.AsyncClient() as client:
            res = await client.get(
                f"{self._base_url}/agents/{beam_id}",
                headers=self._headers,
                timeout=10.0,
            )
        if res.status_code == 404:
            return None
        self._raise_for_status(res, "Lookup failed")
        return AgentRecord.from_dict(res.json())

    # ── Search ─────────────────────────────────────────────────────────────────

    async def search(self, query: Optional[AgentSearchQuery] = None) -> list[AgentRecord]:
        """Search agents. Returns a list of matching AgentRecords."""
        params = (query or AgentSearchQuery()).to_params()
        async with httpx.AsyncClient() as client:
            res = await client.get(
                f"{self._base_url}/agents/search",
                params=params,
                headers=self._headers,
                timeout=10.0,
            )
        self._raise_for_status(res, "Search failed")
        body: Any = res.json()
        if isinstance(body, list):
            return [AgentRecord.from_dict(a) for a in body]
        # Handle { agents: [...] } envelope
        agents = body.get("agents", [])
        return [AgentRecord.from_dict(a) for a in agents]

    # ── Heartbeat ──────────────────────────────────────────────────────────────

    async def heartbeat(self, beam_id: BeamIdString) -> None:
        """Send a heartbeat to keep the agent's lastSeen timestamp fresh."""
        async with httpx.AsyncClient() as client:
            res = await client.post(
                f"{self._base_url}/agents/{beam_id}/heartbeat",
                headers=self._headers,
                timeout=5.0,
            )
        if res.status_code not in (200, 204, 404):
            self._raise_for_status(res, "Heartbeat failed")

    # ── Private helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _raise_for_status(res: httpx.Response, prefix: str) -> None:
        if not res.is_success:
            try:
                body = res.json()
                msg = body.get("error", res.text)
            except Exception:
                msg = res.text
            raise BeamDirectoryError(f"{prefix}: {msg}", res.status_code)
