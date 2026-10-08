import { app } from "../../scripts/app.js";

const NODE_CLASS = "APILuLuTong";
const GUARD = "__myComfnodeAPILuLuTongImageOnlyCleanupV2";
const LEGACY_WIDGETS = new Set(["接口路径", "系统提示词", "温度", "最大输出Token", "超时秒数"]);
const VALID_OPTIONS = {
  图像尺寸: new Set(["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "2048x2048"]),
  画面比例: new Set(["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "9:21"]),
  分辨率: new Set(["auto", "1k", "2k", "4k"]),
  质量: new Set(["auto", "low", "medium", "high"]),
  输出格式: new Set(["auto", "png", "jpeg", "webp"]),
  背景: new Set(["auto", "opaque", "transparent"]),
};

function cleanupImageOnlyNode(node) {
  if (!node || (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS)) return;

  let inputIndex = node.inputs?.findIndex((input) => input?.name === "图片") ?? -1;
  while (inputIndex >= 0) {
    node.removeInput(inputIndex);
    inputIndex = node.inputs?.findIndex((input) => input?.name === "图片") ?? -1;
  }

  let outputIndex = node.outputs?.findIndex((output) => output?.name === "文本") ?? -1;
  while (outputIndex >= 0) {
    node.removeOutput(outputIndex);
    outputIndex = node.outputs?.findIndex((output) => output?.name === "文本") ?? -1;
  }

  for (let index = (node.widgets?.length || 0) - 1; index >= 0; index -= 1) {
    const widget = node.widgets[index];
    if (!LEGACY_WIDGETS.has(widget?.name)) continue;
    widget?.onRemove?.();
    widget?.inputEl?.remove?.();
    widget?.element?.remove?.();
    node.widgets.splice(index, 1);
  }

  const widget = (name) => node.widgets?.find((item) => item?.name === name);
  const seed = widget("种子");
  if (seed && !Number.isFinite(Number(seed.value))) seed.value = -1;
  const count = widget("生成数量");
  if (count && (!Number.isFinite(Number(count.value)) || Number(count.value) < 1)) count.value = 1;
  for (const [name, options] of Object.entries(VALID_OPTIONS)) {
    const target = widget(name);
    if (target && !options.has(String(target.value))) target.value = "auto";
  }
  node.graph?.setDirtyCanvas?.(true, true);
}

if (!globalThis[GUARD]) {
  globalThis[GUARD] = true;
  app.registerExtension({
    name: "MyComfnode.APILuLuTongImageOnlyCleanup.V2",
    nodeCreated: cleanupImageOnlyNode,
    loadedGraphNode: cleanupImageOnlyNode,
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_CLASS) return;
      const originalConfigured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        const result = originalConfigured?.apply?.(this, arguments);
        cleanupImageOnlyNode(this);
        return result;
      };
    },
  });
}
