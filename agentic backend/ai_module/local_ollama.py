"""
Local Ollama AI Client for classroom doubt resolution.

Runs AI inference directly on the classroom device for low-latency,
offline-capable doubt resolution.
"""

import os
import time
import requests
from typing import Optional, Dict, Any


# Configuration from environment or defaults
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "phi")  # Small, fast model
OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "30"))  # seconds
OLLAMA_RETRY_INTERVAL = 60  # seconds before retrying after failure


# Doubt mode system prompt (matches backend/ai-orchestrator.js for consistency)
DOUBT_SYSTEM_PROMPT = """You are an AI Classroom Doubt Assistant integrated into a live classroom video system.

Your role is to answer student doubts based on the currently playing educational video.

Rules:
- Keep answers simple, clear, and classroom-friendly
- Use step-by-step explanations when needed
- Stay within the context of the video topic if provided
- Be concise - no emojis, no markdown formatting
- If the doubt is unclear, ask ONE short clarifying question only
- Do NOT introduce unrelated topics
- Speak like a teacher helping during a live class

If video context is provided, use it to give relevant answers.
If no context is available, answer the question to the best of your ability."""


class LocalOllama:
    """Local Ollama client for classroom AI inference."""

    def __init__(
        self,
        url: str = None,
        model: str = None,
        timeout: int = None,
    ):
        """
        Initialize Local Ollama client.

        Args:
            url: Ollama API URL (default: http://localhost:11434)
            model: Model to use (default: phi - small and fast)
            timeout: Request timeout in seconds (default: 30)
        """
        self.url = url or OLLAMA_URL
        self.model = model or OLLAMA_MODEL
        self.timeout = timeout or OLLAMA_TIMEOUT

        self._healthy = None  # None = unknown, True/False = known state
        self._last_health_check = 0
        self._health_check_interval = OLLAMA_RETRY_INTERVAL

    def check_health(self, force: bool = False) -> bool:
        """
        Check if Ollama is available.

        Args:
            force: Force a fresh health check even if cached

        Returns:
            True if Ollama is healthy, False otherwise
        """
        now = time.time()

        # Return cached result if recent enough
        if not force and self._healthy is not None:
            if now - self._last_health_check < self._health_check_interval:
                return self._healthy

        try:
            response = requests.get(
                f"{self.url}/api/tags",
                timeout=5
            )
            self._healthy = response.ok
        except requests.RequestException:
            self._healthy = False

        self._last_health_check = now
        return self._healthy

    def generate(
        self,
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generate AI response for student doubt.

        Args:
            prompt: Student's question
            context: Video context (title, topic, url, etc.)
            system_prompt: Custom system prompt (uses DOUBT_SYSTEM_PROMPT if None)

        Returns:
            Dict with:
                - success: bool
                - response: str (AI response or error message)
                - source: str ("local-ollama")
                - latency_ms: int
        """
        start_time = time.time()

        # Build the full prompt
        full_prompt = self._build_doubt_prompt(prompt, context, system_prompt)

        try:
            response = requests.post(
                f"{self.url}/api/generate",
                json={
                    "model": self.model,
                    "prompt": full_prompt,
                    "temperature": 0.4,
                    "stream": False,
                },
                timeout=self.timeout
            )

            latency_ms = int((time.time() - start_time) * 1000)

            if not response.ok:
                self._healthy = False
                return {
                    "success": False,
                    "response": f"Ollama returned error: {response.status_code}",
                    "source": "local-ollama",
                    "latency_ms": latency_ms,
                }

            data = response.json()
            ai_response = data.get("response", "").strip()

            if not ai_response:
                return {
                    "success": False,
                    "response": "I could not generate a response. Please try again.",
                    "source": "local-ollama",
                    "latency_ms": latency_ms,
                }

            self._healthy = True
            return {
                "success": True,
                "response": ai_response,
                "source": "local-ollama",
                "latency_ms": latency_ms,
            }

        except requests.Timeout:
            latency_ms = int((time.time() - start_time) * 1000)
            self._healthy = False
            return {
                "success": False,
                "response": "The AI is taking too long to respond. Please try again.",
                "source": "local-ollama",
                "latency_ms": latency_ms,
            }
        except requests.RequestException as e:
            latency_ms = int((time.time() - start_time) * 1000)
            self._healthy = False
            return {
                "success": False,
                "response": f"Could not connect to AI: {str(e)}",
                "source": "local-ollama",
                "latency_ms": latency_ms,
            }

    def _build_doubt_prompt(
        self,
        question: str,
        context: Optional[Dict[str, Any]] = None,
        system_prompt: Optional[str] = None,
    ) -> str:
        """
        Build contextual prompt for doubt resolution.

        Args:
            question: Student's question
            context: Video context dict
            system_prompt: Custom system prompt

        Returns:
            Complete prompt string
        """
        prompt_parts = []

        # System prompt
        system = system_prompt or DOUBT_SYSTEM_PROMPT
        prompt_parts.append(f"SYSTEM: {system}")

        # Video context if available
        if context:
            context_parts = []
            if context.get("video_topic"):
                context_parts.append(f"Current Topic: {context['video_topic']}")
            if context.get("video_title"):
                context_parts.append(f"Video: {context['video_title']}")
            if context.get("video_url"):
                context_parts.append(f"Source: {context['video_url']}")

            if context_parts:
                prompt_parts.append(f"\nVideo Context:\n" + "\n".join(context_parts))

        # Student's question
        prompt_parts.append(f"\nUSER: {question}")
        prompt_parts.append("\nASSISTANT:")

        return "\n".join(prompt_parts)

    def is_available(self) -> bool:
        """Check if local Ollama is available (alias for check_health)."""
        return self.check_health()


# Singleton instance
_local_ollama_instance = None


def get_local_ollama(
    url: str = None,
    model: str = None,
    timeout: int = None,
) -> LocalOllama:
    """
    Get or create a shared LocalOllama instance.

    Args:
        url: Ollama API URL
        model: Model to use
        timeout: Request timeout

    Returns:
        LocalOllama instance
    """
    global _local_ollama_instance

    if _local_ollama_instance is None:
        _local_ollama_instance = LocalOllama(url=url, model=model, timeout=timeout)

    return _local_ollama_instance


if __name__ == "__main__":
    # Test the local Ollama client
    print("Testing Local Ollama Client")
    print("=" * 50)

    ollama = LocalOllama()

    # Test health check
    print(f"\nOllama URL: {ollama.url}")
    print(f"Model: {ollama.model}")
    print(f"Timeout: {ollama.timeout}s")

    print("\nChecking health...")
    is_healthy = ollama.check_health(force=True)
    print(f"Ollama healthy: {is_healthy}")

    if is_healthy:
        # Test generation
        print("\nTesting generation...")
        context = {
            "video_title": "Photosynthesis Explained",
            "video_topic": "Biology - Photosynthesis",
        }

        result = ollama.generate(
            prompt="What is the role of chlorophyll in photosynthesis?",
            context=context,
        )

        print(f"\nSuccess: {result['success']}")
        print(f"Source: {result['source']}")
        print(f"Latency: {result['latency_ms']}ms")
        print(f"\nResponse:\n{result['response']}")
    else:
        print("\nOllama is not available. Make sure Ollama is running:")
        print("  1. Install Ollama: https://ollama.ai")
        print("  2. Pull a model: ollama pull phi")
        print("  3. Start Ollama: ollama serve")
