import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import "../../scripts/domWidget.js";

const NODE_CLASS = "RHAllG";
const START_ROUTE = "/my-comfnode/rh-all-g/start";
const STATUS_ROUTE = "/my-comfnode/rh-all-g/status";
const IMAGE_INPUTS = ["images", ...Array.from({ length: 9 }, (_, index) => `image${index + 1}`)];
const GUARD = "__myComfnodeRHAllGRegisteredV1";

function widget(node, name) {
  return node.widgets?.find((item) => item.name === name);
}

function value(node, name, fallback = "") {
  const result = widget(node, name)?.value;
  return result == null ? fallback : result;
}

async function comfyFetch(path, options = {}) {
  if (typeof api?.fetchApi === "function") return api.fetchApi(path, options);
  return fetch(typeof api?.apiURL === "function" ? api.apiURL(path) : path, options);
}

function imageUrl(item, fresh = false) {
  if (!item) return "";
  const params = new URLSearchParams({
    filename: item.filename || item.name || "",
    subfolder: item.subfolder || "",
    type: item.type || "output",
  });
  if (fresh) params.set("t", String(Date.now()));
  const path = `/view?${params}`;
  return typeof api?.apiURL === "function" ? api.apiURL(path) : path;
}

function urlsFromNode(node) {
  const urls = [];
  try {
    const discovered = app.getNodeImageUrls?.(node);
    if (Array.isArray(discovered)) urls.push(...discovered);
  } catch {
    // Nodes without preview payload can throw in older ComfyUI versions.
  }
  for (const item of node?.images || []) urls.push(imageUrl(item));
  for (const image of node?.imgs || []) if (image?.src) urls.push(image.src);
  return urls.filter(Boolean);
}

function connectedImageUrls(node) {
  const urls = [];
  for (const name of IMAGE_INPUTS) {
    const input = node.inputs?.find((item) => item.name === name);
    if (!input?.link) continue;
    const link = app.graph?.links?.[input.link];
    const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
    urls.push(...urlsFromNode(origin));
  }
  return [...new Set(urls)].slice(0, 10);
}

function connectedPrompt(node) {
  const input = node.inputs?.find((item) => item.name === "prompt");
  if (!input?.link) return undefined;
  const link = app.graph?.links?.[input.link];
  const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
  for (const name of ["prompt", "text", "string", "value"]) {
    const candidate = value(origin, name, "");
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function setStatus(node, text, tone = "normal") {
  const element = node._rhAllGStatus;
  if (!element) return;
  element.dataset.tone = tone;
  element.replaceChildren();
  if (tone === "running") {
    const spinner = document.createElement("span");
    spinner.className = "my-rh-all-g-spinner";
    element.append(spinner);
  }
  const label = document.createElement("span");
  label.textContent = text;
  element.append(label);
}

function setRunning(node, running) {
  node._rhAllGRunning = running;
  if (node._rhAllGButton) node._rhAllGButton.disabled = running;
  node.graph?.setDirtyCanvas?.(true, true);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitJob(body, headers) {
  const response = await comfyFetch(START_ROUTE, { method: "POST", headers, body });
  const started = await response.json().catch(() => ({}));
  if (!response.ok || !started.ok || !started.job_id) {
    throw new Error(started.error || `独立任务启动失败：HTTP ${response.status}`);
  }
  while (true) {
    await sleep(500);
    const response = await comfyFetch(`${STATUS_ROUTE}/${encodeURIComponent(started.job_id)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `独立任务查询失败：HTTP ${response.status}`);
    if (data.status === "SUCCESS") return data;
    if (data.status === "ERROR" || !data.ok) throw new Error(data.error || "RH全能G 独立运行失败");
  }
}

function showDownstream(sourceNode, descriptor) {
  const output = sourceNode.outputs?.[0];
  for (const linkId of output?.links || []) {
    const link = app.graph?.links?.[linkId];
    const target = link ? app.graph?.getNodeById?.(link.target_id) : null;
    if (!target) continue;
    target._rhAllGImages ||= {};
    target._rhAllGImages[link.target_slot || 0] = descriptor;
    const descriptors = Object.keys(target._rhAllGImages)
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => target._rhAllGImages[key]);
    target.images = descriptors;
    target.imgs = descriptors.map((item) => {
      const preview = new Image();
      preview.src = imageUrl(item, true);
      preview.onload = () => target.graph?.setDirtyCanvas?.(true, true);
      return preview;
    });
    target.graph?.setDirtyCanvas?.(true, true);
  }
}

function showResult(node, data) {
  node.properties ||= {};
  node.properties.rhAllGImage = data.image;
  node.properties.rhAllGUrl = data.image_url || "";
  node.properties.rhAllGResponse = data.response || "";
  node.images = [];
  node.imgs = [];
  if (data.image) showDownstream(node, data.image);
  node.graph?.setDirtyCanvas?.(true, true);
}

async function fetchBlob(url, index) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`第 ${index + 1} 张参考图读取失败：HTTP ${response.status}`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`第 ${index + 1} 张参考图不是图片`);
  return blob;
}

async function runStandalone(node, options = {}) {
  if (node._rhAllGRunning) return;
  setRunning(node, true);
  setStatus(node, "任务已提交，等待出图…", "running");
  try {
    const prompt = String(options.prompt ?? connectedPrompt(node) ?? value(node, "prompt", ""));
    const fields = {
      prompt,
      aspectRatio: String(value(node, "aspectRatio", "auto")),
      resolution: String(value(node, "resolution", "2k")),
      API_KEY: String(value(node, "API_KEY", "")),
    };
    let data;
    if (options.imageItems?.length) {
      data = await awaitJob(JSON.stringify({
        ...fields,
        image_refs: options.imageItems.map((item) => ({
          filename: item.filename,
          subfolder: item.subfolder || "",
          type: item.type || "input",
        })),
        max_size: Number(options.maxSize || 0),
        scale_mode: options.scaleMode !== false,
      }), { "Content-Type": "application/json" });
    } else {
      const urls = options.imageUrls?.length ? options.imageUrls : connectedImageUrls(node);
      if (!urls.length) throw new Error("上游图片尚未生成，请先让前面的图片节点至少出图一次");
      const form = new FormData();
      for (const [name, fieldValue] of Object.entries(fields)) form.append(name, fieldValue);
      for (let index = 0; index < urls.length; index += 1) {
        const blob = await fetchBlob(urls[index], index);
        const suffix = blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg";
        form.append("image", blob, `reference_${index + 1}.${suffix}`);
      }
      data = await awaitJob(form);
    }
    showResult(node, data);
    setStatus(node, "完成，结果已输出到下游节点", "success");
    return data;
  } catch (error) {
    console.error("[RH全能G] 独立运行失败", error);
    setStatus(node, error?.message || String(error), "error");
    throw error;
  } finally {
    setRunning(node, false);
  }
}

export async function runRHAllGDirect(node, options) {
  if (!node || (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS)) {
    throw new Error("没有找到对应的 RH全能G 节点");
  }
  return runStandalone(node, options);
}

function initNode(node) {
  if (!node || node._rhAllGReady) return;
  node._rhAllGReady = true;
  const root = document.createElement("div");
  root.className = "my-rh-all-g-root";
  root.innerHTML = `
    <style>
      .my-rh-all-g-root { box-sizing:border-box; width:100%; padding:8px 10px 10px; font:12px/1.4 Arial,"Microsoft YaHei",sans-serif; }
      .my-rh-all-g-run { width:100%; height:32px; border:1px solid #6c8cff; border-radius:6px; color:#fff; background:#4268f6; cursor:pointer; }
      .my-rh-all-g-run:disabled { cursor:wait; opacity:.62; }
      .my-rh-all-g-status { display:flex; align-items:center; gap:7px; min-height:18px; margin-top:6px; color:#b8c0d8; overflow-wrap:anywhere; }
      .my-rh-all-g-status[data-tone="running"] { color:#7fb2ff; } .my-rh-all-g-status[data-tone="success"] { color:#69d58a; } .my-rh-all-g-status[data-tone="error"] { color:#ff8585; }
      .my-rh-all-g-spinner { width:13px; height:13px; border:2px solid rgba(127,178,255,.3); border-top-color:#7fb2ff; border-radius:50%; animation:my-rh-all-g-spin .8s linear infinite; }
      @keyframes my-rh-all-g-spin { to { transform:rotate(360deg); } }
    </style>
    <button class="my-rh-all-g-run" type="button">开始</button>
    <div class="my-rh-all-g-status" data-tone="normal">独立运行不会占用 ComfyUI 队列</div>`;
  node._rhAllGButton = root.querySelector(".my-rh-all-g-run");
  node._rhAllGStatus = root.querySelector(".my-rh-all-g-status");
  node._rhAllGButton.addEventListener("click", () => runStandalone(node).catch(() => {}));
  const domWidget = node.addDOMWidget("rh_all_g_run", "MYCOMFNODE_RH_ALL_G_RUN", root, { serialize:false, hideOnZoom:false, getValue:() => "", setValue:() => {} });
  domWidget.serialize = false;
  domWidget.computeSize = (width) => [Math.max(300, width || 360), 76];
  node.setSize?.([Math.max(node.size?.[0] || 360, 360), Math.max(node.size?.[1] || 420, 420)]);
}

if (!globalThis[GUARD]) {
  globalThis[GUARD] = true;
  app.registerExtension({
    name: "MyComfnode.RHAllGStandaloneRun.V1",
    nodeCreated(node) { if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) initNode(node); },
    loadedGraphNode(node) { if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) initNode(node); },
    beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_CLASS) return;
      const originalCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function() { const result = originalCreated?.apply?.(this, arguments); initNode(this); return result; };
      const originalConfigured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function() { const result = originalConfigured?.apply?.(this, arguments); initNode(this); return result; };
    },
  });
}
