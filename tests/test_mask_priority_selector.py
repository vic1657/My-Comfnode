from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import types
import unittest

import torch


ROOT = Path(__file__).resolve().parents[1]

comfy_api = types.ModuleType("comfy_api")
latest = types.ModuleType("comfy_api.latest")
latest.io = types.SimpleNamespace(ComfyNode=object)
comfy_api.latest = latest
sys.modules["comfy_api"] = comfy_api
sys.modules["comfy_api.latest"] = latest

MODULE_PATH = ROOT / "mask_priority_selector.py"
SPEC = importlib.util.spec_from_file_location("mask_priority_selector_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class MaskPrioritySelectorTests(unittest.TestCase):
    def test_uses_numeric_interface_order_and_skips_blank_masks(self):
        mask2 = torch.full((1, 4, 6), 0.75)
        mask10 = torch.full((1, 4, 6), 0.25)

        result = MODULE.select_priority_mask(
            {
                "mask10": mask10,
                "mask2": mask2,
                "mask1": torch.zeros((1, 4, 6)),
                "mask0": None,
            }
        )

        self.assertIs(result, mask2)

    def test_all_blank_masks_return_first_connected_shape(self):
        first = torch.zeros((2, 7, 9), dtype=torch.float16)
        later = torch.zeros((1, 3, 5))

        result = MODULE.select_priority_mask({"mask1": later, "mask0": first})

        self.assertIs(result, first)
        self.assertEqual(tuple(result.shape), (2, 7, 9))
        self.assertEqual(result.dtype, torch.float16)

    def test_missing_inputs_return_safe_black_mask(self):
        result = MODULE.select_priority_mask(None)

        self.assertEqual(tuple(result.shape), (1, 64, 64))
        self.assertEqual(result.dtype, torch.float32)
        self.assertEqual(int(torch.count_nonzero(result)), 0)

    def test_two_dimensional_mask_is_normalized_to_batch_shape(self):
        result = MODULE.select_priority_mask({"mask0": torch.ones((5, 8))})

        self.assertEqual(tuple(result.shape), (1, 5, 8))


if __name__ == "__main__":
    unittest.main()
