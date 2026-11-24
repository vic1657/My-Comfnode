import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import "../../scripts/domWidget.js";

const EXTENSION_GUARD = "__myComfnodeRHBigBananaStandaloneRunRegisteredV9";
const EXTENSION_DIAGNOSTIC = "__myComfnodeRHBigBananaStandaloneRunLoaded";
const NODE_CLASS = "RHBigBanana";
const RUN_ROUTE = "/my-comfnode/rh-big-banana/run";
const START_ROUTE = "/my-comfnode/rh-big-banana/start";
const STATUS_ROUTE = "/my-comfnode/rh-big-banana/status";
const IMAGE_INPUTS = ["images", ...Array.from({ length: 9 }, (_, index) => `image${index + 1}`)];

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

async function comfyFetch(path, options = {}) {
  if (typeof api?.fetchApi === "function") {
    return api.fetchApi(path, options);
  }
  const url = typeof api?.apiURL === "function" ? api.apiURL(path) : path;
  return fetch(url, options);
}

function widgetValue(node, name, fallback = "") {
  const value = findWidget(node, name)?.value;
  return value == null ? fallback : value;
}

function connectedWidgetValue(node, inputName) {
  const input = node.inputs?.find((item) => item.name === inputName);
  if (!input?.link) return undefined;
  const link = app.graph?.links?.[input.link];
  const originNode = link ? app.graph?.getNodeById?.(link.origin_id) : null;
  if (!originNode) return undefined;
  const preferred = [inputName, "text", "string", "value", "prompt"];
  for (const name of preferred) {
    const value = findWidget(originNode, name)?.value;
    if (typeof value === "string" && value.trim()) return value;
  }
  const stringWidget = originNode.widgets?.find((widget) => typeof widget.value === "string" && widget.value.trim());
  return stringWidget?.value;
}

function imageDescriptorUrl(item, cacheBust = false) {
  if (!item) return "";
  const query = new URLSearchParams({
    filename: item.filename || item.name || "",
    subfolder: item.subfolder || "",
    type: item.type || "output",
  });
  if (cacheBust) query.set("t", String(Date.now()));
  const path = `/view?${query.toString()}`;
  return typeof api?.apiURL === "function" ? api.apiURL(path) : path;
}

function parseAnnotatedFile(value, fallbackType = "input") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  const path = (match ? match[1] : raw).replaceAll("\\", "/");
  const slash = path.lastIndexOf("/");
  return {
    filename: slash >= 0 ? path.slice(slash + 1) : path,
    subfolder: slash >= 0 ? path.slice(0, slash) : "",
    type: match ? match[2] : fallbackType,
  };
}

function imageUrlsFromNode(node) {
  if (!node) return [];
  const urls = [];

  try {
    const appUrls = app.getNodeImageUrls?.(node);
    if (Array.isArray(appUrls)) urls.push(...appUrls);
  } catch {
    // Some ComfyUI builds throw if the node has no UI image payload.
  }

  for (const item of node.images || []) {
    const url = imageDescriptorUrl(item);
    if (url) urls.push(url);
  }

  for (const image of node.imgs || []) {
    if (image?.src) urls.push(image.src);
  }

  const imageWidget = findWidget(node, "image");
  const file = parseAnnotatedFile(imageWidget?.value, "input");
  const widgetUrl = imageDescriptorUrl(file);
  if (widgetUrl) urls.push(widgetUrl);

  return [...new Set(urls.filter(Boolean))];
}

function batchLoaderImageUrls(node) {
  if (!node || (node.comfyClass !== "MyComfnodeBatchImageLoader" && node.type !== "MyComfnodeBatchImageLoader")) {
    return [];
  }

  let items = Array.isArray(node._batchImageItems) ? node._batchImageItems : null;
  if (!items) {
    try {
      const parsed = JSON.parse(String(findWidget(node, "image_data")?.value || "[]"));
      items = Array.isArray(parsed) ? parsed : parsed?.images;
    } catch {
      items = [];
    }
  }
  items = (items || []).filter((item) => item?.filename && !item.uploading && !item.error);
  const selected = items.filter((item) => item.selected === true);
  const active = selected.length ? selected : items;
  return active.map((item) => imageDescriptorUrl(item)).filter(Boolean);
}

function collectConnectedImageUrls(node) {
  const urls = [];
  for (const inputName of IMAGE_INPUTS) {
    const input = node.inputs?.find((item) => item.name === inputName);
    if (!input?.link) continue;
    const link = app.graph?.links?.[input.link];
    const originNode = link ? app.graph?.getNodeById?.(link.origin_id) : null;
    const batchUrls = batchLoaderImageUrls(originNode);
    urls.push(...(batchUrls.length ? batchUrls : imageUrlsFromNode(originNode)));
  }
  return [...new Set(urls)].slice(0, 10);
}

async function fetchImageBlob(url, index) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`第 ${index + 1} 张参考图读取失败：HTTP ${response.status}`);
  const source = await response.blob();
  if (!source.type.startsWith("image/")) {
    throw new Error(`第 ${index + 1} 张参考图不是图片`);
  }
  return source;
}

function setStatus(node, text, tone = "normal") {
  const status = node._rhBigBananaStatus;
  if (!status) return;
  status.dataset.tone = tone;
  status.replaceChildren();
  if (tone === "running") {
    const spinner = document.createElement("span");
    spinner.className = "my-rh-banana-spinner";
    spinner.setAttribute("aria-hidden", "true");
    status.append(spinner);
  }
  const label = document.createElement("span");
  label.textContent = text;
  status.append(label);
}

function setRunning(node, running) {
  node._rhBigBananaRunning = running;
  if (node._rhBigBananaButton) node._rhBigBananaButton.disabled = running;
  node.graph?.setDirtyCanvas?.(true, true);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startAndWaitForJob(body, headers) {
  const response = await comfyFetch(START_ROUTE, { method: "POST", headers, body });
  const started = await response.json().catch(() => ({}));
  if (!response.ok || !started.ok || !started.job_id) {
    throw new Error(started.error || `独立任务启动失败：HTTP ${response.status}`);
  }

  while (true) {
    await sleep(500);
    const statusResponse = await comfyFetch(`${STATUS_ROUTE}/${encodeURIComponent(started.job_id)}`, {
      cache: "no-store",
    });
    const data = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      throw new Error(data.error || `独立任务查询失败：HTTP ${statusResponse.status}`);
    }
    if (data.status === "SUCCESS") return data;
    if (data.status === "ERROR" || !data.ok) {
      throw new Error(data.error || "独立任务运行失败");
    }
  }
}

function showResultOnNode(node, descriptor, imageUrl, responseText) {
  node.properties ||= {};
  node.properties.rhStandaloneImage = descriptor;
  node.properties.rhStandaloneUrl = imageUrl || "";
  node.properties.rhStandaloneResponse = responseText || "";
  node.images = [];
  node.imgs = [];
  if (descriptor) showResultOnDownstream(node, descriptor);
  node.graph?.setDirtyCanvas?.(true, true);
}

function showResultOnDownstream(sourceNode, descriptor) {
  const imageOutput = sourceNode.outputs?.[0];
  for (const linkId of imageOutput?.links || []) {
    const link = app.graph?.links?.[linkId];
    const target = link ? app.graph?.getNodeById?.(link.target_id) : null;
    if (!target) continue;

    target._rhDirectImages ||= {};
    target._rhDirectImages[link.target_slot || 0] = descriptor;
    const descriptors = Object.keys(target._rhDirectImages)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => target._rhDirectImages[key]);
    target.images = descriptors;
    target.imgs = descriptors.map((item) => {
      const preview = new Image();
      preview.src = imageDescriptorUrl(item, true);
      preview.onload = () => target.graph?.setDirtyCanvas?.(true, true);
      return preview;
    });
    target.properties ||= {};
    target.properties.rhDirectImages = descriptors;
    target.graph?.setDirtyCanvas?.(true, true);
  }
}

async function resizeImageBlob(source, maxSize, mode = true) {
  if (!maxSize || maxSize < 1) return source;
  const bitmap = await createImageBitmap(source);
  try {
    const basis = mode ? Math.max(bitmap.width, bitmap.height) : Math.min(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxSize / basis);
    if (scale >= 1) return source;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片缩放失败")), "image/jpeg", 0.95);
    });
  } finally {
    bitmap.close?.();
  }
}

async function runStandalone(node, options = {}) {
  if (node._rhBigBananaRunning) return;
  setRunning(node, true);
      setStatus(node, "任务已提交，等待出图…", "running");

  try {
    const prompt = String(options.prompt ?? connectedWidgetValue(node, "prompt") ?? widgetValue(node, "prompt", ""));
    if (options.imageItems?.length) {
      const payload = {
        prompt,
        aspectRatio: String(widgetValue(node, "aspectRatio", "auto")),
        resolution: String(widgetValue(node, "resolution", "4k")),
        channel: String(widgetValue(node, "channel", "官方稳定版")),
        API_KEY: String(widgetValue(node, "API_KEY", "")),
        image_refs: options.imageItems.map((item) => ({
          filename: item.filename,
          subfolder: item.subfolder || "",
          type: item.type || "input",
        })),
        max_size: Number(options.maxSize || 0),
        scale_mode: options.scaleMode !== false,
      };
      setStatus(node, "任务已提交，等待出图…", "running");
      const data = await startAndWaitForJob(
        JSON.stringify(payload),
        { "Content-Type": "application/json" },
      );
      showResultOnNode(node, data.image, data.image_url, data.response);
      setStatus(node, "完成，结果已输出到下游节点", "success");
      return data;
    }

    const urls = options.imageUrls?.length ? options.imageUrls : collectConnectedImageUrls(node);
    if (!urls.length) {
      throw new Error("上游图片尚未生成，请先让前面的图片节点至少出图一次");
    }

    const form = new FormData();
    form.append("prompt", prompt);
    form.append("aspectRatio", String(widgetValue(node, "aspectRatio", "auto")));
    form.append("resolution", String(widgetValue(node, "resolution", "4k")));
    form.append("channel", String(widgetValue(node, "channel", "官方稳定版")));
    form.append("API_KEY", String(widgetValue(node, "API_KEY", "")));

    for (let index = 0; index < urls.length; index += 1) {
      let blob = await fetchImageBlob(urls[index], index);
      blob = await resizeImageBlob(blob, options.maxSize, options.scaleMode);
      const extension = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
      form.append("image", blob, `reference_${index + 1}.${extension}`);
    }

    setStatus(node, "任务已提交，等待出图…", "running");
    const data = await startAndWaitForJob(form);
    showResultOnNode(node, data.image, data.image_url, data.response);
    setStatus(node, "完成，结果已输出到下游节点", "success");
    return data;
  } catch (error) {
    console.error("[RH大香蕉] 独立运行失败", error);
    setStatus(node, error?.message || String(error), "error");
    throw error;
  } finally {
    setRunning(node, false);
  }
}

export async function runRHBigBananaDirect(node, options) {
  if (!node || (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS)) {
    throw new Error("没有找到对应的 RH大香蕉节点");
  }
  if (node._rhBigBananaRunning) {
    throw new Error("当前组的 RH大香蕉正在运行，请等待本组当前图片完成");
  }
  return runStandalone(node, options);
}

function createInterface(node) {
  const root = document.createElement("div");
  root.className = "my-rh-banana-root";
  root.innerHTML = `
    <style>
      .my-rh-banana-root {
        box-sizing: border-box;
        width: 100%;
        padding: 8px 10px 10px;
        font: 12px/1.4 Arial, "Microsoft YaHei", sans-serif;
      }
      .my-rh-banana-run {
        width: 100%;
        height: 32px;
        border: 1px solid #6c8cff;
        border-radius: 6px;
        color: #fff;
        background: #4268f6;
        cursor: pointer;
      }
      .my-rh-banana-run:disabled {
        cursor: wait;
        opacity: 0.62;
      }
      .my-rh-banana-status {
        display: flex;
        align-items: center;
        gap: 7px;
        min-height: 18px;
        margin-top: 6px;
        color: #b8c0d8;
        overflow-wrap: anywhere;
      }
      .my-rh-banana-spinner {
        flex: 0 0 auto;
        width: 13px;
        height: 13px;
        border: 2px solid rgba(127, 178, 255, .3);
        border-top-color: #7fb2ff;
        border-radius: 50%;
        animation: my-rh-banana-spin .8s linear infinite;
      }
      @keyframes my-rh-banana-spin { to { transform: rotate(360deg); } }
      .my-rh-banana-status[data-tone="running"] { color: #7fb2ff; }
      .my-rh-banana-status[data-tone="success"] { color: #69d58a; }
      .my-rh-banana-status[data-tone="error"] { color: #ff8585; }
    </style>
    <button class="my-rh-banana-run" type="button">开始</button>
    <div class="my-rh-banana-status" data-tone="normal">独立运行不会占用 ComfyUI 队列</div>
  `;
  node._rhBigBananaButton = root.querySelector(".my-rh-banana-run");
  node._rhBigBananaStatus = root.querySelector(".my-rh-banana-status");
  node._rhBigBananaButton.addEventListener("click", () => runStandalone(node).catch(() => {}));
  return root;
}

function initNode(node) {
  if (!node || node._rhBigBananaVersion >= 9) return;
  if (node._rhBigBananaReady) {
    node._rhBigBananaVersion = 9;
    const oldButton = node._rhBigBananaButton;
    if (oldButton?.parentNode) {
      const button = oldButton.cloneNode(true);
      oldButton.replaceWith(button);
      button.addEventListener("click", () => runStandalone(node).catch(() => {}));
      node._rhBigBananaButton = button;
    }
    setStatus(node, "独立运行不会占用 ComfyUI 队列");
    return;
  }
  node._rhBigBananaReady = true;
  node._rhBigBananaVersion = 9;
  node.properties ||= {};

  const root = createInterface(node);
  const widget = node.addDOMWidget("rh_big_banana_run", "MYCOMFNODE_RH_BIG_BANANA_RUN", root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.serialize = false;
  widget.computeSize = (width) => [Math.max(300, width || 360), 76];
  node.setSize?.([Math.max(node.size?.[0] || 360, 360), Math.max(node.size?.[1] || 420, 420)]);
  node.graph?.setDirtyCanvas?.(true, true);
}

if (!globalThis[EXTENSION_GUARD]) {
  globalThis[EXTENSION_DIAGNOSTIC] = { loaded: true, version: 7 };
  globalThis[EXTENSION_GUARD] = true;
  app.registerExtension({
    name: "MyComfnode.RHBigBananaStandaloneRun.V9",
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
        initNode(this);
        return result;
      };
    },
  });
}
