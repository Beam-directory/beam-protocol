"""Type definitions for the Beam Protocol Python SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# Beam ID format: agent@org.beam.directory
BeamIdString = str


@dataclass
class BeamIdentityData:
    """Serialisable Beam identity (public + private keys in base64)."""
    beam_id: BeamIdString
    public_key_base64: str   # SPKI DER, base64
    private_key_base64: str  # PKCS8 DER, base64

    def to_dict(self) -> dict[str, str]:
        return {
            "beamId": self.beam_id,
            "publicKeyBase64": self.public_key_base64,
            "privateKeyBase64": self.private_key_base64,
        }

    @classmethod
    def from_dict(cls, data: dict[str, str]) -> "BeamIdentityData":
        return cls(
            beam_id=data["beamId"],
            public_key_base64=data["publicKeyBase64"],
            private_key_base64=data["privateKeyBase64"],
        )


@dataclass
class IntentFrame:
    """An intent frame sent from one agent to another."""
    v: str                                # Protocol version: "1"
    intent: str                           # Intent name
    from_id: BeamIdString                 # Sender Beam ID
    to_id: BeamIdString                   # Recipient Beam ID
    params: dict[str, Any]               # Intent parameters
    nonce: str                            # UUID v4, replay protection
    timestamp: str                        # ISO 8601
    signature: Optional[str] = None       # Ed25519 base64

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "v": self.v,
            "intent": self.intent,
            "from": self.from_id,
            "to": self.to_id,
            "params": self.params,
            "nonce": self.nonce,
            "timestamp": self.timestamp,
        }
        if self.signature is not None:
            d["signature"] = self.signature
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IntentFrame":
        return cls(
            v=data["v"],
            intent=data["intent"],
            from_id=data["from"],
            to_id=data["to"],
            params=data.get("params", {}),
            nonce=data["nonce"],
            timestamp=data["timestamp"],
            signature=data.get("signature"),
        )


@dataclass
class ResultFrame:
    """A result frame returned after processing an intent."""
    v: str                                  # Protocol version: "1"
    success: bool
    nonce: str                              # Matches IntentFrame nonce
    timestamp: str
    payload: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    latency: Optional[int] = None          # milliseconds
    signature: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "v": self.v,
            "success": self.success,
            "nonce": self.nonce,
            "timestamp": self.timestamp,
        }
        if self.payload is not None:
            d["payload"] = self.payload
        if self.error is not None:
            d["error"] = self.error
        if self.error_code is not None:
            d["errorCode"] = self.error_code
        if self.latency is not None:
            d["latency"] = self.latency
        if self.signature is not None:
            d["signature"] = self.signature
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ResultFrame":
        return cls(
            v=data["v"],
            success=data["success"],
            nonce=data["nonce"],
            timestamp=data["timestamp"],
            payload=data.get("payload"),
            error=data.get("error"),
            error_code=data.get("errorCode"),
            latency=data.get("latency"),
            signature=data.get("signature"),
        )


@dataclass
class AgentRegistration:
    """Registration payload sent to a directory."""
    beam_id: BeamIdString
    display_name: str
    capabilities: list[str]
    public_key: str  # SPKI DER base64
    org: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "beamId": self.beam_id,
            "displayName": self.display_name,
            "capabilities": self.capabilities,
            "publicKey": self.public_key,
            "org": self.org,
        }


@dataclass
class AgentRecord(AgentRegistration):
    """Agent record as returned by the directory."""
    trust_score: float = 0.5    # 0.0-1.0
    verified: bool = False
    created_at: str = ""
    last_seen: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentRecord":
        return cls(
            beam_id=data["beamId"],
            display_name=data["displayName"],
            capabilities=data.get("capabilities", []),
            public_key=data["publicKey"],
            org=data["org"],
            trust_score=data.get("trustScore", 0.5),
            verified=data.get("verified", False),
            created_at=data.get("createdAt", ""),
            last_seen=data.get("lastSeen", ""),
        )


@dataclass
class AgentSearchQuery:
    """Query parameters for searching the directory."""
    org: Optional[str] = None
    capabilities: Optional[list[str]] = None
    min_trust_score: Optional[float] = None
    limit: int = 20

    def to_params(self) -> dict[str, str]:
        params: dict[str, str] = {"limit": str(self.limit)}
        if self.org:
            params["org"] = self.org
        if self.capabilities:
            params["capabilities"] = ",".join(self.capabilities)
        if self.min_trust_score is not None:
            params["minTrustScore"] = str(self.min_trust_score)
        return params


@dataclass
class DirectoryConfig:
    """Configuration for connecting to a Beam directory."""
    base_url: str
    api_key: Optional[str] = None


@dataclass
class BeamClientConfig:
    """Configuration for a Beam client."""
    identity: BeamIdentityData
    directory_url: str
