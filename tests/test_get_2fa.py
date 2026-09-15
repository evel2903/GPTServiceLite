import logging
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "core"))
import get_2fa

SECRET = "JBSWY3DPEHPK3PXP"


class TestGet2fa(unittest.TestCase):
    def test_extract_from_full_combo(self):
        clean, email, raw = get_2fa.extract_secret_and_tag(f"user@example.com|password123|{SECRET}")
        self.assertEqual(clean, SECRET)
        self.assertEqual(email, "user@example.com")

    def test_extract_from_secret_only(self):
        clean, email, raw = get_2fa.extract_secret_and_tag(f"  {SECRET}  ")
        self.assertEqual(clean, SECRET)
        self.assertEqual(email, "")

    def test_extract_from_spaced_secret(self):
        spaced = "JBSW Y3DP EHPK 3PXP"
        clean, email, raw = get_2fa.extract_secret_and_tag(spaced)
        self.assertEqual(clean, SECRET)

    def test_get_2fa_code_generates_valid_6_digits(self):
        res = get_2fa.get_2fa_code(f"user@example.com|pass|{SECRET}")
        self.assertTrue(res["ok"])
        self.assertEqual(len(res["code"]), 6)
        self.assertTrue(res["code"].isdigit())
        self.assertGreaterEqual(res["remaining"], 1)
        self.assertLessEqual(res["remaining"], 30)

    def test_get_2fa_code_invalid_secret(self):
        res = get_2fa.get_2fa_code("invalid_not_base32_999999999999999999999")
        self.assertFalse(res["ok"])
        self.assertIn("error", res)

    def test_selfcheck(self):
        self.assertEqual(get_2fa._selfcheck(), 0)


if __name__ == "__main__":
    unittest.main()
