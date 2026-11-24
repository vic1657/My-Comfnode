import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { buildIndependentPrompt } from "./nano_banana2_prompt_filter.mjs";

const NODE_CLASS = "MyNanoBanana2API";
const EXTENSION_VERSION = "standard-run-v4";

async function queueOnlyNode(node) {
  if (node._nanoQueueing) return;
  node._nanoQueueing = true;
  const button = node.widgets?.find((widget) => widget.name === "独立运行");
  if (button) button.name = "正在提交...";
  node.setDirtyCanvas(true, true);

  const originalQueuePrompt = api.queuePrompt;
  try {
    api.queuePrompt = async function (index, prompt, ...args) {
      if (prompt?.output) {
        prompt.output = buildIndependentPrompt(node.id, prompt.output);
      }
      return await originalQueuePrompt.call(this, index, prompt, ...args);
    };
    await app.queuePrompt(0);
  } catch (error) {
    console.error("Nano banana2 API 独立运行提交失败", error);
  } finally {
    api.queuePrompt = originalQueuePrompt;
    node._nanoQueueing = false;
    if (button) button.name = "独立运行";
    node.setDirtyCanvas(true, true);
  }
}

function addRunButton(node) {
  if (node.widgets?.some((widget) => widget.name === "独立运行")) return;
  const button = node.addWidget("button", "独立运行", "运行当前节点", () => queueOnlyNode(node));
  button.options = { ...(button.options || {}), serialize: false };
}

app.registerExtension({
  name: `MyComfnode.NanoBanana2RunButton.${EXTENSION_VERSION}`,
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      addRunButton(this);
      return result;
    };
    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigured?.apply(this, arguments);
      addRunButton(this);
      return result;
    };
  },
  async setup() {
    for (const node of app.graph?._nodes || []) {
      if (node.constructor?.nodeData?.name === NODE_CLASS) addRunButton(node);
    }
  },
});
