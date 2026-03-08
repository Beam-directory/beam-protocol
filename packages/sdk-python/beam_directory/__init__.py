"""
Beam Directory Python SDK
=========================

SMTP for AI Agents — Python SDK for agent identity, registration,
discovery and intent routing via the Beam Protocol.
"""

from .identity import BeamIdentity
from .directory import BeamDirectory, BeamDirectoryError
from .client import BeamClient
from .frames import create_intent_frame, create_result_frame, validate_intent_frame, validate_result_frame
from .types import (
    AgentProfile,
    AgentRecord,
    AgentRegistration,
    AgentSearchQuery,
    BeamClientConfig,
    BeamIdentityData,
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
    VerificationTier,
)

__version__ = "0.5.0"
__all__ = [
    "BeamIdentity",
    "BeamDirectory",
    "BeamDirectoryError",
    "BeamClient",
    "create_intent_frame",
    "create_result_frame",
    "validate_intent_frame",
    "validate_result_frame",
    "AgentProfile",
    "AgentRecord",
    "AgentRegistration",
    "AgentSearchQuery",
    "BeamClientConfig",
    "BeamIdentityData",
    "BeamIdString",
    "BrowseFilters",
    "BrowseResult",
    "Delegation",
    "DirectoryConfig",
    "DirectoryStats",
    "DomainVerification",
    "IntentFrame",
    "KeyRotationResult",
    "Report",
    "ResultFrame",
    "VerificationTier",
]
