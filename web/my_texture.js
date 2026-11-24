import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import "../../scripts/domWidget.js";

const NODE_CLASS = "MyComfnodeTexture";
const MIN_NODE_WIDTH = 560;
const NODE_CONTENT_TOP = 150;
const NODE_BOTTOM_PADDING = 12;
const PREVIEW_MIN_HEIGHT = 520;
// 1536px is already above the editor's maximum visible long side at the
// supported desktop viewport.  Rendering the old 2048px backing canvas made
// the first sticker frame spend multiple seconds processing pixels the user
// could not see, especially when generating the subject mask.
const PREVIEW_RENDER_LONG_SIDE = 1536;
// The preview contains a 520px stage, three rows of sliders, the blend
// selector, the free-transform toggle, and the footer button. Keep enough
// bounded height for every control so the preview button cannot be clipped.
const DEFAULT_WIDGET_HEIGHT = 840;
const MIN_NODE_HEIGHT = NODE_CONTENT_TOP + DEFAULT_WIDGET_HEIGHT + NODE_BOTTOM_PADDING;
const MAX_NODE_HEIGHT = 2400;

const WIDGETS = {
  tData: "t_data",
  deformation: "形变强度",
  opacity: "透明度",
  skewX: "水平倾斜",
  skewY: "垂直倾斜",
  stretchX: "水平拉伸",
  stretchY: "垂直拉伸",
  blendMode: "混合模式",
};

const SLIDERS = [
  { key: "deformation", label: "形变强度", min: 0, max: 1, step: 0.01, default: 0.3 },
  { key: "opacity", label: "透明度", min: 0, max: 1, step: 0.01, default: 1 },
  { key: "skewX", label: "水平倾斜", min: -1, max: 1, step: 0.01, default: 0 },
  { key: "skewY", label: "垂直倾斜", min: -1, max: 1, step: 0.01, default: 0 },
  { key: "stretchX", label: "水平拉伸", min: 0.1, max: 3, step: 0.1, default: 1 },
  { key: "stretchY", label: "垂直拉伸", min: 0.1, max: 3, step: 0.1, default: 1 },
];
const SELECTS = [{
  key: "blendMode",
  label: "混合模式",
  default: "normal",
  values: ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "soft-light", "hard-light", "hologram"],
  labels: {
    normal: "正常", multiply: "正片叠底", screen: "滤色", overlay: "叠加",
    darken: "变暗", lighten: "变亮", "color-dodge": "颜色减淡",
    "color-burn": "颜色加深", "soft-light": "柔光", "hard-light": "强光",
    hologram: "全息投影",
  },
}];

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function removeLegacyInputs(node) {
  const legacyNames = new Set(["背景图像", "贴图图像", "贴图透明遮罩", "t_data"]);
  let removed = false;
  for (let index = (node.inputs?.length || 0) - 1; index >= 0; index -= 1) {
    if (!legacyNames.has(String(node.inputs[index]?.name || ""))) continue;
    if (typeof node.removeInput === "function") {
      node.removeInput(index);
    } else {
      node.inputs.splice(index, 1);
    }
    removed = true;
  }
  if (removed) node.graph?.setDirtyCanvas?.(true, true);
  return removed;
}

function normalizeInputOrder(node) {
  if (!Array.isArray(node?.inputs) || node.inputs.length < 2) return false;
  const preferred = ["bg_img", "bg_depth_map", "bg_mask", "fg_img_1", "fg_alpha_mask_1", "fg_img_2", "fg_alpha_mask_2"];
  const rank = new Map(preferred.map((name, index) => [name, index]));
  const original = [...node.inputs];
  const sorted = [...node.inputs].sort((left, right) => {
    const leftRank = rank.has(left?.name) ? rank.get(left.name) : preferred.length;
    const rightRank = rank.has(right?.name) ? rank.get(right.name) : preferred.length;
    return leftRank - rightRank;
  });
  if (sorted.every((input, index) => input === original[index])) return false;

  node.inputs.splice(0, node.inputs.length, ...sorted);
  const links = node.graph?.links;
  node.inputs.forEach((input, targetSlot) => {
    if (input?.link == null) return;
    const link = node.graph?.getLink?.(input.link)
      || links?.get?.(input.link)
      || links?.[input.link];
    if (!link) return;
    link.target_slot = targetSlot;
    if ("targetSlot" in link) link.targetSlot = targetSlot;
  });
  node.graph?.setDirtyCanvas?.(true, true);
  return true;
}

function removeLegacyWidgets(node) {
  const legacyNames = new Set([
    "中心X", "中心Y", "尺寸基准", "贴图宽度占背景(%)", "缩放(%)",
    "旋转(度)", "透明度(%)", "边缘羽化(px)", "边缘插值", "遮罩含义",
    "深度强度", "光照强度", "透视强度",
  ]);
  let removed = false;
  for (let index = (node.widgets?.length || 0) - 1; index >= 0; index -= 1) {
    if (!legacyNames.has(String(node.widgets[index]?.name || ""))) continue;
    node.widgets.splice(index, 1);
    removed = true;
  }
  if (removed) node.graph?.setDirtyCanvas?.(true, true);
  return removed;
}

function scheduleLegacyInputCleanup(node) {
  if (!node || node._myTextureCleanupScheduled) return;
  node._myTextureCleanupScheduled = true;
  for (const delay of [0, 80, 300, 1000]) {
    setTimeout(() => {
      removeLegacyInputs(node);
      removeLegacyWidgets(node);
      normalizeInputOrder(node);
    }, delay);
  }
}

function hideWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget || widget._myTextureHidden) return widget;
  widget._myTextureHidden = true;
  widget.hidden = true;
  widget.type = "converted-widget";
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  if (widget.options) widget.options.hidden = true;
  if (widget.inputEl) widget.inputEl.style.display = "none";
  if (widget.element) widget.element.style.display = "none";
  return widget;
}

function numberWidget(node, name, fallback = 0) {
  const value = Number(findWidget(node, name)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function transformState(node) {
  let value = node._myTextureTransformData || findWidget(node, WIDGETS.tData)?.value || "";
  if (typeof value === "string") {
    try { value = value.trim() ? JSON.parse(value) : {}; } catch { value = {}; }
  }
  if (!value || typeof value !== "object") value = {};
  const layer = value.currentLayer_1 && typeof value.currentLayer_1 === "object"
    ? value.currentLayer_1
    : value;
  const offset = Array.isArray(layer.offset) && layer.offset.length >= 2 ? layer.offset : [0.3, 0.3];
  const scale = Array.isArray(layer.scale) && layer.scale.length >= 2 ? layer.scale : [0.4, 0.4];
  const rawCorners = Array.isArray(layer.corners) && layer.corners.length === 4 ? layer.corners : null;
  const finiteOr = (input, fallback) => {
    const number = Number(input);
    return Number.isFinite(number) ? number : fallback;
  };
  const corners = rawCorners?.every((point) => Array.isArray(point) && point.length >= 2)
    ? rawCorners.map((point) => [finiteOr(point[0], 0), finiteOr(point[1], 0)])
    : null;
  return {
    data: value,
    offset: [finiteOr(offset[0], 0.3), finiteOr(offset[1], 0.3)],
    scale: [Math.max(0.001, finiteOr(scale[0], 0.4)), Math.max(0.001, finiteOr(scale[1], 0.4))],
    rotation: finiteOr(layer.rotation, 0),
    freeTransform: Boolean(layer.free_transform && corners),
    corners,
  };
}

function updateTransformState(node, next) {
  const current = transformState(node);
  const data = current.data && typeof current.data === "object" ? current.data : {};
  data.currentLayer_1 = {
    offset: next.offset || current.offset,
    scale: next.scale || current.scale,
    rotation: next.rotation ?? current.rotation,
    free_transform: next.freeTransform ?? current.freeTransform,
    corners: next.corners === null ? undefined : (next.corners || current.corners || undefined),
  };
  node._myTextureTransformData = JSON.stringify(data);
  setWidgetValue(node, WIDGETS.tData, node._myTextureTransformData);
}

function setWidgetValue(node, name, value) {
  const widget = findWidget(node, name);
  if (!widget) return;
  // Cast from the new value, not the stale saved value. Legacy workflows can
  // put a number into the blend-mode slot; coercing "normal" through that old
  // numeric type produces NaN, which ComfyUI serializes as null.
  const next = typeof value === "number" ? Number(value) : value;
  if (widget.value === next) return;
  widget.value = next;
  widget.callback?.(next);
  node.graph?.setDirtyCanvas?.(true, true);
}

function migrateLegacyWidgetValues(node) {
  const transformWidget = findWidget(node, WIDGETS.tData);
  const rawTransform = transformWidget?.value;
  let invalidTransform = false;
  if (typeof rawTransform === "string" && rawTransform.trim()) {
    try {
      const parsed = JSON.parse(rawTransform);
      invalidTransform = !parsed || typeof parsed !== "object" || Array.isArray(parsed);
    } catch {
      invalidTransform = true;
    }
  } else if (rawTransform != null && rawTransform !== "") {
    invalidTransform = typeof rawTransform !== "object";
  }

  const invalidSlider = SLIDERS.some((item) => {
    const value = Number(findWidget(node, WIDGETS[item.key])?.value);
    return !Number.isFinite(value) || value < item.min || value > item.max;
  });
  const invalidSelect = SELECTS.some((item) => {
    const value = String(findWidget(node, WIDGETS[item.key])?.value ?? "");
    return !(item.values || []).includes(value);
  });
  if (!invalidTransform && !invalidSlider && !invalidSelect) return false;

  // Workflows saved by the legacy node store eleven positional widget values.
  // ComfyUI maps those values onto the new widgets by index, which otherwise
  // produces combinations such as opacity=0 and stretch=3/0.1. Reset only when
  // that incompatible payload is detected; valid current workflow values stay.
  for (const item of SLIDERS) setWidgetValue(node, WIDGETS[item.key], item.default);
  for (const item of SELECTS) setWidgetValue(node, WIDGETS[item.key], item.default);
  node._myTextureTransformData = JSON.stringify({
    currentLayer_1: { offset: [0.3, 0.3], scale: [0.4, 0.4], rotation: 0 },
  });
  setWidgetValue(node, WIDGETS.tData, node._myTextureTransformData);
  return true;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatValue(value, slider) {
  const number = Number(value);
  const stepText = String(slider.step ?? "");
  const digits = stepText.includes(".") ? stepText.split(".")[1].length : 0;
  return `${Number.isFinite(number) ? number.toFixed(digits) : value}${slider.suffix || ""}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const imageUrl = String(src || "");
    if (!imageUrl) {
      reject(new Error("预览图片地址为空"));
      return;
    }
    const image = new Image();
    image.onload = async () => {
      // Wait for the browser's decode step as well as the network load. This
      // prevents the first preview frame from using a low-resolution decoded
      // surface and then changing geometry when the sharp surface appears.
      try { await image.decode?.(); } catch { /* the loaded image is still usable */ }
      resolve(image);
    };
    image.onerror = () => {
      // DOM's native onerror argument is an Event object. Passing it through
      // made the UI show only "[object Event]", hiding which preview failed.
      reject(new Error(`预览图片加载失败：${imageUrl}`));
    };
    image.src = imageUrl;
  });
}

function linkedOriginNode(node, inputIndex) {
  const input = node?.inputs?.[inputIndex];
  if (input?.link == null) return null;
  const graph = node.graph || app.graph;
  const links = graph?.links;
  const link = graph?.getLink?.(input.link)
    || links?.get?.(input.link)
    || links?.[input.link];
  const originId = link?.origin_id ?? link?.originId;
  return originId == null ? null : graph?.getNodeById?.(originId) || null;
}

function viewImageUrl(filename, type = "input", subfolder = "") {
  if (!filename) return "";
  const query = new URLSearchParams({
    filename: String(filename),
    subfolder: String(subfolder || ""),
    type: String(type || "input"),
  });
  return `/view?${query.toString()}`;
}

function storedBatchItems(origin) {
  let value = origin?._batchImageItems || origin?.properties?.batchImageItems;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = []; }
  }
  if (value && !Array.isArray(value)) value = value.images;
  return Array.isArray(value) ? value : [];
}

function imageSourceFromNode(origin, outputSlot = 0) {
  if (!origin) return null;

  const cached = origin.imgs?.[outputSlot] || origin.imgs?.[0];
  if (cached?.src) return { url: cached.src, width: cached.naturalWidth, height: cached.naturalHeight };

  const batchItems = storedBatchItems(origin).filter((item) => item?.filename || item?.name);
  if (batchItems.length) {
    const item = batchItems.find((candidate) => candidate.selected) || batchItems[0];
    const filename = item.filename || item.name;
    const url = item.previewUrl && !item.previewUrl.startsWith("blob:")
      ? item.previewUrl
      : viewImageUrl(filename, item.type || "input", item.subfolder || "");
    if (url) return { url };
  }

  const nodeType = String(origin.comfyClass || origin.type || "");
  const imageWidget = origin.widgets?.find((widget) => {
    const name = String(widget?.name || "").toLowerCase();
    return name === "image" || name === "image_name" || name === "filename";
  });
  const value = imageWidget?.value;
  if (typeof value !== "string" || !value.trim()) return null;

  const annotated = value.match(/^(.*)\s+\[(input|output|temp)\]$/i);
  const filename = annotated ? annotated[1] : value;
  const type = annotated ? annotated[2].toLowerCase() : (nodeType === "LoadImageOutput" ? "output" : "input");
  return { url: viewImageUrl(filename, type) };
}

function inputImageSource(node, inputNameOrIndex) {
  const inputIndex = typeof inputNameOrIndex === "number"
    ? inputNameOrIndex
    : (node?.inputs || []).findIndex((input) => input?.name === inputNameOrIndex);
  if (inputIndex < 0) return null;
  const origin = linkedOriginNode(node, inputIndex);
  return imageSourceFromNode(origin, 0);
}

function linkedInputSource(node, inputNameOrIndex) {
  const inputIndex = typeof inputNameOrIndex === "number"
    ? inputNameOrIndex
    : (node?.inputs || []).findIndex((input) => input?.name === inputNameOrIndex);
  if (inputIndex < 0) return null;
  const input = node?.inputs?.[inputIndex];
  if (input?.link == null) return null;
  const graph = node.graph || app.graph;
  const link = graph?.getLink?.(input.link)
    || graph?.links?.get?.(input.link)
    || graph?.links?.[input.link];
  const originId = link?.origin_id ?? link?.originId;
  if (originId == null) return null;
  return {
    originId: String(originId),
    originSlot: Number(link?.origin_slot ?? link?.originSlot ?? 0),
    originNode: graph?.getNodeById?.(originId) || null,
  };
}

function ensureTextureAlphaConnection(node, imageInputName, maskInputName) {
  const maskInputIndex = (node?.inputs || []).findIndex((input) => input?.name === maskInputName);
  if (maskInputIndex < 0 || node.inputs[maskInputIndex]?.link != null) return false;
  const source = linkedInputSource(node, imageInputName);
  if (!source?.originNode) return false;
  const maskOutputIndex = (source.originNode.outputs || []).findIndex((output) => {
    const type = String(output?.type || "").toUpperCase();
    const name = String(output?.name || "").toLowerCase();
    return type === "MASK" || name === "mask";
  });
  if (maskOutputIndex < 0 || typeof source.originNode.connect !== "function") return false;
  try {
    source.originNode.connect(maskOutputIndex, node, maskInputIndex);
    node.graph?.setDirtyCanvas?.(true, true);
    return node.inputs[maskInputIndex]?.link != null;
  } catch (error) {
    console.warn("[MyTexture] unable to connect source alpha mask", error);
    return false;
  }
}

function temporaryPreviewNodeId(prompt, suffix) {
  const ids = Object.keys(prompt || {}).map((id) => Number(id)).filter(Number.isFinite);
  let next = Math.max(0, ...ids) + 1;
  while (prompt[String(next)]) next += 1;
  return String(next) + suffix;
}

async function waitForHistory(promptId, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error(`读取预览结果失败 (${response.status})`);
    const history = await response.json();
    const item = history?.[promptId];
    const status = item?.status;
    if (item?.outputs && (status?.completed || status?.status_str === "success" || !status)) return item;
    if (status?.status_str === "error" || status?.status_str === "failed") {
      throw new Error(status?.messages?.[0]?.[1] || "上游预览执行失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("上游预览执行超时");
}

function historyImageUrl(historyItem, nodeId) {
  const image = historyItem?.outputs?.[nodeId]?.images?.[0];
  if (!image?.filename) return null;
  return viewImageUrl(image.filename, image.type || "output", image.subfolder || "");
}

async function executePreviewDependencies(node) {
  const promptData = await app.graphToPrompt();
  const prompt = structuredClone(promptData?.output || promptData || {});
  const promptNode = prompt[String(node.id)] || prompt[node.id] || {};
  const promptLink = (name) => {
    const value = promptNode?.inputs?.[name];
    return Array.isArray(value) && value.length >= 2
      ? { originId: String(value[0]), originSlot: Number(value[1]) || 0 }
      : null;
  };
  const backgroundLink = promptLink("bg_img") || linkedInputSource(node, "bg_img");
  const textureLink = promptLink("fg_img_1") || linkedInputSource(node, "fg_img_1");
  const maskLink = promptLink("bg_mask") || linkedInputSource(node, "bg_mask");
  const depthLink = promptLink("bg_depth_map") || linkedInputSource(node, "bg_depth_map");
  if (!backgroundLink || !textureLink) throw new Error("请先连接底图和贴图输入");

  const directBackground = inputImageSource(node, "bg_img");
  const directTexture = inputImageSource(node, "fg_img_1");
  if (directBackground?.url && directTexture?.url && !maskLink && !depthLink) {
    return { backgroundUrl: directBackground.url, textureUrl: directTexture.url };
  }

  const previewTargets = [];
  const addPreview = (id, source, title) => {
    prompt[id] = { class_type: "PreviewImage", inputs: { images: [source.originId, source.originSlot] }, _meta: { title } };
    previewTargets.push(id);
  };
  const backgroundPreviewId = temporaryPreviewNodeId(prompt, "_mytexture_bg");
  const texturePreviewId = temporaryPreviewNodeId(prompt, "_mytexture_fg");
  addPreview(backgroundPreviewId, backgroundLink, "My贴图预览底图");
  addPreview(texturePreviewId, textureLink, "My贴图预览贴图");

  let maskPreviewId = null;
  if (maskLink) {
    const maskImageId = temporaryPreviewNodeId(prompt, "_mytexture_mask_image");
    maskPreviewId = temporaryPreviewNodeId(prompt, "_mytexture_mask");
    prompt[maskImageId] = { class_type: "MaskToImage", inputs: { mask: [maskLink.originId, maskLink.originSlot] }, _meta: { title: "My贴图预览人物遮罩" } };
    addPreview(maskPreviewId, { originId: maskImageId, originSlot: 0 }, "My贴图预览人物遮罩");
  }
  let depthPreviewId = null;
  if (depthLink) {
    depthPreviewId = temporaryPreviewNodeId(prompt, "_mytexture_depth");
    addPreview(depthPreviewId, depthLink, "My贴图预览深度图");
  }

  const response = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: api.clientId,
      prompt,
      partial_execution_targets: previewTargets,
      extra_data: promptData?.workflow ? { extra_pnginfo: { workflow: promptData.workflow } } : {},
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.error) throw new Error(result?.error || "提交上游预览失败");
  const historyItem = await waitForHistory(result.prompt_id);
  const backgroundUrl = historyImageUrl(historyItem, backgroundPreviewId);
  const textureUrl = historyImageUrl(historyItem, texturePreviewId);
  if (!backgroundUrl || !textureUrl) throw new Error("上游预览没有返回底图或贴图");
  return {
    backgroundUrl,
    textureUrl,
    maskUrl: maskPreviewId ? historyImageUrl(historyItem, maskPreviewId) : null,
    depthUrl: depthPreviewId ? historyImageUrl(historyItem, depthPreviewId) : null,
  };
}

async function executePreviewDependenciesLegacy2(node) {
  const promptData = await app.graphToPrompt();
  const prompt = structuredClone(promptData?.output || promptData || {});
  const promptNode = prompt[String(node.id)] || prompt[node.id] || {};
  const promptLink = (name) => {
    const value = promptNode?.inputs?.[name];
    return Array.isArray(value) && value.length >= 2
      ? { originId: String(value[0]), originSlot: Number(value[1]) || 0 }
      : null;
  };
  const backgroundLink = promptLink("bg_img") || linkedInputSource(node, "bg_img");
  const textureLink = promptLink("fg_img_1") || linkedInputSource(node, "fg_img_1");
  if (!backgroundLink || !textureLink) throw new Error("请先连接底图和贴图输入");
  if (!backgroundLink || !textureLink) throw new Error("请先连接底图和贴图输入");
  const directBackground = inputImageSource(node, "bg_img");
  const directTexture = inputImageSource(node, "fg_img_1");
  if (directBackground?.url && directTexture?.url) {
    return { backgroundUrl: directBackground.url, textureUrl: directTexture.url };
  }
  const backgroundPreviewId = temporaryPreviewNodeId(prompt, "_mytexture_bg");
  const texturePreviewId = temporaryPreviewNodeId(prompt, "_mytexture_fg");
  prompt[backgroundPreviewId] = {
    class_type: "PreviewImage",
    inputs: { images: [backgroundLink.originId, backgroundLink.originSlot] },
    _meta: { title: "My贴图预览底图" },
  };
  prompt[texturePreviewId] = {
    class_type: "PreviewImage",
    inputs: { images: [textureLink.originId, textureLink.originSlot] },
    _meta: { title: "My贴图预览贴图" },
  };
  const response = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: api.clientId,
      prompt,
      partial_execution_targets: [backgroundPreviewId, texturePreviewId],
      extra_data: promptData?.workflow ? { extra_pnginfo: { workflow: promptData.workflow } } : {},
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.error) throw new Error(result?.error || "提交上游预览失败");
  const historyItem = await waitForHistory(result.prompt_id);
  const backgroundUrl = historyImageUrl(historyItem, backgroundPreviewId);
  const textureUrl = historyImageUrl(historyItem, texturePreviewId);
  if (!backgroundUrl || !textureUrl) throw new Error("上游预览没有返回底图或贴图");
  return { backgroundUrl, textureUrl };
}

async function executePreviewDependenciesLegacy(node) {
  const backgroundLink = linkedInputSource(node, "bg_img");
  const textureLink = linkedInputSource(node, "fg_img_1");
  if (!backgroundLink || !textureLink) {
    throw new Error("请先连接底图和贴图输入");
  }
  const promptData = await app.graphToPrompt();
  const prompt = structuredClone(promptData?.output || promptData || {});
  const backgroundPreviewId = temporaryPreviewNodeId(prompt, "_mytexture_bg");
  const texturePreviewId = temporaryPreviewNodeId(prompt, "_mytexture_fg");
  prompt[backgroundPreviewId] = {
    class_type: "PreviewImage",
    inputs: { images: [backgroundLink.originId, backgroundLink.originSlot] },
    _meta: { title: "My贴图预览底图" },
  };
  prompt[texturePreviewId] = {
    class_type: "PreviewImage",
    inputs: { images: [textureLink.originId, textureLink.originSlot] },
    _meta: { title: "My贴图预览贴图" },
  };
  const response = await api.fetchApi("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: api.clientId,
      prompt,
      partial_execution_targets: [backgroundPreviewId, texturePreviewId],
      extra_data: promptData?.workflow ? { extra_pnginfo: { workflow: promptData.workflow } } : {},
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.error) throw new Error(result?.error || "提交上游预览失败");
  const historyItem = await waitForHistory(result.prompt_id);
  const backgroundUrl = historyImageUrl(historyItem, backgroundPreviewId);
  const textureUrl = historyImageUrl(historyItem, texturePreviewId);
  if (!backgroundUrl || !textureUrl) throw new Error("上游预览没有返回底图或贴图");
  return { backgroundUrl, textureUrl };
}

function ensureStyle() {
  if (document.getElementById("mycomfnode-texture-style-v3")) return;
  const style = document.createElement("style");
  style.id = "mycomfnode-texture-style-v3";
  style.textContent = `
    .mytexture-root {
      box-sizing: border-box;
      color: #eceff5;
      display: grid;
      font: 12px Arial, sans-serif;
      grid-template-rows: minmax(${PREVIEW_MIN_HEIGHT}px, 1fr) auto 34px;
      height: ${DEFAULT_WIDGET_HEIGHT}px;
      max-height: ${DEFAULT_WIDGET_HEIGHT}px;
      min-width: 520px;
      overflow: hidden;
      padding: 8px 10px 8px;
      position: relative;
      user-select: none;
      width: 100%;
    }
    .mytexture-stage {
      background: #161719;
      border: 0;
      box-sizing: border-box;
      min-height: ${PREVIEW_MIN_HEIGHT}px;
      overflow: hidden;
      position: relative;
      width: 100%;
    }
    .mytexture-canvas {
      display: block;
      height: 100%;
      width: 100%;
    }
    .mytexture-control-layer {
      inset: 0;
      pointer-events: none;
      position: absolute;
    }
    .mytexture-transform-box {
      border: 1px solid rgba(92,159,255,.9);
      box-sizing: border-box;
      pointer-events: none;
      position: absolute;
      transform-origin: center center;
    }
    .mytexture-transform-box.free { border-color: transparent; }
    .mytexture-transform-lines {
      display: none;
      height: 100%;
      inset: 0;
      overflow: visible;
      pointer-events: none;
      position: absolute;
      width: 100%;
    }
    .mytexture-transform-lines polygon,
    .mytexture-transform-lines line {
      fill: none;
      stroke: rgba(92,159,255,.95);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .mytexture-transform-point {
      background: #f4f8ff;
      border: 3px solid #3b8cff;
      border-radius: 50%;
      box-sizing: border-box;
      height: 22px;
      margin: -11px 0 0 -11px;
      pointer-events: auto;
      position: absolute;
      width: 22px;
      z-index: 2;
    }
    .mytexture-transform-point.corner.nw { cursor: nwse-resize; }
    .mytexture-transform-point.corner.ne { cursor: nesw-resize; }
    .mytexture-transform-point.corner.se { cursor: nwse-resize; }
    .mytexture-transform-point.corner.sw { cursor: nesw-resize; }
    .mytexture-transform-point.rotate {
      cursor: grab;
      height: 24px;
      margin-left: -12px;
      margin-top: -12px;
      width: 24px;
    }
    .mytexture-transform-point.rotate:active { cursor: grabbing; }
    .mytexture-transform-stem {
      border-left: 1px solid rgba(92,159,255,.9);
      height: 32px;
      left: 50%;
      position: absolute;
      top: -33px;
    }
    .mytexture-panel {
      box-sizing: border-box;
      display: grid;
      gap: 8px 12px;
      grid-template-columns: 1fr 1fr;
      padding: 10px 2px 6px;
    }
    .mytexture-panel .mytexture-control:last-child:nth-child(odd) {
      grid-column: 1 / -1;
    }
    .mytexture-panel .mytexture-select-control { grid-column: 1 / -1; }
    .mytexture-control {
      min-width: 0;
    }
    .mytexture-label-row {
      align-items: center;
      display: flex;
      justify-content: space-between;
      line-height: 16px;
      margin-bottom: 4px;
    }
    .mytexture-label {
      color: rgba(255,255,255,.75);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mytexture-value {
      color: rgba(255,255,255,.9);
      font-variant-numeric: tabular-nums;
      margin-left: 8px;
      white-space: nowrap;
    }
    .mytexture-slider {
      appearance: none;
      background: linear-gradient(90deg, #cbd9ff var(--pct, 50%), #2f6dff var(--pct, 50%));
      border-radius: 999px;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.22);
      cursor: pointer;
      height: 10px;
      margin: 0;
      outline: none;
      width: 100%;
    }
    .mytexture-slider::-webkit-slider-thumb {
      appearance: none;
      background: #4284ff;
      border: 3px solid #e8f0ff;
      border-radius: 50%;
      box-shadow: 0 1px 4px rgba(0,0,0,.45);
      height: 22px;
      width: 22px;
    }
    .mytexture-slider::-moz-range-thumb {
      background: #4284ff;
      border: 3px solid #e8f0ff;
      border-radius: 50%;
      box-shadow: 0 1px 4px rgba(0,0,0,.45);
      height: 16px;
      width: 16px;
    }
    .mytexture-select {
      background: #25272b;
      border: 1px solid rgba(255,255,255,.18);
      border-radius: 6px;
      box-sizing: border-box;
      color: #f3f5fb;
      height: 28px;
      outline: none;
      padding: 0 8px;
      width: 100%;
    }
    .mytexture-free-row {
      align-items: center;
      display: flex;
      grid-column: 1 / -1;
      justify-content: flex-end;
      min-height: 32px;
    }
    .mytexture-free-toggle {
      background: #34373d;
      border: 1px solid rgba(255,255,255,.22);
      border-radius: 6px;
      color: rgba(255,255,255,.82);
      cursor: pointer;
      font: inherit;
      height: 30px;
      min-width: 116px;
      padding: 0 12px;
      transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
    }
    .mytexture-free-toggle:hover { background: #41454d; }
    .mytexture-free-toggle[aria-pressed="true"] {
      background: #2f6dff;
      border-color: #78a3ff;
      color: #fff;
    }
    .mytexture-free-toggle:focus-visible {
      outline: 2px solid #9fc0ff;
      outline-offset: 2px;
    }
    .mytexture-control.is-free-disabled { opacity: .46; }
    .mytexture-control.is-free-disabled .mytexture-slider { cursor: not-allowed; }
    .mytexture-footer {
      align-items: center;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      min-width: 0;
      white-space: nowrap;
    }
    .mytexture-status {
      color: rgba(255,255,255,.68);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mytexture-status[data-tone="ready"] { color: #b8f3c3; }
    .mytexture-status[data-tone="warn"] { color: #ffd58b; }
    .mytexture-size { color: rgba(255,255,255,.5); }
    .mytexture-load {
      background: #2f6dff;
      border: 1px solid rgba(255,255,255,.3);
      border-radius: 5px;
      box-sizing: border-box;
      color: #fff;
      cursor: pointer;
      flex: 0 0 auto;
      height: 28px;
      padding: 0 12px;
    }
    .mytexture-load:hover { background: #4284ff; }
    .mytexture-load:disabled { cursor: wait; opacity: .65; }
    .mytexture-handle {
      background: transparent;
      position: absolute;
      z-index: 5;
    }
    .mytexture-handle.right {
      bottom: 20px;
      cursor: ew-resize;
      right: 0;
      top: 0;
      width: 7px;
    }
    .mytexture-handle.bottom {
      bottom: 0;
      cursor: ns-resize;
      height: 7px;
      left: 0;
      right: 20px;
    }
    .mytexture-handle.corner {
      bottom: 0;
      cursor: nwse-resize;
      height: 20px;
      right: 0;
      width: 20px;
    }
    .mytexture-root,
    .mytexture-stage,
    .mytexture-panel,
    .mytexture-footer {
      min-width: 0;
    }
  `;
  document.head.appendChild(style);
}

function drawChecker(ctx, x, y, width, height, size = 16) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  for (let yy = y; yy < y + height; yy += size) {
    for (let xx = x; xx < x + width; xx += size) {
      const even = (Math.floor((xx - x) / size) + Math.floor((yy - y) / size)) % 2 === 0;
      ctx.fillStyle = even ? "#2c2c2c" : "#242424";
      ctx.fillRect(xx, yy, size, size);
    }
  }
  ctx.restore();
}

function previewMetrics(node) {
  const data = node._myTexturePreview;
  const canvas = node._myTextureCanvas;
  if (!data?.backgroundImage || !data?.textureImage || !canvas) return null;
  const bgW = Number(data.background_width) || data.backgroundImage.naturalWidth || 1;
  const bgH = Number(data.background_height) || data.backgroundImage.naturalHeight || 1;
  const cw = canvas.width;
  const ch = canvas.height;
  const margin = 18 * (node._myTextureBackingScale || window.devicePixelRatio || 1);
  const scale = Math.min((cw - margin * 2) / bgW, (ch - margin * 2) / bgH);
  const drawW = Math.max(1, bgW * scale);
  const drawH = Math.max(1, bgH * scale);
  return {
    bgW,
    bgH,
    drawX: (cw - drawW) / 2,
    drawY: (ch - drawH) / 2,
    drawW,
    drawH,
    scale,
  };
}

function textureBox(node, metrics) {
  const data = node._myTexturePreview;
  const texW = Number(data.texture_width) || data.textureImage.naturalWidth || 1;
  const texH = Number(data.texture_height) || data.textureImage.naturalHeight || 1;
  const state = transformState(node);
  const stretchX = numberWidget(node, WIDGETS.stretchX, 1);
  const stretchY = numberWidget(node, WIDGETS.stretchY, 1);
  const width = metrics.bgW * state.scale[0] * stretchX * metrics.scale;
  // Use the source aspect ratio for both the DOM preview and the backend.
  // The old bgW/bgH calculation distorted a wide PNG on portrait photos.
  const height = metrics.bgW * (texH / Math.max(1, texW)) * state.scale[1] * stretchY * metrics.scale;
  const left = metrics.drawX + metrics.bgW * state.offset[0] * metrics.scale;
  const top = metrics.drawY + metrics.bgH * state.offset[1] * metrics.scale;
  return { cx: left + width / 2, cy: top + height / 2, width, height, state, texW, texH };
}

const QUAD_KEYS = ["nw", "ne", "se", "sw"];

function boxCorners(box) {
  const radians = box.state.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const local = [
    [-box.width / 2, -box.height / 2],
    [box.width / 2, -box.height / 2],
    [box.width / 2, box.height / 2],
    [-box.width / 2, box.height / 2],
  ];
  return local.map(([x, y]) => [box.cx + x * cos - y * sin, box.cy + x * sin + y * cos]);
}

function stateCornersCanvas(state, metrics, fallbackBox = null) {
  if (state.freeTransform && state.corners) {
    return state.corners.map(([x, y]) => [
      metrics.drawX + x * metrics.drawW,
      metrics.drawY + y * metrics.drawH,
    ]);
  }
  return fallbackBox ? boxCorners(fallbackBox) : null;
}

function quadCenter(corners) {
  return corners.reduce((center, point) => [center[0] + point[0] / 4, center[1] + point[1] / 4], [0, 0]);
}

function quadBounds(corners, state) {
  const xs = corners.map((point) => point[0]);
  const ys = corners.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    state,
    corners,
  };
}

function isUsableQuad(corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return false;
  let sign = 0;
  let area = 0;
  for (let index = 0; index < 4; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % 4];
    const after = corners[(index + 2) % 4];
    const edgeX = next[0] - current[0];
    const edgeY = next[1] - current[1];
    if (Math.hypot(edgeX, edgeY) < 0.015) return false;
    const cross = edgeX * (after[1] - next[1]) - edgeY * (after[0] - next[0]);
    if (Math.abs(cross) < 0.00002) return false;
    const nextSign = Math.sign(cross);
    if (sign && nextSign !== sign) return false;
    sign = nextSign;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(area) > 0.001;
}

function solveLinearSystem(matrix, values) {
  const size = values.length;
  const rows = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-9) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= size; item += 1) rows[column][item] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let item = column; item <= size; item += 1) rows[row][item] -= factor * rows[column][item];
    }
  }
  return rows.map((row) => row[size]);
}

function homographyToQuad(corners) {
  const source = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const matrix = [];
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    const [u, v] = source[index];
    const [x, y] = corners[index];
    matrix.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    values.push(x);
    matrix.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    values.push(y);
  }
  return solveLinearSystem(matrix, values);
}

function projectHomography(homography, u, v) {
  const denominator = homography[6] * u + homography[7] * v + 1;
  return [
    (homography[0] * u + homography[1] * v + homography[2]) / denominator,
    (homography[3] * u + homography[4] * v + homography[5]) / denominator,
  ];
}

function inverseProjectHomography(homography, x, y) {
  if (!homography) return null;
  const [a, b, c, d, e, f, g, h] = homography;
  const matrix = [a, b, c, d, e, f, g, h, 1];
  const determinant = (
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
    - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
    + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6])
  );
  if (Math.abs(determinant) < 1e-10) return null;
  const inverse = [
    (matrix[4] * matrix[8] - matrix[5] * matrix[7]) / determinant,
    (matrix[2] * matrix[7] - matrix[1] * matrix[8]) / determinant,
    (matrix[1] * matrix[5] - matrix[2] * matrix[4]) / determinant,
    (matrix[5] * matrix[6] - matrix[3] * matrix[8]) / determinant,
    (matrix[0] * matrix[8] - matrix[2] * matrix[6]) / determinant,
    (matrix[2] * matrix[3] - matrix[0] * matrix[5]) / determinant,
    (matrix[3] * matrix[7] - matrix[4] * matrix[6]) / determinant,
    (matrix[1] * matrix[6] - matrix[0] * matrix[7]) / determinant,
    (matrix[0] * matrix[4] - matrix[1] * matrix[3]) / determinant,
  ];
  const denominator = inverse[6] * x + inverse[7] * y + inverse[8];
  if (Math.abs(denominator) < 1e-10) return null;
  return [
    (inverse[0] * x + inverse[1] * y + inverse[2]) / denominator,
    (inverse[3] * x + inverse[4] * y + inverse[5]) / denominator,
  ];
}

function drawImageTriangle(ctx, image, source, destination) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1]);
  if (Math.abs(denominator) < 1e-6) return;
  const a = (d0[0] * (s1[1] - s2[1]) + d1[0] * (s2[1] - s0[1]) + d2[0] * (s0[1] - s1[1])) / denominator;
  const b = (d0[1] * (s1[1] - s2[1]) + d1[1] * (s2[1] - s0[1]) + d2[1] * (s0[1] - s1[1])) / denominator;
  const c = (d0[0] * (s2[0] - s1[0]) + d1[0] * (s0[0] - s2[0]) + d2[0] * (s1[0] - s0[0])) / denominator;
  const d = (d0[1] * (s2[0] - s1[0]) + d1[1] * (s0[0] - s2[0]) + d2[1] * (s1[0] - s0[0])) / denominator;
  const e = (d0[0] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[0] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[0] * (s0[0] * s1[1] - s1[0] * s0[1])) / denominator;
  const f = (d0[1] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[1] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[1] * (s0[0] * s1[1] - s1[0] * s0[1])) / denominator;
  // Canvas clips each mesh triangle independently.  Without a tiny overlap,
  // antialiasing leaves transparent seams that cut through thin lettering.
  // Expand only the clip polygon; keep the projective transform unchanged.
  const center = [(d0[0] + d1[0] + d2[0]) / 3, (d0[1] + d1[1] + d2[1]) / 3];
  const expanded = [d0, d1, d2].map((point) => {
    const vx = point[0] - center[0];
    const vy = point[1] - center[1];
    const length = Math.max(0.0001, Math.hypot(vx, vy));
    return [point[0] + vx / length * 1.25, point[1] + vy / length * 1.25];
  });
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(expanded[0][0], expanded[0][1]);
  ctx.lineTo(expanded[1][0], expanded[1][1]);
  ctx.lineTo(expanded[2][0], expanded[2][1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function drawPerspectiveImage(ctx, image, corners, fast = false) {
  const homography = homographyToQuad(corners);
  if (!homography) return;
  const columns = fast ? 24 : 32;
  const sourceWidth = image.naturalWidth || image.width || 1;
  const sourceHeight = image.naturalHeight || image.height || 1;
  const rows = Math.max(4, Math.round(columns * sourceHeight / Math.max(1, sourceWidth)));
  for (let row = 0; row < rows; row += 1) {
    const v0 = row / rows;
    const v1 = (row + 1) / rows;
    for (let column = 0; column < columns; column += 1) {
      const u0 = column / columns;
      const u1 = (column + 1) / columns;
      const p00 = projectHomography(homography, u0, v0);
      const p10 = projectHomography(homography, u1, v0);
      const p11 = projectHomography(homography, u1, v1);
      const p01 = projectHomography(homography, u0, v1);
      const s00 = [u0 * sourceWidth, v0 * sourceHeight];
      const s10 = [u1 * sourceWidth, v0 * sourceHeight];
      const s11 = [u1 * sourceWidth, v1 * sourceHeight];
      const s01 = [u0 * sourceWidth, v1 * sourceHeight];
      drawImageTriangle(ctx, image, [s00, s10, s11], [p00, p10, p11]);
      drawImageTriangle(ctx, image, [s00, s11, s01], [p00, p11, p01]);
    }
  }
}

function clipPreviewToQuad(node, overlayCanvas, corners) {
  if (!Array.isArray(corners) || corners.length !== 4) return;
  const mask = node._myTextureQuadClipCanvas || document.createElement("canvas");
  node._myTextureQuadClipCanvas = mask;
  if (mask.width !== overlayCanvas.width || mask.height !== overlayCanvas.height) {
    mask.width = overlayCanvas.width;
    mask.height = overlayCanvas.height;
  }
  const maskCtx = mask.getContext("2d");
  maskCtx.clearRect(0, 0, mask.width, mask.height);
  maskCtx.fillStyle = "#fff";
  maskCtx.beginPath();
  maskCtx.moveTo(corners[0][0], corners[0][1]);
  for (let index = 1; index < corners.length; index += 1) maskCtx.lineTo(corners[index][0], corners[index][1]);
  maskCtx.closePath();
  maskCtx.fill();
  const overlayCtx = overlayCanvas.getContext("2d");
  overlayCtx.save();
  overlayCtx.globalCompositeOperation = "destination-in";
  overlayCtx.drawImage(mask, 0, 0);
  overlayCtx.restore();
}

function previewTextureSource(node) {
  const preview = node._myTexturePreview;
  const image = preview?.textureImage;
  if (!image) return image;
  const strokes = preview?.eraseStrokes;
  if (!Array.isArray(strokes) || !strokes.length) return image;
  const width = image.naturalWidth || image.width || 1;
  const height = image.naturalHeight || image.height || 1;
  const canvas = node._myTextureErasedSourceCanvas || document.createElement("canvas");
  node._myTextureErasedSourceCanvas = canvas;
  const revision = Number(node._myTextureEraseRevision) || 0;
  if (
    canvas.width === width
    && canvas.height === height
    && node._myTextureErasedSourceRevision === revision
    && node._myTextureErasedSourceImage === image
  ) return canvas;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  ctx.globalCompositeOperation = "destination-out";
  const stamp = (point, radius, hardness) => {
    const x = clamp(Number(point?.[0]) || 0, 0, 1) * width;
    const y = clamp(Number(point?.[1]) || 0, 0, 1) * height;
    const h = clamp(Number(hardness) || 0, 0, 100) / 100;
    const core = radius * (0.08 + Math.pow(h, 1.55) * 0.78);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(Math.min(0.96, core / Math.max(radius, 0.001)), "rgba(255,255,255,1)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const stroke of strokes) {
    const points = Array.isArray(stroke?.points) ? stroke.points : [];
    if (!points.length) continue;
    const radius = Math.max(0.75, (Number(stroke.size) || 0) * width / 2);
    const spacing = Math.max(0.75, radius * 0.22);
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      if (index === 0) {
        stamp(current, radius, stroke.hardness);
        continue;
      }
      const previous = points[index - 1];
      const dx = (Number(current[0]) - Number(previous[0])) * width;
      const dy = (Number(current[1]) - Number(previous[1])) * height;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        stamp([
          Number(previous[0]) + (Number(current[0]) - Number(previous[0])) * ratio,
          Number(previous[1]) + (Number(current[1]) - Number(previous[1])) * ratio,
        ], radius, stroke.hardness);
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
  node._myTextureErasedSourceRevision = revision;
  node._myTextureErasedSourceImage = image;
  return canvas;
}

function applyPreviewEraseStrokes(node, overlayCanvas, metrics) {
  const strokes = node._myTexturePreview?.eraseStrokes;
  if (!Array.isArray(strokes) || !strokes.length) return;
  const mask = node._myTextureEraseCanvas || document.createElement("canvas");
  node._myTextureEraseCanvas = mask;
  if (mask.width !== overlayCanvas.width || mask.height !== overlayCanvas.height) {
    mask.width = overlayCanvas.width;
    mask.height = overlayCanvas.height;
  }
  const maskCtx = mask.getContext("2d");
  maskCtx.clearRect(0, 0, mask.width, mask.height);
  const stamp = (point, radius, hardness) => {
    const x = metrics.drawX + Number(point[0]) * metrics.drawW;
    const y = metrics.drawY + Number(point[1]) * metrics.drawH;
    const h = clamp(Number(hardness) || 0, 0, 100) / 100;
    const core = radius * (0.06 + Math.pow(h, 1.7) * 0.7);
    const mid = radius * (0.48 + h * 0.18);
    const centerStrength = 1;
    const gradient = maskCtx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(255,255,255,${centerStrength})`);
    gradient.addColorStop(Math.min(0.92, core / radius), `rgba(255,255,255,${centerStrength})`);
    gradient.addColorStop(Math.min(0.96, mid / radius), `rgba(255,255,255,${centerStrength * 0.32})`);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    maskCtx.fillStyle = gradient;
    maskCtx.beginPath();
    maskCtx.arc(x, y, radius, 0, Math.PI * 2);
    maskCtx.fill();
  };
  for (const stroke of strokes) {
    const points = Array.isArray(stroke?.points) ? stroke.points : [];
    if (!points.length) continue;
    const radius = Math.max(0.5, Number(stroke.size) * metrics.drawW / 2);
    const spacing = Math.max(0.75, radius * 0.24);
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index];
      if (index === 0) {
        stamp(current, radius, stroke.hardness);
        continue;
      }
      const previous = points[index - 1];
      const dx = (Number(current[0]) - Number(previous[0])) * metrics.drawW;
      const dy = (Number(current[1]) - Number(previous[1])) * metrics.drawH;
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / spacing));
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        stamp([
          Number(previous[0]) + (Number(current[0]) - Number(previous[0])) * ratio,
          Number(previous[1]) + (Number(current[1]) - Number(previous[1])) * ratio,
        ], radius, stroke.hardness);
      }
    }
  }
  const overlayCtx = overlayCanvas.getContext("2d");
  overlayCtx.save();
  overlayCtx.globalCompositeOperation = "destination-out";
  overlayCtx.drawImage(mask, 0, 0);
  overlayCtx.restore();
}

function constrainedOffset(node, metrics, state) {
  const data = node._myTexturePreview;
  const texW = Number(data?.texture_width) || data?.textureImage?.naturalWidth || 1;
  const texH = Number(data?.texture_height) || data?.textureImage?.naturalHeight || 1;
  const stretchX = numberWidget(node, WIDGETS.stretchX, 1);
  const stretchY = numberWidget(node, WIDGETS.stretchY, 1);
  const widthNorm = state.scale[0] * stretchX;
  const heightNorm = (texH / Math.max(1, texW)) * state.scale[1] * stretchY * metrics.bgW / Math.max(1, metrics.bgH);
  const radians = Math.abs(state.rotation) * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const boundW = widthNorm * cos + heightNorm * sin;
  const boundH = widthNorm * sin + heightNorm * cos;
  return [
    clamp(state.offset[0], Math.max(0, (boundW - widthNorm) / 2), Math.max(0, 1 - (boundW + widthNorm) / 2)),
    clamp(state.offset[1], Math.max(0, (boundH - heightNorm) / 2), Math.max(0, 1 - (boundH + heightNorm) / 2)),
  ];
}

function normalizeTransformToPreview(node, metrics) {
  const state = transformState(node);
  if (state.freeTransform && state.corners) return state;
  const offset = constrainedOffset(node, metrics, state);
  if (Math.abs(offset[0] - state.offset[0]) < 0.0001 && Math.abs(offset[1] - state.offset[1]) < 0.0001) return state;
  updateTransformState(node, { offset });
  return { ...state, offset };
}

function previewMaskCanvas(node, metrics) {
  const maskImage = node._myTexturePreview?.maskImage;
  if (!maskImage) return null;
  const canvas = node._myTextureMaskCanvas || document.createElement("canvas");
  node._myTextureMaskCanvas = canvas;
  if (canvas.width !== node._myTextureCanvas.width || canvas.height !== node._myTextureCanvas.height) {
    canvas.width = node._myTextureCanvas.width;
    canvas.height = node._myTextureCanvas.height;
    node._myTextureMaskCanvasReady = false;
  }
  if (node._myTextureMaskCanvasReady && node._myTextureMaskSource === maskImage) return canvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(maskImage, metrics.drawX, metrics.drawY, metrics.drawW, metrics.drawH);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const value = pixels.data[index];
    // Preserve the full antialiased silhouette. Older builds discarded the
    // lower half of the transition and visibly uncovered the sleeve/torso
    // edge. RMBG already supplies the boundary; only reject its faintest halo.
    const coverage = clamp((value / 255 - 0.08) / 0.84, 0, 1);
    const smoothCoverage = coverage * coverage * (3 - 2 * coverage);
    pixels.data[index] = 255;
    pixels.data[index + 1] = 255;
    pixels.data[index + 2] = 255;
    pixels.data[index + 3] = Math.round(smoothCoverage * 255);
  }
  ctx.putImageData(pixels, 0, 0);
  node._myTextureMaskSource = maskImage;
  node._myTextureMaskCanvasReady = true;
  return canvas;
}

function previewDepthCanvas(node, metrics) {
  const depthImage = node._myTexturePreview?.depthImage;
  if (!depthImage) return null;
  const canvas = node._myTextureDepthCanvas || document.createElement("canvas");
  node._myTextureDepthCanvas = canvas;
  if (canvas.width !== node._myTextureCanvas.width || canvas.height !== node._myTextureCanvas.height) {
    canvas.width = node._myTextureCanvas.width;
    canvas.height = node._myTextureCanvas.height;
    node._myTextureDepthCanvasReady = false;
  }
  if (node._myTextureDepthCanvasReady && node._myTextureDepthSource === depthImage) return canvas;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(depthImage, metrics.drawX, metrics.drawY, metrics.drawW, metrics.drawH);
  // Keep a small, smoothly resampled depth field for drag frames.  The full
  // depth canvas remains available for the release-quality render, while this
  // cache lets the same geometric deformation run every pointer frame.
  const fieldCanvas = node._myTextureDepthFieldCanvas || document.createElement("canvas");
  node._myTextureDepthFieldCanvas = fieldCanvas;
  const fieldScale = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
  fieldCanvas.width = Math.max(1, Math.round(canvas.width * fieldScale));
  fieldCanvas.height = Math.max(1, Math.round(canvas.height * fieldScale));
  const fieldCtx = fieldCanvas.getContext("2d");
  fieldCtx.clearRect(0, 0, fieldCanvas.width, fieldCanvas.height);
  fieldCtx.imageSmoothingEnabled = true;
  fieldCtx.drawImage(canvas, 0, 0, fieldCanvas.width, fieldCanvas.height);
  node._myTextureDepthFieldScale = fieldScale;
  node._myTextureDepthFieldReady = true;
  node._myTextureDepthSource = depthImage;
  node._myTextureDepthCanvasReady = true;
  return canvas;
}

function applyPreviewDepthWarp(node, metrics, overlayCanvas, box, strength, fast = false) {
  const amountStrength = clamp(Number(strength) || 0, 0, 1);
  const depthCanvas = previewDepthCanvas(node, metrics);
  const overlayCtx = overlayCanvas.getContext("2d");
  const depthCtx = depthCanvas?.getContext("2d");
  if (!depthCanvas || !overlayCtx || !depthCtx || amountStrength <= 0.0001) return;
  // Depth scaling can move visible pixels outside the original quad bounds.
  // Keep a transparent guard band so fine strokes near an edge are not
  // cropped before inverse sampling has a chance to move them.
  const warpMargin = Math.ceil(Math.max(box.width, box.height) * amountStrength * 0.12) + 4;
  const left = Math.max(0, Math.floor(box.cx - box.width / 2) - warpMargin);
  const right = Math.min(overlayCanvas.width, Math.ceil(box.cx + box.width / 2) + warpMargin);
  const top = Math.max(0, Math.floor(box.cy - box.height / 2) - warpMargin);
  const bottom = Math.min(overlayCanvas.height, Math.ceil(box.cy + box.height / 2) + warpMargin);
  const width = right - left;
  const height = bottom - top;
  if (width < 4 || height < 4) return;
  const source = overlayCtx.getImageData(left, top, width, height);
  const depth = depthCtx.getImageData(left, top, width, height);
  const result = overlayCtx.createImageData(width, height);
  result.data.set(source.data);

  if (fast && node._myTextureDepthFieldReady && node._myTextureDepthFieldCanvas) {
    // Drag path: read the cached low-resolution field, but keep exactly the
    // same radial depth deformation and premultiplied-alpha sampling as the
    // release path.  This is deliberately geometry, not a post-release effect.
    const fieldCanvas = node._myTextureDepthFieldCanvas;
    const fieldData = fieldCanvas.getContext("2d").getImageData(0, 0, fieldCanvas.width, fieldCanvas.height).data;
    const fieldScale = Number(node._myTextureDepthFieldScale) || 1;
    const depthAtGlobal = (gx, gy) => {
      const fx = clamp(gx * fieldScale, 0, fieldCanvas.width - 1);
      const fy = clamp(gy * fieldScale, 0, fieldCanvas.height - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(fieldCanvas.width - 1, x0 + 1);
      const y1 = Math.min(fieldCanvas.height - 1, y0 + 1);
      const wx = fx - x0;
      const wy = fy - y0;
      const at = (px, py) => fieldData[(py * fieldCanvas.width + px) * 4] / 255;
      return at(x0, y0) * (1 - wx) * (1 - wy) + at(x1, y0) * wx * (1 - wy)
        + at(x0, y1) * (1 - wx) * wy + at(x1, y1) * wx * wy;
    };
    const samples = [];
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        if (source.data[(y * width + x) * 4 + 3] > 4) samples.push(depthAtGlobal(left + x, top + y));
      }
    }
    samples.sort((a, b) => a - b);
    const percentile = (ratio, fallback) => samples.length
      ? samples[Math.min(samples.length - 1, Math.max(0, Math.floor((samples.length - 1) * ratio)))]
      : fallback;
    const low = percentile(0.10, 0);
    const high = percentile(0.90, 1);
    const depthRange = Math.max(high - low, 0.05);
    const midpoint = (low + high) * 0.5;
    const gain = amountStrength * 0.18;
    const centerX = (width - 1) * 0.5;
    const centerY = (height - 1) * 0.5;
    const sample = (px, py, channel) => source.data[(py * width + px) * 4 + channel];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        const field = clamp((depthAtGlobal(left + x, top + y) - midpoint) / depthRange, -1, 1);
        const scaleX = clamp(1 + gain * field, 0.82, 1.18);
        const scaleY = clamp(1 + gain * 0.45 * field, 0.90, 1.10);
        const sx = clamp(centerX + (x - centerX) / scaleX, 0, width - 1);
        const sy = clamp(centerY + (y - centerY) / scaleY, 0, height - 1);
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(width - 1, x0 + 1);
        const y1 = Math.min(height - 1, y0 + 1);
        const wx = sx - x0;
        const wy = sy - y0;
        const alpha = sample(x0, y0, 3) * (1 - wx) * (1 - wy) + sample(x1, y0, 3) * wx * (1 - wy)
          + sample(x0, y1, 3) * (1 - wx) * wy + sample(x1, y1, 3) * wx * wy;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = sample(x0, y0, channel) * (1 - wx) * (1 - wy) * sample(x0, y0, 3)
            + sample(x1, y0, channel) * wx * (1 - wy) * sample(x1, y0, 3)
            + sample(x0, y1, channel) * (1 - wx) * wy * sample(x0, y1, 3)
            + sample(x1, y1, channel) * wx * wy * sample(x1, y1, 3);
          result.data[index + channel] = alpha > 0.5 ? Math.round(value / alpha) : 0;
        }
        result.data[index + 3] = Math.round(alpha);
      }
    }
    overlayCtx.putImageData(result, left, top);
    return;
  }

  // Match the backend's stable depth-field warp: blur the depth map into a
  // low-frequency surface field, then apply a gentle radial scale.  A raw
  // pixel-gradient displacement makes anti-aliased logo strokes tear apart.
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.035));
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const value = depth.data[(y * width + x) * 4] / 255;
      rowSum += value;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  const blurredValues = new Float32Array(width * height);
  const samples = [];
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum = integral[(y1 + 1) * stride + x1 + 1]
        - integral[y0 * stride + x1 + 1]
        - integral[(y1 + 1) * stride + x0]
        + integral[y0 * stride + x0];
      const value = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      blurredValues[y * width + x] = value;
      if (source.data[(y * width + x) * 4 + 3] > 4 && (x % 2 === 0) && (y % 2 === 0)) samples.push(value);
    }
  }
  samples.sort((a, b) => a - b);
  const percentile = (ratio, fallback) => samples.length
    ? samples[Math.min(samples.length - 1, Math.max(0, Math.floor((samples.length - 1) * ratio)))]
    : fallback;
  const low = percentile(0.10, 0);
  const high = percentile(0.90, 1);
  const depthRange = Math.max(high - low, 0.05);
  const midpoint = (low + high) * 0.5;
  const gain = amountStrength * 0.18;
  const centerX = (width - 1) * 0.5;
  const centerY = (height - 1) * 0.5;
  const sample = (px, py, channel) => source.data[(py * width + px) * 4 + channel];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const field = clamp((blurredValues[y * width + x] - midpoint) / depthRange, -1, 1);
      const scaleX = clamp(1 + gain * field, 0.82, 1.18);
      const scaleY = clamp(1 + gain * 0.45 * field, 0.90, 1.10);
      const sx = clamp(centerX + (x - centerX) / scaleX, 0, width - 1);
      const sy = clamp(centerY + (y - centerY) / scaleY, 0, height - 1);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const wx = sx - x0;
      const wy = sy - y0;
      const alpha = sample(x0, y0, 3) * (1 - wx) * (1 - wy) + sample(x1, y0, 3) * wx * (1 - wy)
        + sample(x0, y1, 3) * (1 - wx) * wy + sample(x1, y1, 3) * wx * wy;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = sample(x0, y0, channel) * (1 - wx) * (1 - wy) * sample(x0, y0, 3)
          + sample(x1, y0, channel) * wx * (1 - wy) * sample(x1, y0, 3)
          + sample(x0, y1, channel) * (1 - wx) * wy * sample(x0, y1, 3)
          + sample(x1, y1, channel) * wx * wy * sample(x1, y1, 3);
        result.data[index + channel] = alpha > 0.5 ? Math.round(value / alpha) : 0;
      }
      result.data[index + 3] = Math.round(alpha);
    }
  }
  overlayCtx.putImageData(result, left, top);
  // Keep the legacy reference implementation below for comparison only.
  return;
  /*
  const depthCanvas = previewDepthCanvas(node, metrics);
  if (!depthCanvas || strength <= 0.0001) return;
  const overlayCtx = overlayCanvas.getContext("2d");
  const source = overlayCtx.getImageData(0, 0, overlayCanvas.width, overlayCanvas.height);
  const depth = depthCanvas.getContext("2d").getImageData(0, 0, overlayCanvas.width, overlayCanvas.height);
  // The main canvas contains the clean background at this point. Reading its
  // luminance lets the interactive preview inherit the same shirt shadows and
  // highlights as the backend composite.
  const background = node._myTextureCanvas.getContext("2d").getImageData(
    0, 0, overlayCanvas.width, overlayCanvas.height,
  );
  const result = overlayCtx.createImageData(overlayCanvas.width, overlayCanvas.height);
  result.data.set(source.data);
  const left = Math.max(1, Math.floor(box.cx - box.width / 2));
  const right = Math.min(overlayCanvas.width - 2, Math.ceil(box.cx + box.width / 2));
  const top = Math.max(1, Math.floor(box.cy - box.height / 2));
  const bottom = Math.min(overlayCanvas.height - 2, Math.ceil(box.cy + box.height / 2));
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(Math.max(1, (right - left) * (bottom - top)) / 12000)));
  const gradients = [];
  const luminances = [];
  for (let y = top; y <= bottom; y += sampleStep) {
    for (let x = left; x <= right; x += sampleStep) {
      const index = (y * overlayCanvas.width + x) * 4;
      if (source.data[index + 3] <= 4) continue;
      const dx = (depth.data[index + 4] - depth.data[index - 4]) / 510;
      const dy = (depth.data[index + overlayCanvas.width * 4] - depth.data[index - overlayCanvas.width * 4]) / 510;
      gradients.push(Math.hypot(dx, dy));
      luminances.push(
        (background.data[index] * 0.2126
          + background.data[index + 1] * 0.7152
          + background.data[index + 2] * 0.0722) / 255,
      );
    }
  }
  gradients.sort((a, b) => a - b);
  luminances.sort((a, b) => a - b);
  const percentile = (values, ratio, fallback) => {
    if (!values.length) return fallback;
    return values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * ratio)))];
  };
  const gradientReference = Math.max(0.003, percentile(gradients, 0.95, 0.003));
  const luminanceLow = percentile(luminances, 0.05, 0);
  const luminanceHigh = Math.max(luminanceLow + 0.001, percentile(luminances, 0.95, 1));
  const amount = clamp(strength, 0, 1) * 0.10 * Math.min(box.width, box.height);
  const shadeStrength = 0.70 * Math.max(0.25, Math.min(1, strength));
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const index = (y * overlayCanvas.width + x) * 4;
      const dx = clamp((depth.data[index + 4] - depth.data[index - 4]) / 510 / gradientReference, -1, 1);
      const dy = clamp(
        (depth.data[index + overlayCanvas.width * 4] - depth.data[index - overlayCanvas.width * 4]) / 510 / gradientReference,
        -1,
        1,
      );
      const sourceX = clamp(Math.round(x - dx * amount), 0, overlayCanvas.width - 1);
      const sourceY = clamp(Math.round(y - dy * amount), 0, overlayCanvas.height - 1);
      const sourceIndex = (sourceY * overlayCanvas.width + sourceX) * 4;
      const luminance = (
        background.data[index] * 0.2126
          + background.data[index + 1] * 0.7152
          + background.data[index + 2] * 0.0722
      ) / 255;
      const normalizedLuminance = clamp((luminance - luminanceLow) / (luminanceHigh - luminanceLow), 0, 1);
      const shade = 1 + (normalizedLuminance - 0.62) * shadeStrength;
      result.data[index] = clamp(Math.round(source.data[sourceIndex] * shade), 0, 255);
      result.data[index + 1] = clamp(Math.round(source.data[sourceIndex + 1] * shade), 0, 255);
      result.data[index + 2] = clamp(Math.round(source.data[sourceIndex + 2] * shade), 0, 255);
      result.data[index + 3] = source.data[sourceIndex + 3];
    }
  }
  overlayCtx.putImageData(result, 0, 0);
  */
}

function applyPreviewSurfaceLighting(node, overlayCanvas, box, strength) {
  const amount = clamp(Number(strength) || 0, 0, 1);
  if (amount <= 0.0001) return;
  const overlayCtx = overlayCanvas.getContext("2d");
  const backgroundCtx = node._myTextureCanvas?.getContext("2d");
  if (!overlayCtx || !backgroundCtx) return;

  // Use a rotation-safe square around the sticker, but never read the whole
  // 2048px preview.  This runs only after release; drag frames stay lightweight.
  const halfDiagonal = Math.ceil(Math.hypot(box.width, box.height) / 2) + 2;
  const left = Math.max(0, Math.floor(box.cx - halfDiagonal));
  const top = Math.max(0, Math.floor(box.cy - halfDiagonal));
  const right = Math.min(overlayCanvas.width, Math.ceil(box.cx + halfDiagonal));
  const bottom = Math.min(overlayCanvas.height, Math.ceil(box.cy + halfDiagonal));
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) return;

  const source = overlayCtx.getImageData(left, top, width, height);
  const background = backgroundCtx.getImageData(left, top, width, height);
  const count = width * height;
  const luminance = new Float32Array(count);
  const samples = [];
  const sampleStep = Math.max(1, Math.floor(Math.sqrt(count / 6000)));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      const value = (
        background.data[index] * 0.2126
          + background.data[index + 1] * 0.7152
          + background.data[index + 2] * 0.0722
      ) / 255;
      luminance[pixel] = value;
      if (source.data[index + 3] > 4 && x % sampleStep === 0 && y % sampleStep === 0) samples.push(value);
    }
  }
  if (!samples.length) return;
  samples.sort((a, b) => a - b);
  const percentile = (ratio) => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * ratio))];
  const low = percentile(0.05);
  const high = percentile(0.95);
  if (high - low < 0.005) return;

  // Integral-image box blur supplies the low-frequency garment lighting.
  // The luminance/blur ratio is the fold detail, so no source coordinate is
  // ever changed and transparent artwork cannot tear into horizontal bands.
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let rowSum = 0;
    for (let x = 1; x <= width; x += 1) {
      rowSum += luminance[(y - 1) * width + x - 1];
      integral[y * stride + x] = integral[(y - 1) * stride + x] + rowSum;
    }
  }
  const radius = Math.max(2, Math.round(Math.min(box.width, box.height) * 0.025));
  const baseGain = 0.22 * amount;
  const foldGain = 2.85 * amount;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const index = pixel * 4;
      if (source.data[index + 3] <= 4) continue;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum = integral[(y1 + 1) * stride + x1 + 1]
        - integral[y0 * stride + x1 + 1]
        - integral[(y1 + 1) * stride + x0]
        + integral[y0 * stride + x0];
      const blurred = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      const baseNormalized = clamp((blurred - low) / Math.max(high - low, 0.005), 0, 1);
      const foldDetail = clamp(Math.log((luminance[pixel] + 0.04) / (blurred + 0.04)), -0.30, 0.24);
      const shade = clamp((1 + (baseNormalized - 0.55) * baseGain) * Math.exp(foldDetail * foldGain), 0.62, 1.32);
      source.data[index] = clamp(Math.round(source.data[index] * shade), 0, 255);
      source.data[index + 1] = clamp(Math.round(source.data[index + 1] * shade), 0, 255);
      source.data[index + 2] = clamp(Math.round(source.data[index + 2] * shade), 0, 255);
    }
  }
  overlayCtx.putImageData(source, left, top);
}

function applyPreviewDefringe(overlayCanvas, box) {
  const ctx = overlayCanvas?.getContext("2d");
  if (!ctx || !box) return;
  const margin = 4;
  const left = Math.max(0, Math.floor(box.cx - box.width / 2) - margin);
  const top = Math.max(0, Math.floor(box.cy - box.height / 2) - margin);
  const right = Math.min(overlayCanvas.width, Math.ceil(box.cx + box.width / 2) + margin);
  const bottom = Math.min(overlayCanvas.height, Math.ceil(box.cy + box.height / 2) + margin);
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) return;
  const pixels = ctx.getImageData(left, top, width, height);
  const alpha = new Uint8ClampedArray(width * height);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = pixels.data[pixel * 4 + 3];
  for (let pass = 0; pass < 3; pass += 1) {
    const bestAlpha = new Uint8ClampedArray(alpha);
    const bestRgb = new Uint8ClampedArray(pixels.data);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (alpha[neighbor] <= bestAlpha[pixel]) continue;
          bestAlpha[pixel] = alpha[neighbor];
          bestRgb[pixel * 4] = pixels.data[neighbor * 4];
          bestRgb[pixel * 4 + 1] = pixels.data[neighbor * 4 + 1];
          bestRgb[pixel * 4 + 2] = pixels.data[neighbor * 4 + 2];
        }
      }
    }
    for (let pixel = 0; pixel < alpha.length; pixel += 1) {
      if (alpha[pixel] < 220) {
        pixels.data[pixel * 4] = bestRgb[pixel * 4];
        pixels.data[pixel * 4 + 1] = bestRgb[pixel * 4 + 1];
        pixels.data[pixel * 4 + 2] = bestRgb[pixel * 4 + 2];
      }
    }
    alpha.set(bestAlpha);
  }
  ctx.putImageData(pixels, left, top);
}

function canvasCssScale(node) {
  const canvas = node._myTextureCanvas;
  const layer = node._myTextureControlLayer;
  if (!canvas || !layer) return { x: 1, y: 1, left: 0, top: 0 };
  const canvasRect = canvas.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  // LiteGraph scales the whole node with a CSS transform. getBoundingClientRect
  // therefore reports the zoomed size, while style coordinates are expressed
  // in the node's unscaled layout space. Keep both scales separate.
  const layoutWidth = canvas.clientWidth || parseFloat(getComputedStyle(canvas).width) || canvasRect.width;
  const layoutHeight = canvas.clientHeight || parseFloat(getComputedStyle(canvas).height) || canvasRect.height;
  return {
    x: canvas.width ? layoutWidth / canvas.width : 1,
    y: canvas.height ? layoutHeight / canvas.height : 1,
    screenX: layoutWidth ? canvasRect.width / layoutWidth : 1,
    screenY: layoutHeight ? canvasRect.height / layoutHeight : 1,
    left: canvas.offsetLeft || 0,
    top: canvas.offsetTop || 0,
    screenLeft: layerRect.left,
    screenTop: layerRect.top,
  };
}

function schedulePreviewDraw(node, fast = false) {
  node._myTexturePendingFast = Boolean(node._myTexturePendingFast || fast);
  if (node._myTextureDrawFrame) return;
  node._myTextureDrawFrame = requestAnimationFrame(() => {
    node._myTextureDrawFrame = 0;
    const pendingFast = Boolean(node._myTexturePendingFast);
    node._myTexturePendingFast = false;
    drawPreview(node, { fast: pendingFast });
  });
}

function drawPreview(node, options = {}) {
  const fast = options.fast === true;
  const canvas = node._myTextureCanvas;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;
  // Use the unscaled CSS layout size. The node itself can be zoomed by
  // LiteGraph; using getBoundingClientRect() here would shrink the internal
  // canvas coordinate system every time the node is viewed at a different zoom.
  const layoutWidth = canvas.clientWidth || parseFloat(getComputedStyle(canvas).width) || 1;
  const layoutHeight = canvas.clientHeight || parseFloat(getComputedStyle(canvas).height) || 1;
  let backingScale = window.devicePixelRatio || 1;
  const previewData = node._myTexturePreview;
  if (previewData?.backgroundImage) {
    const bgW = Number(previewData.background_width) || previewData.backgroundImage.naturalWidth || 1;
    const bgH = Number(previewData.background_height) || previewData.backgroundImage.naturalHeight || 1;
    const cssFit = Math.min(Math.max(1, layoutWidth - 36) / bgW, Math.max(1, layoutHeight - 36) / bgH);
    const cssLongSide = Math.max(bgW * cssFit, bgH * cssFit);
    const targetLongSide = fast ? Math.min(PREVIEW_RENDER_LONG_SIDE, 1600) : PREVIEW_RENDER_LONG_SIDE;
    if (fast) backingScale = Math.min(backingScale, targetLongSide / Math.max(1, Math.max(layoutWidth, layoutHeight)));
    backingScale = Math.max(backingScale, targetLongSide / Math.max(1, cssLongSide));
    backingScale = Math.min(backingScale, 4096 / Math.max(layoutWidth, layoutHeight));
  }
  node._myTextureBackingScale = backingScale;
  const width = Math.max(1, Math.round(layoutWidth * backingScale));
  const height = Math.max(1, Math.round(layoutHeight * backingScale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#161719";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const metrics = previewMetrics(node);
  if (!metrics) {
    hideTransformOverlay(node);
    ctx.fillStyle = "rgba(255,255,255,.62)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(13 * window.devicePixelRatio)}px Arial`;
    ctx.fillText("点击“执行预览”加载底图和贴图", canvas.width / 2, canvas.height / 2);
    return;
  }

  normalizeTransformToPreview(node, metrics);

  drawChecker(ctx, metrics.drawX, metrics.drawY, metrics.drawW, metrics.drawH, 18 * (node._myTextureBackingScale || 1));
  ctx.drawImage(node._myTexturePreview.backgroundImage, metrics.drawX, metrics.drawY, metrics.drawW, metrics.drawH);
  const box = textureBox(node, metrics);
  const opacity = numberWidget(node, WIDGETS.opacity, 1);
  const skewX = numberWidget(node, WIDGETS.skewX, 0);
  const skewY = numberWidget(node, WIDGETS.skewY, 0);
  const blendMode = String(findWidget(node, WIDGETS.blendMode)?.value || "normal");
  const canvasBlendModes = {
    normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay",
    darken: "darken", lighten: "lighten", "color-dodge": "color-dodge",
    "color-burn": "color-burn", "soft-light": "soft-light", "hard-light": "hard-light",
    hologram: "screen",
  };
  const overlayCanvas = node._myTextureOverlayCanvas || document.createElement("canvas");
  node._myTextureOverlayCanvas = overlayCanvas;
  if (overlayCanvas.width !== canvas.width || overlayCanvas.height !== canvas.height) {
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
  }
  const overlayCtx = overlayCanvas.getContext("2d");
  overlayCtx.imageSmoothingEnabled = true;
  overlayCtx.imageSmoothingQuality = "high";
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  let renderBox = box;
  const freeCorners = stateCornersCanvas(box.state, metrics, box);
  const textureSource = previewTextureSource(node);
  if (box.state.freeTransform && freeCorners && isUsableQuad(box.state.corners)) {
    drawPerspectiveImage(overlayCtx, textureSource, freeCorners, fast);
    renderBox = quadBounds(freeCorners, box.state);
  } else {
    overlayCtx.save();
    overlayCtx.translate(box.cx, box.cy);
    overlayCtx.rotate(box.state.rotation * Math.PI / 180);
    overlayCtx.transform(1, skewY, skewX, 1, 0, 0);
    overlayCtx.drawImage(textureSource, -box.width / 2, -box.height / 2, box.width, box.height);
    overlayCtx.restore();
  }
  // Pointer frames keep the same depth geometry as the release render. The
  // cached low-frequency field avoids the old blocky planar placeholder.
  applyPreviewDepthWarp(
    node,
    metrics,
    overlayCanvas,
    renderBox,
    numberWidget(node, WIDGETS.deformation, 0),
    fast,
  );
  if (!fast) {
    applyPreviewSurfaceLighting(node, overlayCanvas, renderBox, numberWidget(node, WIDGETS.deformation, 0));
    applyPreviewDefringe(overlayCanvas, renderBox);
  }
  // Depth deformation intentionally has a guard band, but visible pixels must
  // never escape the user's four-point paste area.
  if (box.state.freeTransform && freeCorners && isUsableQuad(box.state.corners)) {
    clipPreviewToQuad(node, overlayCanvas, freeCorners);
  }
  // The eraser has already modified the source alpha, so the erased content
  // follows every move, perspective change and depth deformation.
  // Apply the subject mask only after every geometric resample.  Masking first
  // permanently deletes source pixels near the garment edge; the subsequent
  // depth warp then magnifies that missing area.  This ordering also matches
  // the backend paste path.
  const maskCanvas = previewMaskCanvas(node, metrics);
  if (maskCanvas) {
    overlayCtx.save();
    overlayCtx.globalCompositeOperation = "destination-in";
    overlayCtx.drawImage(maskCanvas, 0, 0);
    overlayCtx.restore();
  }
  // Keep the editor rectangle tied to the stable transform geometry. Do not
  // recompute it from rendered alpha pixels: progressive/low-res image decode
  // can change edge pixels and would make the handles jump after sharpening.
  node._myTextureRenderBox = renderBox;
  ctx.save();
  ctx.beginPath();
  ctx.rect(metrics.drawX, metrics.drawY, metrics.drawW, metrics.drawH);
  ctx.clip();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = canvasBlendModes[blendMode] || "source-over";
  ctx.drawImage(overlayCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.restore();
  updateTransformOverlay(node, metrics, renderBox);
}

function updateTransformOverlay(node, metrics = previewMetrics(node), box = metrics && (node._myTextureRenderBox || textureBox(node, metrics))) {
  const layer = node._myTextureControlLayer;
  if (!layer || !metrics || !box) return;
  const rotation = box.state.rotation;
  layer.style.display = "block";
  const boxEl = layer.querySelector(".mytexture-transform-box");
  const lines = layer.querySelector(".mytexture-transform-lines");
  const css = canvasCssScale(node);
  const state = transformState(node);
  if (state.freeTransform && state.corners && isUsableQuad(state.corners)) {
    const canvasCorners = stateCornersCanvas(state, metrics);
    const layoutCorners = canvasCorners.map(([x, y]) => [css.left + x * css.x, css.top + y * css.y]);
    const center = quadCenter(layoutCorners);
    const topMiddle = [
      (layoutCorners[0][0] + layoutCorners[1][0]) / 2,
      (layoutCorners[0][1] + layoutCorners[1][1]) / 2,
    ];
    let normal = [topMiddle[0] - center[0], topMiddle[1] - center[1]];
    const length = Math.max(0.0001, Math.hypot(normal[0], normal[1]));
    normal = [normal[0] / length, normal[1] / length];
    const rotatePoint = [topMiddle[0] + normal[0] * 33, topMiddle[1] + normal[1] * 33];

    boxEl.classList.add("free");
    boxEl.style.left = "0px";
    boxEl.style.top = "0px";
    boxEl.style.width = "100%";
    boxEl.style.height = "100%";
    boxEl.style.transform = "none";
    for (let index = 0; index < QUAD_KEYS.length; index += 1) {
      const point = boxEl.querySelector(`.corner.${QUAD_KEYS[index]}`);
      point.style.left = `${layoutCorners[index][0]}px`;
      point.style.top = `${layoutCorners[index][1]}px`;
    }
    const rotate = boxEl.querySelector(".rotate");
    rotate.style.left = `${rotatePoint[0]}px`;
    rotate.style.top = `${rotatePoint[1]}px`;
    boxEl.querySelector(".mytexture-transform-stem").style.display = "none";
    if (lines) {
      lines.style.display = "block";
      lines.querySelector("polygon").setAttribute("points", layoutCorners.map((point) => point.join(",")).join(" "));
      const stem = lines.querySelector("line");
      stem.setAttribute("x1", String(topMiddle[0]));
      stem.setAttribute("y1", String(topMiddle[1]));
      stem.setAttribute("x2", String(rotatePoint[0]));
      stem.setAttribute("y2", String(rotatePoint[1]));
    }
    return;
  }

  boxEl.classList.remove("free");
  if (lines) lines.style.display = "none";
  boxEl.style.left = `${css.left + box.cx * css.x}px`;
  boxEl.style.top = `${css.top + box.cy * css.y}px`;
  boxEl.style.width = `${box.width * css.x}px`;
  boxEl.style.height = `${box.height * css.y}px`;
  // Slider skew belongs to the sticker raster only.  The editor frame and
  // its circular handles remain a stable, non-skewed rectangle.
  boxEl.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
  const boxWidth = box.width * css.x;
  const boxHeight = box.height * css.y;
  const corners = {
    nw: [0, 0],
    ne: [boxWidth, 0],
    se: [boxWidth, boxHeight],
    sw: [0, boxHeight],
  };
  for (const [name, [x, y]] of Object.entries(corners)) {
    const point = boxEl.querySelector(`.corner.${name}`);
    point.style.left = `${x}px`;
    point.style.top = `${y}px`;
  }
  const rotate = boxEl.querySelector(".rotate");
  rotate.style.left = "50%";
  rotate.style.top = "-33px";
  boxEl.querySelector(".mytexture-transform-stem").style.display = "block";
}

function hideTransformOverlay(node) {
  if (node._myTextureControlLayer) node._myTextureControlLayer.style.display = "none";
}

function setStatus(node, text, tone = "normal") {
  if (!node._myTextureStatus) return;
  node._myTextureStatus.textContent = text;
  node._myTextureStatus.dataset.tone = tone;
}

function updateFooter(node) {
  const data = node._myTexturePreview;
  if (!node._myTextureSize) return;
  node._myTextureSize.textContent = data ? `${data.background_width} x ${data.background_height}` : "";
}

function updateSliderVisual(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const value = Number(input.value) || 0;
  const pct = clamp((value - min) / Math.max(0.0001, max - min) * 100, 0, 100);
  input.style.setProperty("--pct", `${pct}%`);
}

function syncControlsFromWidgets(node) {
  for (const item of SLIDERS) {
    const widget = findWidget(node, WIDGETS[item.key]);
    const row = node._myTextureControls?.get(item.key);
    if (!widget || !row) continue;
    const value = clamp(Number(widget.value), item.min, item.max);
    row.input.value = String(value);
    row.value.textContent = formatValue(value, item);
    updateSliderVisual(row.input);
  }
  for (const item of SELECTS) {
    const widget = findWidget(node, WIDGETS[item.key]);
    const select = node._myTextureSelects?.get(item.key);
    if (!widget || !select) continue;
    select.value = String(widget.value ?? "");
  }
  syncFreeTransformUi(node);
}

function createSlider(node, item) {
  const widget = findWidget(node, WIDGETS[item.key]);
  const control = document.createElement("label");
  control.className = "mytexture-control";
  const labelRow = document.createElement("div");
  labelRow.className = "mytexture-label-row";
  const label = document.createElement("span");
  label.className = "mytexture-label";
  label.textContent = item.label;
  const value = document.createElement("span");
  value.className = "mytexture-value";
  const input = document.createElement("input");
  input.className = "mytexture-slider";
  input.type = "range";
  input.min = String(item.min);
  input.max = String(item.max);
  input.step = String(item.step);
  input.value = String(widget?.value ?? item.default);
  labelRow.append(label, value);
  control.append(labelRow, input);

  const update = () => {
    const next = Number(input.value);
    value.textContent = formatValue(next, item);
    updateSliderVisual(input);
    setWidgetValue(node, WIDGETS[item.key], next);
    schedulePreviewDraw(node, true);
  };
  input.addEventListener("input", update);
  input.addEventListener("change", update);
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  update();
  node._myTextureControls.set(item.key, { input, value, element: control });
  return control;
}

function createSelect(node, item) {
  const widget = findWidget(node, WIDGETS[item.key]);
  const control = document.createElement("label");
  control.className = "mytexture-control mytexture-select-control";
  const labelRow = document.createElement("div");
  labelRow.className = "mytexture-label-row";
  const label = document.createElement("span");
  label.className = "mytexture-label";
  label.textContent = item.label;
  const select = document.createElement("select");
  select.className = "mytexture-select";
  for (const optionValue of widget?.options?.values || item.values || []) {
    const option = document.createElement("option");
    option.value = String(optionValue);
    option.textContent = item.labels?.[optionValue] || String(optionValue);
    select.appendChild(option);
  }
  select.value = String(widget?.value ?? item.default ?? "");
  labelRow.append(label);
  control.append(labelRow, select);
  select.addEventListener("change", () => {
    setWidgetValue(node, WIDGETS[item.key], select.value);
    schedulePreviewDraw(node, false);
  });
  select.addEventListener("pointerdown", (event) => event.stopPropagation());
  node._myTextureSelects.set(item.key, select);
  return control;
}

function syncFreeTransformUi(node) {
  const button = node._myTextureFreeButton;
  if (!button) return;
  const enabled = transformState(node).freeTransform;
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  button.textContent = enabled ? "自由变换：已启用" : "自由变换：关闭";
  button.disabled = !node._myTexturePreview;
  for (const key of ["skewX", "skewY", "stretchX", "stretchY"]) {
    const control = node._myTextureControls?.get(key);
    if (!control) continue;
    control.input.disabled = enabled;
    control.element?.classList.toggle("is-free-disabled", enabled);
  }
}

function setFreeTransformEnabled(node, enabled) {
  const metrics = previewMetrics(node);
  if (!metrics) return;
  const state = transformState(node);
  if (enabled && !state.freeTransform) {
    const box = textureBox(node, metrics);
    const corners = boxCorners(box).map(([x, y]) => [
      clamp((x - metrics.drawX) / metrics.drawW, 0, 1),
      clamp((y - metrics.drawY) / metrics.drawH, 0, 1),
    ]);
    if (!isUsableQuad(corners)) return;
    updateTransformState(node, { freeTransform: true, corners });
  } else if (!enabled && state.freeTransform && state.corners) {
    const xs = state.corners.map((point) => point[0]);
    const ys = state.corners.map((point) => point[1]);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const widthNorm = Math.max(0.001, Math.max(...xs) - left);
    const heightNorm = Math.max(0.001, Math.max(...ys) - top);
    const data = node._myTexturePreview;
    const texW = Number(data.texture_width) || data.textureImage.naturalWidth || 1;
    const texH = Number(data.texture_height) || data.textureImage.naturalHeight || 1;
    updateTransformState(node, {
      offset: [left, top],
      scale: [
        clamp(widthNorm, 0.001, 4),
        clamp(heightNorm * metrics.bgH / metrics.bgW * texW / Math.max(1, texH), 0.001, 4),
      ],
      rotation: 0,
      freeTransform: false,
      corners: null,
    });
  }
  syncFreeTransformUi(node);
  schedulePreviewDraw(node, false);
}

async function setPreviewData(node, payload) {
  const item = payload?.[0];
  if (!item?.background || !item?.texture) return;
  setStatus(node, "正在载入预览图...", "warn");
  try {
    const [backgroundImage, textureImage] = await Promise.all([
      loadImage(item.background),
      loadImage(item.texture),
    ]);
    node._myTexturePreview = {
      ...item,
      backgroundImage,
      textureImage,
    };
    setStatus(node, `预览已更新${item.batch_count > 1 ? `，批次 ${item.batch_count} 张` : ""}`, "ready");
    updateFooter(node);
    syncControlsFromWidgets(node);
    schedulePreviewDraw(node, true);
    requestAnimationFrame(() => schedulePreviewDraw(node, false));
  } catch (error) {
    console.error("[MyTexture] preview load failed", error);
    setStatus(node, `预览载入失败：${error.message || error}`, "warn");
  }
}

function commitPreviewImages(node, item, backgroundImage, textureImage, maskImage = null, depthImage = null) {
  node._myTexturePreview = {
    ...item,
    backgroundImage,
    textureImage,
    maskImage,
    depthImage,
    background_width: Number(item.background_width) || backgroundImage.naturalWidth || 1,
    background_height: Number(item.background_height) || backgroundImage.naturalHeight || 1,
    texture_width: Number(item.texture_width) || textureImage.naturalWidth || 1,
    texture_height: Number(item.texture_height) || textureImage.naturalHeight || 1,
  };
  updateFooter(node);
  syncControlsFromWidgets(node);
  drawPreview(node);
}

async function loadPreviewFromInputsLegacy(node) {
  const button = node._myTextureLoadButton;
  if (button?.disabled) return;
  const background = inputImageSource(node, "bg_img");
  const texture = inputImageSource(node, "fg_img_1");
  if (!background?.url || !texture?.url) {
    setStatus(node, "无法读取上游底图或贴图，请先确认输入节点已有图像", "warn");
    return;
  }
  if (button) button.disabled = true;
  setStatus(node, "正在加载底图和贴图到实时预览...", "warn");
  try {
    const [backgroundImage, textureImage] = await Promise.all([
      loadImage(background.url),
      loadImage(texture.url),
    ]);
    commitPreviewImages(node, {
      background: background.url,
      texture: texture.url,
      batch_count: 1,
    }, backgroundImage, textureImage);
    setStatus(node, "预览已加载，可拖拽贴图调整位置；确认后再点队列运行", "ready");
  } catch (error) {
    console.error("[MyTexture] input preview load failed", error);
    setStatus(node, `预览加载失败：${error.message || error}`, "warn");
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadPreviewFromInputs(node) {
  const button = node._myTextureLoadButton;
  if (button?.disabled) return;
  if (button) button.disabled = true;
  setStatus(node, "正在执行底图和贴图上游链…", "warn");
  try {
    // ComfyUI's Load Image sends RGB and alpha as separate IMAGE/MASK outputs.
    // The browser preview reads the original RGBA file, so automatically link
    // the matching MASK output when available to keep queued output identical.
    ensureTextureAlphaConnection(node, "fg_img_1", "fg_alpha_mask_1");
    ensureTextureAlphaConnection(node, "fg_img_2", "fg_alpha_mask_2");
    const firstPreviewLoad = !node._myTexturePreview;
    if (firstPreviewLoad) {
      setWidgetValue(node, WIDGETS.skewX, 0);
      setWidgetValue(node, WIDGETS.skewY, 0);
      updateTransformState(node, { rotation: 0 });
    }
    const { backgroundUrl, textureUrl, maskUrl, depthUrl } = await executePreviewDependencies(node);
    const [backgroundImage, textureImage, maskImage, depthImage] = await Promise.all([
      loadImage(backgroundUrl),
      loadImage(textureUrl),
      maskUrl ? loadImage(maskUrl) : Promise.resolve(null),
      depthUrl ? loadImage(depthUrl) : Promise.resolve(null),
    ]);
    commitPreviewImages(node, {
      background: backgroundUrl,
      texture: textureUrl,
      batch_count: 1,
    }, backgroundImage, textureImage, maskImage, depthImage);
    setStatus(node, "预览已加载，可拖拽贴图调整；确认后再点队列运行", "ready");
  } catch (error) {
    console.error("[MyTexture] input preview load failed", error);
    setStatus(node, `预览执行失败：${error.message || error}`, "warn");
  } finally {
    if (button) button.disabled = false;
  }
}

function createInterface(node) {
  ensureStyle();
  const root = document.createElement("div");
  root.className = "mytexture-root";
  root.innerHTML = `
    <div class="mytexture-stage">
      <canvas class="mytexture-canvas"></canvas>
      <div class="mytexture-control-layer">
        <svg class="mytexture-transform-lines" aria-hidden="true">
          <polygon></polygon>
          <line></line>
        </svg>
        <div class="mytexture-transform-box">
          <span class="mytexture-transform-point corner nw" data-transform="nw"></span>
          <span class="mytexture-transform-point corner ne" data-transform="ne"></span>
          <span class="mytexture-transform-point corner se" data-transform="se"></span>
          <span class="mytexture-transform-point corner sw" data-transform="sw"></span>
          <span class="mytexture-transform-stem"></span>
          <span class="mytexture-transform-point rotate" data-transform="rotate"></span>
        </div>
      </div>
    </div>
    <div class="mytexture-panel"></div>
    <div class="mytexture-footer">
      <button class="mytexture-load" type="button">执行预览</button>
      <span class="mytexture-status">点击执行预览加载上游素材</span>
      <span class="mytexture-size"></span>
    </div>
    <div class="mytexture-handle right" data-axis="x"></div>
    <div class="mytexture-handle bottom" data-axis="y"></div>
    <div class="mytexture-handle corner" data-axis="xy"></div>
  `;

  node._myTextureRoot = root;
  node._myTextureCanvas = root.querySelector("canvas");
  node._myTextureControlLayer = root.querySelector(".mytexture-control-layer");
  node._myTextureLoadButton = root.querySelector(".mytexture-load");
  node._myTextureStatus = root.querySelector(".mytexture-status");
  node._myTextureSize = root.querySelector(".mytexture-size");
  node._myTextureControls = new Map();
  node._myTextureSelects = new Map();
  node._myTextureLoadButton.addEventListener("click", () => loadPreviewFromInputs(node));
  node._myTextureLoadButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  const panel = root.querySelector(".mytexture-panel");
  for (const item of SLIDERS) panel.appendChild(createSlider(node, item));
  for (const item of SELECTS) panel.appendChild(createSelect(node, item));
  const freeRow = document.createElement("div");
  freeRow.className = "mytexture-free-row";
  const freeButton = document.createElement("button");
  freeButton.className = "mytexture-free-toggle";
  freeButton.type = "button";
  freeButton.setAttribute("aria-label", "启用或关闭贴图自由变换");
  freeButton.setAttribute("aria-pressed", "false");
  freeButton.textContent = "自由变换：关闭";
  freeButton.addEventListener("pointerdown", (event) => event.stopPropagation());
  freeButton.addEventListener("click", () => setFreeTransformEnabled(node, !transformState(node).freeTransform));
  freeRow.appendChild(freeButton);
  panel.appendChild(freeRow);
  node._myTextureFreeButton = freeButton;
  syncFreeTransformUi(node);

  const canvas = node._myTextureCanvas;
  let dragPointer = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartState = null;

  let transformPointer = null;
  let transformMode = "";
  let transformStartRotation = 0;
  let transformStartState = null;
  let transformStartBox = null;
  let transformStartPointer = null;
  let transformCenterX = 0;
  let transformCenterY = 0;

  const transformPointMove = (event) => {
    if (!transformPointer || event.pointerId !== transformPointer) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - transformCenterX;
    const dy = event.clientY - transformCenterY;
    if (transformMode === "rotate") {
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      const startAngle = node._myTextureTransformStartAngle || angle;
      let next = transformStartRotation + angle - startAngle;
      while (next > 180) next -= 360;
      while (next < -180) next += 360;
      if (transformStartState?.freeTransform && transformStartState.corners) {
        const metrics = previewMetrics(node);
        const startCorners = stateCornersCanvas(transformStartState, metrics);
        const center = quadCenter(startCorners);
        const delta = (angle - startAngle) * Math.PI / 180;
        const cos = Math.cos(delta);
        const sin = Math.sin(delta);
        const corners = startCorners.map(([x, y]) => {
          const localX = x - center[0];
          const localY = y - center[1];
          return [
            clamp((center[0] + localX * cos - localY * sin - metrics.drawX) / metrics.drawW, 0, 1),
            clamp((center[1] + localX * sin + localY * cos - metrics.drawY) / metrics.drawH, 0, 1),
          ];
        });
        if (isUsableQuad(corners)) updateTransformState(node, { corners });
      } else {
        updateTransformState(node, { rotation: Math.round(next * 10) / 10 });
      }
    } else if (transformStartState?.freeTransform && transformStartState.corners && transformStartPointer) {
      const metrics = previewMetrics(node);
      const css = canvasCssScale(node);
      const index = QUAD_KEYS.indexOf(transformMode);
      if (metrics && index >= 0) {
        const corners = transformStartState.corners.map((point) => [...point]);
        corners[index] = [
          clamp(corners[index][0] + (event.clientX - transformStartPointer.x) / Math.max(0.0001, css.x * css.screenX) / metrics.drawW, 0, 1),
          clamp(corners[index][1] + (event.clientY - transformStartPointer.y) / Math.max(0.0001, css.y * css.screenY) / metrics.drawH, 0, 1),
        ];
        if (isUsableQuad(corners)) updateTransformState(node, { corners });
      }
    } else if (transformStartState && transformStartBox && transformStartPointer) {
      // Work from the pointer's original position and scale exactly once.
      // The previous radial calculation multiplied the current scale again on
      // every pointermove, which caused runaway zoom and apparent teleporting.
      const radians = -transformStartState.rotation * Math.PI / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const moveX = (event.clientX - transformStartPointer.x) * cos - (event.clientY - transformStartPointer.y) * sin;
      const moveY = (event.clientX - transformStartPointer.x) * sin + (event.clientY - transformStartPointer.y) * cos;
      const signX = transformMode.includes("w") ? -1 : 1;
      const signY = transformMode.includes("n") ? -1 : 1;
      const css = canvasCssScale(node);
      const width = Math.max(12, transformStartBox.width + signX * moveX / Math.max(0.0001, css.x * css.screenX));
      const height = Math.max(12, transformStartBox.height + signY * moveY / Math.max(0.0001, css.y * css.screenY));
      updateTransformState(node, {
        scale: [
          clamp(transformStartState.scale[0] * width / transformStartBox.width, 0.001, 4),
          clamp(transformStartState.scale[1] * height / transformStartBox.height, 0.001, 4),
        ],
      });
    }
    syncControlsFromWidgets(node);
    schedulePreviewDraw(node, true);
  };
  const transformPointEnd = (event) => {
    if (!transformPointer || event.pointerId !== transformPointer) return;
    event.preventDefault();
    event.stopPropagation();
    document.removeEventListener("pointermove", transformPointMove, true);
    document.removeEventListener("pointerup", transformPointEnd, true);
    document.removeEventListener("pointercancel", transformPointEnd, true);
    transformPointer = null;
    node._myTextureDragging = false;
    transformStartState = null;
    transformStartBox = null;
    transformStartPointer = null;
    schedulePreviewDraw(node, false);
  };
  for (const point of root.querySelectorAll("[data-transform]")) {
    point.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !node._myTexturePreview) return;
      const metrics = previewMetrics(node);
      const box = metrics && (node._myTextureRenderBox || textureBox(node, metrics));
      if (!box) return;
      event.preventDefault();
      event.stopPropagation();
      const css = canvasCssScale(node);
      const startState = transformState(node);
      const visualCenter = startState.freeTransform && startState.corners
        ? quadCenter(stateCornersCanvas(startState, metrics))
        : [box.cx, box.cy];
      transformCenterX = css.screenLeft + (css.left + visualCenter[0] * css.x) * css.screenX;
      transformCenterY = css.screenTop + (css.top + visualCenter[1] * css.y) * css.screenY;
      transformPointer = event.pointerId;
      node._myTextureDragging = true;
      transformMode = point.dataset.transform;
      transformStartRotation = startState.rotation;
      transformStartState = startState;
      transformStartBox = box;
      transformStartPointer = { x: event.clientX, y: event.clientY };
      node._myTextureTransformStartAngle = Math.atan2(event.clientY - transformCenterY, event.clientX - transformCenterX) * 180 / Math.PI;
      document.addEventListener("pointermove", transformPointMove, true);
      document.addEventListener("pointerup", transformPointEnd, true);
      document.addEventListener("pointercancel", transformPointEnd, true);
    });
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !node._myTexturePreview) return;
    const metrics = previewMetrics(node);
    if (!metrics) return;
    event.preventDefault();
    event.stopPropagation();
    dragPointer = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartState = transformState(node);
    node._myTextureDragging = true;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId !== dragPointer) return;
    const metrics = previewMetrics(node);
    if (!metrics) return;
    event.preventDefault();
    event.stopPropagation();
    const css = canvasCssScale(node);
    const state = dragStartState || transformState(node);
    const moveX = (event.clientX - dragStartX) / Math.max(0.0001, css.x * css.screenX) / metrics.drawW;
    const moveY = (event.clientY - dragStartY) / Math.max(0.0001, css.y * css.screenY) / metrics.drawH;
    if (state.freeTransform && state.corners) {
      const xs = state.corners.map((point) => point[0]);
      const ys = state.corners.map((point) => point[1]);
      const safeX = clamp(moveX, -Math.min(...xs), 1 - Math.max(...xs));
      const safeY = clamp(moveY, -Math.min(...ys), 1 - Math.max(...ys));
      updateTransformState(node, { corners: state.corners.map(([x, y]) => [x + safeX, y + safeY]) });
    } else {
      updateTransformState(node, {
        offset: [state.offset[0] + moveX, state.offset[1] + moveY],
      });
    }
    syncControlsFromWidgets(node);
    schedulePreviewDraw(node, true);
  });
  const stopDrag = (event) => {
    if (event.pointerId !== dragPointer) return;
    event.preventDefault();
    event.stopPropagation();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    dragPointer = null;
    dragStartState = null;
    node._myTextureDragging = false;
    schedulePreviewDraw(node, false);
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  // Wheel is intentionally not a sticker transform control.  Scale and
  // rotation are controlled exclusively by the five on-canvas handles.
  canvas.addEventListener("wheel", (event) => {
    if (!node._myTexturePreview) return;
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false, capture: true });

  for (const handle of root.querySelectorAll(".mytexture-handle")) {
    const axis = handle.dataset.axis || "xy";
    let pointer = null;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    const move = (event) => {
      if (event.pointerId !== pointer) return;
      event.preventDefault();
      event.stopPropagation();
      const scale = Math.max(0.05, Number(app.canvas?.ds?.scale) || 1);
      const nextW = axis.includes("x") ? Math.max(MIN_NODE_WIDTH, startW + (event.clientX - startX) / scale) : startW;
      const nextH = axis.includes("y") ? Math.max(MIN_NODE_HEIGHT, Math.min(MAX_NODE_HEIGHT, startH + (event.clientY - startY) / scale)) : startH;
      node.setSize?.([nextW, nextH]);
      if (node.size) {
        node.size[0] = nextW;
        node.size[1] = nextH;
      }
      node.graph?.setDirtyCanvas?.(true, true);
      schedulePreviewDraw(node, Boolean(node._myTextureDragging));
    };
    const finish = (event) => {
      if (event.pointerId !== pointer) return;
      event.preventDefault();
      event.stopPropagation();
      pointer = null;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finish, true);
      document.removeEventListener("pointercancel", finish, true);
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointer = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startW = node.size?.[0] || MIN_NODE_WIDTH;
      startH = node.size?.[1] || MIN_NODE_HEIGHT;
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    });
  }

  for (const eventName of ["pointerdown", "pointermove", "pointerup", "wheel", "click", "dblclick"]) {
    root.addEventListener(eventName, (event) => event.stopPropagation());
  }
  return root;
}

function ensureWidgetCallbacks(node) {
  if (node._myTextureCallbacksReady) return;
  node._myTextureCallbacksReady = true;
  const allCustomWidgets = [...Object.values(WIDGETS)];
  for (const name of allCustomWidgets) hideWidget(node, name);
  for (const widget of node.widgets ?? []) {
    if (!allCustomWidgets.includes(widget.name)) continue;
    const original = widget.callback;
    widget.callback = function () {
      const result = original?.apply?.(this, arguments);
      requestAnimationFrame(() => {
        syncControlsFromWidgets(node);
        schedulePreviewDraw(node, Boolean(node._myTextureDragging));
      });
      return result;
    };
  }
}

function setInitialNodeSize(node) {
  const width = Math.max(MIN_NODE_WIDTH, node.size?.[0] || MIN_NODE_WIDTH);
  // DOM widgets participate in LiteGraph's size negotiation.  Deriving the
  // widget height from node.size and then feeding it back into node.size makes
  // the node grow on every layout pass (an especially bad loop after reload).
  // Start from one fixed, bounded size instead.
  const height = MIN_NODE_HEIGHT;
  node.min_size = [
    Math.max(node.min_size?.[0] || 0, MIN_NODE_WIDTH),
    MIN_NODE_HEIGHT,
  ];
  if (node.size?.[0] === width && node.size?.[1] === height) return;
  node.setSize?.([width, height]);
  if (node.size) {
    node.size[0] = width;
    node.size[1] = height;
  }
}

function widgetHeightForNode(node) {
  return DEFAULT_WIDGET_HEIGHT;
}

function updateWidgetHeight(node, widget) {
  if (!widget?.element) return;
  const height = widgetHeightForNode(node);
  widget.element.style.height = `${height}px`;
  widget.element.style.minHeight = `${height}px`;
  widget.element.style.maxHeight = `${height}px`;
  widget.element.style.overflow = "hidden";
}

function initNode(node) {
  if (!node) return;
  scheduleLegacyInputCleanup(node);
  if (node._myTextureReady) return;
  removeLegacyInputs(node);
  removeLegacyWidgets(node);
  normalizeInputOrder(node);
  if (!(node.inputs || []).some((input) => input?.name === "bg_img")) {
    setTimeout(() => initNode(node), 50);
    return;
  }
  const controlNames = [...SLIDERS, ...SELECTS].map((item) => WIDGETS[item.key]);
  if (!controlNames.every((name) => findWidget(node, name))) {
    setTimeout(() => initNode(node), 50);
    return;
  }
  migrateLegacyWidgetValues(node);
  node._myTextureReady = true;
  ensureWidgetCallbacks(node);
  const root = createInterface(node);
  const widget = node.addDOMWidget("my_texture_preview", "MY_TEXTURE_PREVIEW", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.serialize = false;
  widget.computeSize = (width) => [Math.max(MIN_NODE_WIDTH, width || MIN_NODE_WIDTH), DEFAULT_WIDGET_HEIGHT];
  setInitialNodeSize(node);
  updateWidgetHeight(node, widget);
  syncControlsFromWidgets(node);
  requestAnimationFrame(() => drawPreview(node));
  setTimeout(() => updateWidgetHeight(node, widget), 80);

  const originalResize = node.onResize;
  node.onResize = function() {
    const result = originalResize?.apply?.(this, arguments);
    updateWidgetHeight(this, widget);
    requestAnimationFrame(() => drawPreview(this));
    return result;
  };

  node._myTextureResizeObserver = new ResizeObserver(() => drawPreview(node));
  node._myTextureResizeObserver.observe(root);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function() {
    this._myTextureResizeObserver?.disconnect();
    return originalRemoved?.apply?.(this, arguments);
  };
}

// Public bridge for the Image Mask Brush V2 editor.  It intentionally reuses
// the exact MY Texture preview renderer and pointer handlers instead of
// maintaining a second, visually different implementation.
globalThis.MyTexturePreviewBridge = {
  createEmbeddedController(options = {}) {
    const values = {
      [WIDGETS.tData]: options.transformData || JSON.stringify({
        currentLayer_1: {
          offset: [0.3, 0.3],
          scale: [0.4, 0.4],
          rotation: 0,
          free_transform: false,
        },
      }),
      [WIDGETS.deformation]: Number(options.deformation ?? 0.3),
      [WIDGETS.opacity]: Number(options.opacity ?? 1),
      [WIDGETS.skewX]: Number(options.skewX ?? 0),
      [WIDGETS.skewY]: Number(options.skewY ?? 0),
      [WIDGETS.stretchX]: Number(options.stretchX ?? 1),
      [WIDGETS.stretchY]: Number(options.stretchY ?? 1),
      [WIDGETS.blendMode]: String(options.blendMode || "normal"),
    };
    const adapter = {
      id: `image-mask-brush-v2-${Date.now()}`,
      widgets: Object.entries(values).map(([name, value]) => ({
        name,
        value,
        options: name === WIDGETS.blendMode ? { values: SELECTS[0].values } : {},
        callback: name === WIDGETS.tData
          ? (next) => options.onTransform?.(String(next || ""))
          : () => options.onControls?.(),
      })),
      graph: { setDirtyCanvas() {} },
    };
    const root = createInterface(adapter);
    const stage = root.querySelector(".mytexture-stage");
    stage.classList.add("mytexture-embedded-stage");
    Object.assign(stage.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      minHeight: "0",
      zIndex: "8",
    });
    options.container?.appendChild(stage);
    adapter._myTexturePreview = {
      backgroundImage: options.backgroundImage,
      textureImage: options.textureImage,
      maskImage: options.maskImage || null,
      depthImage: options.depthImage || null,
      eraseStrokes: Array.isArray(options.eraseStrokes) ? options.eraseStrokes : [],
      background_width: Number(options.backgroundWidth) || options.backgroundImage?.naturalWidth || 1,
      background_height: Number(options.backgroundHeight) || options.backgroundImage?.naturalHeight || 1,
      texture_width: Number(options.textureWidth) || options.textureImage?.naturalWidth || 1,
      texture_height: Number(options.textureHeight) || options.textureImage?.naturalHeight || 1,
    };
    syncFreeTransformUi(adapter);
    requestAnimationFrame(() => drawPreview(adapter, { fast: false }));

    return {
      stage,
      node: adapter,
      render(fast = false) {
        drawPreview(adapter, { fast });
      },
      setControls(next = {}, fast = false) {
        const mapping = {
          deformation: WIDGETS.deformation,
          opacity: WIDGETS.opacity,
          skewX: WIDGETS.skewX,
          skewY: WIDGETS.skewY,
          stretchX: WIDGETS.stretchX,
          stretchY: WIDGETS.stretchY,
          blendMode: WIDGETS.blendMode,
        };
        for (const [key, widgetName] of Object.entries(mapping)) {
          if (next[key] === undefined) continue;
          const widget = findWidget(adapter, widgetName);
          if (widget) widget.value = next[key];
        }
        syncControlsFromWidgets(adapter);
        drawPreview(adapter, { fast });
      },
      setDepthImage(depthImage) {
        adapter._myTexturePreview.depthImage = depthImage || null;
        drawPreview(adapter, { fast: false });
      },
      setMaskImage(maskImage) {
        adapter._myTexturePreview.maskImage = maskImage || null;
        adapter._myTextureMaskCanvasReady = false;
        drawPreview(adapter, { fast: false });
      },
      setEraseStrokes(strokes, fast = false) {
        adapter._myTexturePreview.eraseStrokes = Array.isArray(strokes) ? strokes : [];
        adapter._myTextureEraseRevision = (Number(adapter._myTextureEraseRevision) || 0) + 1;
        drawPreview(adapter, { fast });
      },
      mapBackgroundPointToTexture(x, y) {
        const state = transformState(adapter);
        if (!state.freeTransform || !isUsableQuad(state.corners)) return null;
        return inverseProjectHomography(homographyToQuad(state.corners), Number(x), Number(y));
      },
      getTransformData() {
        return adapter._myTextureTransformData || String(findWidget(adapter, WIDGETS.tData)?.value || "");
      },
      setTransformData(value, fast = false) {
        adapter._myTextureTransformData = String(value || "");
        const widget = findWidget(adapter, WIDGETS.tData);
        if (widget) widget.value = adapter._myTextureTransformData;
        syncFreeTransformUi(adapter);
        drawPreview(adapter, { fast });
      },
      destroy() {
        if (adapter._myTextureDrawFrame) cancelAnimationFrame(adapter._myTextureDrawFrame);
        stage.remove();
      },
    };
  },
};

const EXTENSION_GUARD = "__myComfnodeTextureRegisteredV2";

if (!globalThis[EXTENSION_GUARD]) {
  globalThis[EXTENSION_GUARD] = true;
  globalThis.__myComfnodeTextureLoadedAt = Date.now();
  app.registerExtension({
    name: "MyComfnode.Texture.V2",
    async nodeCreated(node) {
      if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) initNode(node);
    },
    async loadedGraphNode(node) {
      if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) initNode(node);
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_CLASS) return;
      const originalCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() {
        const result = originalCreated?.apply?.(this, arguments);
        initNode(this);
        return result;
      };
      const originalConfigured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function() {
        const result = originalConfigured?.apply?.(this, arguments);
        migrateLegacyWidgetValues(this);
        scheduleLegacyInputCleanup(this);
        setTimeout(() => {
          removeLegacyInputs(this);
          removeLegacyWidgets(this);
          migrateLegacyWidgetValues(this);
          syncControlsFromWidgets(this);
          drawPreview(this);
        }, 1500);
        initNode(this);
        return result;
      };
      const originalExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function(message) {
        const result = originalExecuted?.apply?.(this, arguments);
        if (message?.my_texture_preview) setPreviewData(this, message.my_texture_preview);
        return result;
      };
    },
  });
}
