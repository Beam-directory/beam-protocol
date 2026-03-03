"""
Beam Directory Python SDK
=========================

SMTP for AI Agents — Python SDK for agent identity, registration,
discovery and intent routing via the Beam Protocol.

Quick start::

    from beam_directory import BeamIdentity, BeamDirectory, BeamClient

    # Generate an identity
    identity = BeamIdentity.generate(agent_name="myagent", org_name="myorg")

    # Register with a directory
    directory = BeamDirectory(base_url="https://dir.beam.directory")
    record = await directory.register(identity.to_registration("My Agent", ["query"]))

    # Send an intent
    client = BeamClient(identity=identity, directory_url="https://dir.beam.directory")
    result = await client.send("other@their.beam.directory", "query", {"q": "hello"})
"""

from .identity import BeamIdentity
from .directory import BeamDirectory, BeamDirectoryError
from .client import BeamClient
from .frames import create_intent_frame, create_result_frame, validate_intent_frame, validate_result_frame
from .types import (
    BeamIdentityData,
    IntentFrame,
    ResultFrame,
    AgentRegistration,
    AgentRecord,
    AgentSearchQuery,
    DirectoryConfig,
    BeamClientConfig,
)

__version__ = "0.1.0"
__all__ = [
    "BeamIdentity",
    "BeamDirectory",
    "BeamDirectoryError",
    "BeamClient",
    "create_intent_frame",
    "create_result_frame",
    "validate_intent_frame",
    "validate_result_frame",
    "BeamIdentityData",
    "IntentFrame",
    "ResultFrame",
    "AgentRegistration",
    "AgentRecord",
    "AgentSearchQuery",
    "DirectoryConfig",
    "BeamClientConfig",
]
