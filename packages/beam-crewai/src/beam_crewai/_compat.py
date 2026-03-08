"""Compatibility helpers for optional CrewAI and Pydantic imports."""

from __future__ import annotations

from typing import Any, Callable


try:
    from crewai.tools import BaseTool
except Exception:
    class BaseTool:
        """Minimal fallback when CrewAI is unavailable during local testing."""

        name = "tool"
        description = ""
        args_schema: type[Any] | None = None

        def __init__(self, **kwargs: Any) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)


try:
    from pydantic import BaseModel, Field
except Exception:
    class BaseModel:
        """Minimal fallback when Pydantic is unavailable during local testing."""

        def __init__(self, **kwargs: Any) -> None:
            for key, value in kwargs.items():
                setattr(self, key, value)

        def model_dump(self) -> dict[str, Any]:
            return dict(self.__dict__)

    def Field(default: Any = None, **_: Any) -> Any:
        return default


def model_field(default: Any = None, **kwargs: Any) -> Any:
    """Return a field definition compatible with Pydantic or test fallbacks."""

    return Field(default, **kwargs)

