from __future__ import annotations

import unittest

from gemma import analyzer


class TestGemmaAnalyzerConfiguration(unittest.TestCase):
    def test_configure_strips_trailing_slash_from_host(self) -> None:
        analyzer.configure("http://localhost:11434/", "gemma4:e4b")

        self.assertEqual(analyzer._host, "http://localhost:11434")

    def test_configure_strips_repeated_trailing_slashes_from_host(self) -> None:
        analyzer.configure("http://localhost:11434///", "gemma4:e4b")

        self.assertEqual(analyzer._host, "http://localhost:11434")


if __name__ == "__main__":
    unittest.main()
