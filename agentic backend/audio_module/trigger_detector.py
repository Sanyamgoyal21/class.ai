"""
Trigger Word Detector for detecting doubt and resume keywords in transcripts.
"""

import re

# Trigger words for entering doubt mode
DOUBT_TRIGGERS = [
    "doubt",
    "i have a doubt",
    "i have a question",
    "question",
    "can you explain",
    "i don't understand",
    "i dont understand",
    "what does that mean",
    "please explain",
    "clarify",
    "confused",
    "help me understand",
]

# Trigger words for resuming video (exiting doubt mode)
RESUME_TRIGGERS = [
    "okay",
    "ok",
    "understood",
    "i understand",
    "i got it",
    "got it",
    "thank you",
    "thanks",
    "clear",
    "that's clear",
    "thats clear",
    "makes sense",
    "resume",
    "continue",
    "play",
]


class TriggerDetector:
    """Detects trigger words in transcripts for doubt mode state transitions."""

    def __init__(self, doubt_triggers=None, resume_triggers=None):
        """
        Initialize trigger detector.

        Args:
            doubt_triggers: Custom list of doubt trigger phrases
            resume_triggers: Custom list of resume trigger phrases
        """
        self.doubt_triggers = doubt_triggers or DOUBT_TRIGGERS
        self.resume_triggers = resume_triggers or RESUME_TRIGGERS

        # Compile regex patterns for efficient matching
        self._doubt_pattern = self._compile_pattern(self.doubt_triggers)
        self._resume_pattern = self._compile_pattern(self.resume_triggers)

    def _compile_pattern(self, triggers):
        """Compile a regex pattern from trigger phrases."""
        # Escape special chars and join with OR
        escaped = [re.escape(t.lower()) for t in triggers]
        # Use word boundaries for single words, looser matching for phrases
        patterns = []
        for t in escaped:
            if ' ' in t:
                patterns.append(t)  # Phrases match anywhere
            else:
                patterns.append(rf'\b{t}\b')  # Single words need boundaries
        return re.compile('|'.join(patterns), re.IGNORECASE)

    def detect_trigger(self, transcript):
        """
        Detect trigger type in transcript.

        Args:
            transcript: Text to analyze

        Returns:
            "doubt" if doubt trigger detected
            "resume" if resume trigger detected
            None if no trigger detected
        """
        if not transcript:
            return None

        text = transcript.lower().strip()

        # Check for doubt triggers first (higher priority)
        if self._doubt_pattern.search(text):
            return "doubt"

        # Check for resume triggers
        if self._resume_pattern.search(text):
            return "resume"

        return None

    def is_doubt_trigger(self, transcript):
        """Check if transcript contains a doubt trigger."""
        return self.detect_trigger(transcript) == "doubt"

    def is_resume_trigger(self, transcript):
        """Check if transcript contains a resume trigger."""
        return self.detect_trigger(transcript) == "resume"

    def extract_question(self, transcript):
        """
        Extract the actual question from transcript after removing trigger phrases.

        Args:
            transcript: Full transcript including trigger

        Returns:
            Cleaned question text
        """
        if not transcript:
            return ""

        text = transcript.strip()

        # Remove common prefixes
        prefixes_to_remove = [
            r"^(i have a (doubt|question)[,.]?\s*)",
            r"^((can you |please )?(explain|clarify)[,.]?\s*)",
            r"^(doubt[,.]?\s*)",
            r"^(question[,.]?\s*)",
        ]

        for pattern in prefixes_to_remove:
            text = re.sub(pattern, "", text, flags=re.IGNORECASE)

        return text.strip()


# Singleton instance
_detector_instance = None


def get_trigger_detector():
    """Get or create a shared TriggerDetector instance."""
    global _detector_instance
    if _detector_instance is None:
        _detector_instance = TriggerDetector()
    return _detector_instance


if __name__ == "__main__":
    # Test the trigger detector
    detector = TriggerDetector()

    test_phrases = [
        "I have a doubt about this topic",
        "Can you explain photosynthesis?",
        "What does that mean?",
        "I don't understand the equation",
        "Okay, I got it now",
        "Thank you, that's clear",
        "Resume the video please",
        "The weather is nice today",
        "question about gravity",
        "understood, thanks",
    ]

    print("Testing Trigger Detector:")
    print("-" * 50)

    for phrase in test_phrases:
        trigger = detector.detect_trigger(phrase)
        question = detector.extract_question(phrase) if trigger == "doubt" else ""
        print(f"'{phrase}'")
        print(f"  -> Trigger: {trigger or 'None'}")
        if question:
            print(f"  -> Question: {question}")
        print()
