"""
AI Module for local AI inference on classroom devices.

Provides local Ollama integration for student doubt resolution.
"""

from .local_ollama import LocalOllama, get_local_ollama

__all__ = ["LocalOllama", "get_local_ollama"]
