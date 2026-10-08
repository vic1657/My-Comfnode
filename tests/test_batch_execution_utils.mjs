import assert from "node:assert/strict";
import test from "node:test";

import { isolatePromptBranch, moveItem } from "../web/batch_execution_utils.mjs";

test("只保留发起批量节点的下游分支和该分支依赖", () => {
  const promptData = {
    output: {
      "1": { inputs: { text: "共享提示词" }, class_type: "Text" },
      "10": { inputs: { image_data: "A" }, class_type: "BatchLoader" },
      "11": { inputs: { image: ["10", 2] }, class_type: "Resize" },
      "12": { inputs: { image: ["11", 0], prompt: ["1", 0] }, class_type: "RH" },
      "13": { inputs: { images: ["12", 0] }, class_type: "Save" },
      "20": { inputs: { image_data: "B" }, class_type: "BatchLoader" },
      "21": { inputs: { image: ["20", 2] }, class_type: "Resize" },
      "22": { inputs: { image: ["21", 0], prompt: ["1", 0] }, class_type: "RH" },
      "23": { inputs: { images: ["22", 0] }, class_type: "Save" },
    },
  };

  isolatePromptBranch(promptData, 20);
  assert.deepEqual(Object.keys(promptData.output).sort(), ["1", "20", "21", "22", "23"]);
});

test("不同批量节点隔离后不会包含另一组", () => {
  const makePrompt = () => ({
    output: {
      "10": { inputs: { image_data: "A" } },
      "11": { inputs: { image: ["10", 2] } },
      "20": { inputs: { image_data: "B" } },
      "21": { inputs: { image: ["20", 2] } },
    },
  });
  const first = isolatePromptBranch(makePrompt(), 10);
  const second = isolatePromptBranch(makePrompt(), 20);
  assert.deepEqual(Object.keys(first.output).sort(), ["10", "11"]);
  assert.deepEqual(Object.keys(second.output).sort(), ["20", "21"]);
});

test("拖拽排序会按目标位置重新排列", () => {
  const items = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  assert.equal(moveItem(items, "4", "2", false), true);
  assert.deepEqual(items.map((item) => item.id), ["1", "4", "2", "3"]);
  assert.equal(moveItem(items, "1", "3", true), true);
  assert.deepEqual(items.map((item) => item.id), ["4", "2", "3", "1"]);
});

test("拖到卡片空白处会移动到末尾", () => {
  const items = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.equal(moveItem(items, "1"), true);
  assert.deepEqual(items.map((item) => item.id), ["2", "3", "1"]);
});
