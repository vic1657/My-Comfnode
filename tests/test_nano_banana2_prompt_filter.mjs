import assert from "node:assert/strict";
import { buildIndependentPrompt } from "../web/nano_banana2_prompt_filter.mjs";

const prompt = {
  1: { class_type: "LoadImage", inputs: {} },
  2: { class_type: "MyNanoBanana2API", inputs: { image: [1, 0] } },
  3: { class_type: "PreviewImage", inputs: { images: [2, 0] } },
  4: { class_type: "StringDisplay", inputs: { text: [2, 1] } },
  5: { class_type: "CompareImages", inputs: { left: [2, 0], right: [6, 0] } },
  6: { class_type: "LoadImage", inputs: {} },
  7: { class_type: "SaveImage", inputs: { images: [5, 0] } },
  8: { class_type: "UnrelatedSampler", inputs: { model: [9, 0] } },
  9: { class_type: "CheckpointLoader", inputs: {} },
};

const filtered = buildIndependentPrompt(2, prompt);
assert.deepEqual(
  Object.keys(filtered).sort(),
  ["1", "2", "3", "4", "5", "6", "7"],
);
assert.equal(filtered[3].class_type, "PreviewImage");
assert.equal(filtered[6].class_type, "LoadImage");
assert.equal(filtered[8], undefined);
assert.equal(filtered[9], undefined);

console.log("nano_banana2_prompt_filter: ok");
