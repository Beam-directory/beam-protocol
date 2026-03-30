"""Type definitions for the Beam Protocol Python SDK."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

BeamIdString = str
VerificationTier = Literal["basic", "verified", "business", "enterprise"]
VerificationStatus = Literal["pending", "verified", "failed", "unverified"]


@dataclass
class BeamIdentityData:
    beam_id: BeamIdString
    public_key_base64: str
    private_key_base64: str

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
    v: str
    intent: str
    from_id: BeamIdString
    to_id: BeamIdString
    params: dict[str, Any]
    nonce: str
    timestamp: str
    signature: Optional[str] = None
    extra_fields: dict[str, Any] = field(default_factory=dict)

    @property
    def payload(self) -> dict[str, Any]:
        return self.params

    @payload.setter
    def payload(self, value: dict[str, Any]) -> None:
        self.params = value

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "v": self.v,
            "intent": self.intent,
            "from": self.from_id,
            "to": self.to_id,
            "payload": self.params,
            "nonce": self.nonce,
            "timestamp": self.timestamp,
        }
        if self.signature is not None:
            data["signature"] = self.signature
        data.update(self.extra_fields)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "IntentFrame":
        payload = data.get("payload")
        params = payload if isinstance(payload, dict) else data.get("params", {})
        known_fields = {"v", "intent", "from", "to", "payload", "params", "nonce", "timestamp", "signature"}
        return cls(
            v=data["v"],
            intent=data["intent"],
            from_id=data["from"],
            to_id=data["to"],
            params=params if isinstance(params, dict) else {},
            nonce=data["nonce"],
            timestamp=data["timestamp"],
            signature=data.get("signature"),
            extra_fields={key: value for key, value in data.items() if key not in known_fields},
        )


@dataclass
class ResultFrame:
    v: str
    success: bool
    nonce: str
    timestamp: str
    payload: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    error_code: Optional[str] = None
    latency: Optional[int] = None
    signature: Optional[str] = None
    extra_fields: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "v": self.v,
            "success": self.success,
            "nonce": self.nonce,
            "timestamp": self.timestamp,
        }
        if self.payload is not None:
            data["payload"] = self.payload
        if self.error is not None:
            data["error"] = self.error
        if self.error_code is not None:
            data["errorCode"] = self.error_code
        if self.latency is not None:
            data["latency"] = self.latency
        if self.signature is not None:
            data["signature"] = self.signature
        data.update(self.extra_fields)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ResultFrame":
        known_fields = {"v", "success", "nonce", "timestamp", "payload", "error", "errorCode", "latency", "signature"}
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
            extra_fields={key: value for key, value in data.items() if key not in known_fields},
        )


@dataclass
class AgentRegistration:
    beam_id: BeamIdString
    display_name: str
    capabilities: list[str]
    public_key: str
    org: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "beamId": self.beam_id,
            "displayName": self.display_name,
            "capabilities": self.capabilities,
            "publicKey": self.public_key,
        }
        if self.org is not None:
            data["org"] = self.org
        return data


@dataclass
class AgentRecord(AgentRegistration):
    trust_score: float = 0.5
    verified: bool = False
    created_at: str = ""
    last_seen: str = ""
    key_state: Optional["AgentKeyState"] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentRecord":
        return cls(
            beam_id=data.get("beamId") or data.get("beam_id") or "",
            display_name=data.get("displayName") or data.get("display_name") or "",
            capabilities=data.get("capabilities", []),
            public_key=data.get("publicKey") or data.get("public_key") or "",
            org=data.get("org"),
            trust_score=data.get("trustScore", data.get("trust_score", 0.5)),
            verified=data.get("verified", False),
            created_at=data.get("createdAt", data.get("created_at", "")),
            last_seen=data.get("lastSeen", data.get("last_seen", "")),
            key_state=AgentKeyState.from_dict(data.get("keyState")) if isinstance(data.get("keyState"), dict) else None,
        )


@dataclass
class AgentProfile(AgentRecord):
    description: Optional[str] = None
    logo_url: Optional[str] = None
    website: Optional[str] = None
    verification_tier: Optional[VerificationTier] = None
    verification_status: Optional[VerificationStatus] = None
    domain: Optional[str] = None
    intents_handled: Optional[int] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentProfile":
        base = AgentRecord.from_dict(data)
        return cls(
            **asdict(base),
            description=data.get("description"),
            logo_url=data.get("logoUrl", data.get("logo_url")),
            website=data.get("website"),
            verification_tier=data.get("verificationTier", data.get("verification_tier", data.get("tier"))),
            verification_status=data.get("verificationStatus", data.get("verification_status", data.get("status"))),
            domain=data.get("domain"),
            intents_handled=data.get("intentsHandled", data.get("intents_handled")),
        )


@dataclass
class BrowseFilters:
    capability: Optional[str] = None
    tier: Optional[VerificationTier] = None
    verified_only: Optional[bool] = None

    def to_params(self) -> dict[str, str]:
        params: dict[str, str] = {}
        if self.capability:
            params["capability"] = self.capability
        if self.tier:
            params["tier"] = self.tier
        if self.verified_only is not None:
            params["verified_only"] = "true" if self.verified_only else "false"
        return params


@dataclass
class BrowseResult:
    page: int
    page_size: int
    total: int
    agents: list[AgentProfile]


@dataclass
class DirectoryStats:
    total_agents: int
    verified_agents: int
    intents_processed: int
    consumer_agents: Optional[int] = None
    uptime: Optional[int] = None
    waitlist_size: Optional[int] = None
    version: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DirectoryStats":
        return cls(
            total_agents=data.get("totalAgents", data.get("total_agents", data.get("agents", 0))),
            verified_agents=data.get("verifiedAgents", data.get("verified_agents", data.get("verified", 0))),
            intents_processed=data.get("intentsProcessed", data.get("intents_processed", data.get("intents", 0))),
            consumer_agents=data.get("consumerAgents", data.get("consumer_agents")),
            uptime=data.get("uptime"),
            waitlist_size=data.get("waitlistSize", data.get("waitlist_size")),
            version=data.get("version"),
        )


@dataclass
class Delegation:
    source_beam_id: BeamIdString
    target_beam_id: BeamIdString
    scope: str
    id: Optional[str] = None
    expires_at: Optional[str] = None
    created_at: Optional[str] = None
    status: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Delegation":
        return cls(
            id=data.get("id"),
            source_beam_id=data.get("sourceBeamId", data.get("source_beam_id", data.get("from", ""))),
            target_beam_id=data.get("targetBeamId", data.get("target_beam_id", data.get("to", ""))),
            scope=data.get("scope", ""),
            expires_at=data.get("expiresAt", data.get("expires_at")),
            created_at=data.get("createdAt", data.get("created_at")),
            status=data.get("status"),
        )


@dataclass
class Report:
    reporter_beam_id: BeamIdString
    target_beam_id: BeamIdString
    reason: str
    id: Optional[str] = None
    created_at: Optional[str] = None
    status: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Report":
        return cls(
            id=data.get("id"),
            reporter_beam_id=data.get("reporterBeamId", data.get("reporter_beam_id", data.get("from", ""))),
            target_beam_id=data.get("targetBeamId", data.get("target_beam_id", data.get("to", ""))),
            reason=data.get("reason", ""),
            created_at=data.get("createdAt", data.get("created_at")),
            status=data.get("status"),
        )


@dataclass
class DomainVerification:
    domain: str
    verified: bool
    status: Optional[str] = None
    tier: Optional[VerificationTier] = None
    txt_name: Optional[str] = None
    txt_value: Optional[str] = None
    expected: Optional[str] = None
    records: Optional[list[str]] = None
    checked_at: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any], fallback_domain: str = "") -> "DomainVerification":
        return cls(
            domain=data.get("domain", fallback_domain),
            verified=data.get("verified", False),
            status=data.get("status", data.get("errorCode", data.get("error_code"))),
            tier=data.get("tier", data.get("verificationTier", data.get("verification_tier"))),
            txt_name=data.get("txtName", data.get("txt_name")),
            txt_value=data.get("txtValue", data.get("txt_value")),
            expected=data.get("expected"),
            records=data.get("records"),
            checked_at=data.get("checkedAt", data.get("checked_at")),
        )


@dataclass
class KeyRotationResult:
    beam_id: BeamIdString
    public_key: str
    rotated_at: Optional[str] = None
    previous_key: Optional[str] = None
    key_state: Optional["AgentKeyState"] = None

    @classmethod
    def from_dict(
        cls,
        data: dict[str, Any],
        beam_id: BeamIdString,
        public_key: str,
    ) -> "KeyRotationResult":
        return cls(
            beam_id=data.get("beamId", data.get("beam_id", beam_id)),
            public_key=data.get("publicKey", data.get("public_key", public_key)),
            rotated_at=data.get("rotatedAt", data.get("rotated_at")),
            previous_key=data.get("previousKey", data.get("previous_key")),
            key_state=AgentKeyState.from_dict(data["keyState"]) if isinstance(data.get("keyState"), dict) else None,
        )


@dataclass
class AgentKeyRecord:
    beam_id: BeamIdString
    public_key: str
    created_at: int
    revoked_at: Optional[int]
    status: Literal["active", "revoked"]
    id: Optional[int] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentKeyRecord":
        return cls(
            id=data.get("id"),
            beam_id=data.get("beamId", data.get("beam_id", "")),
            public_key=data.get("publicKey", data.get("public_key", "")),
            created_at=data.get("createdAt", data.get("created_at", 0)),
            revoked_at=data.get("revokedAt", data.get("revoked_at")),
            status="revoked" if data.get("status") == "revoked" else "active",
        )


@dataclass
class AgentKeyState:
    active: Optional[AgentKeyRecord]
    revoked: list[AgentKeyRecord]
    keys: list[AgentKeyRecord]
    total: int

    @classmethod
    def from_dict(cls, data: Optional[dict[str, Any]]) -> "AgentKeyState":
        if not isinstance(data, dict):
            return cls(active=None, revoked=[], keys=[], total=0)

        keys = [AgentKeyRecord.from_dict(entry) for entry in data.get("keys", []) if isinstance(entry, dict)]
        revoked = [AgentKeyRecord.from_dict(entry) for entry in data.get("revoked", []) if isinstance(entry, dict)]
        active_raw = data.get("active")
        active = AgentKeyRecord.from_dict(active_raw) if isinstance(active_raw, dict) else None
        return cls(
            active=active,
            revoked=revoked,
            keys=keys,
            total=data.get("total", len(keys)),
        )


@dataclass
class KeyRevocationResult:
    beam_id: BeamIdString
    revoked: bool
    revoked_key: Optional[AgentKeyRecord]
    key_state: AgentKeyState

    @classmethod
    def from_dict(cls, data: dict[str, Any], beam_id: BeamIdString) -> "KeyRevocationResult":
        revoked_key = data.get("revokedKey", data.get("revoked_key"))
        return cls(
            beam_id=data.get("beamId", data.get("beam_id", beam_id)),
            revoked=bool(data.get("revoked", False)),
            revoked_key=AgentKeyRecord.from_dict(revoked_key) if isinstance(revoked_key, dict) else None,
            key_state=AgentKeyState.from_dict(data.get("keyState")),
        )


@dataclass
class AgentSearchQuery:
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
    base_url: str
    api_key: Optional[str] = None


@dataclass
class BeamClientConfig:
    identity: BeamIdentityData
    directory_url: str
