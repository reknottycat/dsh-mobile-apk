"""The snapshot injector must retain product failures as fatal after plugin replacement."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("inject_all", Path(__file__).with_name("inject-all.py"))
injector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(injector)


class AssembledManifestTest(unittest.TestCase):
    def fixture(self, manifest):
        return b"before\nconst DSH_MOBILE_ASSEMBLED_MANIFEST = " + json.dumps(manifest).encode() + b";\nafter\n"

    def test_adds_only_actual_injected_packages_and_keeps_existing_owners(self):
        original = self.fixture({"names": ["@deepseek-ai/dsh-web-app", "existing"], "complete": True})
        result = injector.rebase_assembled_manifest(original, {"@dsh-android/dsh-model-capability"})
        self.assertIn(b'"@deepseek-ai/dsh-web-app"', result)
        self.assertIn(b'"existing"', result)
        self.assertIn(b'"@dsh-android/dsh-model-capability"', result)
        self.assertNotIn(b'"@deepseek-ai/dsh-mcp-client"', result)
        self.assertIn(b'"complete":true', result)
        self.assertTrue(result.startswith(b"before\n"))
        self.assertTrue(result.endswith(b";\nafter\n"))
        self.assertEqual(result, injector.rebase_assembled_manifest(result, {"@dsh-android/dsh-model-capability"}))

    def test_incomplete_manifest_cannot_be_promoted_by_plugin_injection(self):
        result = injector.rebase_assembled_manifest(self.fixture({"names": [], "complete": False}), {"shipped"})
        self.assertIn(b'"complete":false', result)

    def test_unknown_or_ambiguous_source_fails_closed(self):
        with self.assertRaises(ValueError):
            injector.rebase_assembled_manifest(b"unreviewed source", {"shipped"})
        valid = self.fixture({"names": [], "complete": True})
        with self.assertRaises(ValueError):
            injector.rebase_assembled_manifest(valid + valid, {"shipped"})
        with self.assertRaises(ValueError):
            injector.rebase_assembled_manifest(self.fixture({"names": [None], "complete": True}), {"shipped"})


if __name__ == "__main__":
    unittest.main()
