import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "MyComfnodeBatchImageLoader";
const DATA_WIDGET = "image_data";
const DEFAULT_VIEW_HEIGHT = 430;
const MIN_VIEW_HEIGHT = 260;
const NODE_SHELL_HEIGHT = 72;
const THUMBNAIL_MAX_SIZE = 360;
const THUMBNAIL_QUALITY = 0.82;
const THUMBNAIL_CONCURRENCY = 2;
const QUEUE_SEQUENTIAL_PROPERTY = "batchQueueSequential";
const ACTIVE_BATCH_NODES = new Set();
let internalSequentialSubmissionDepth = 0;

function moveItem(items, sourceId, targetId = null, placeAfter = false) {
  const sourceIndex = items.findIndex((item) => String(item.id) === String(sourceId));
  if (sourceIndex < 0) return false;

  const [source] = items.splice(sourceIndex, 1);
  if (targetId == null) {
    const moved = sourceIndex !== items.length;
    items.push(source);
    return moved;
  }

  const targetIndex = items.findIndex((item) => String(item.id) === String(targetId));
  if (targetIndex < 0) {
    items.splice(sourceIndex, 0, source);
    return false;
  }
  const insertionIndex = targetIndex + (placeAfter ? 1 : 0);
  items.splice(insertionIndex, 0, source);
  return sourceIndex !== insertionIndex;
}

function storageKey(node) {
  return `my-comfnode.batch-image-loader.${node.id}`;
}

function readStoredItems(node) {
  try {
    return normalizeItems(localStorage.getItem(storageKey(node)) || "[]");
  } catch {
    return [];
  }
}

function writeStoredItems(node, items) {
  try {
    localStorage.setItem(storageKey(node), JSON.stringify(items));
  } catch {
    // Local storage may be disabled; workflow serialization remains available.
  }
}

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

function hideWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget || widget._batchLoaderHidden) return widget;
  widget._batchLoaderHidden = true;
  widget.hidden = true;
  widget.type = "converted-widget";
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  widget.serializeValue = async () => widget.value;
  if (widget.options) widget.options.hidden = true;
  if (widget.inputEl) widget.inputEl.style.display = "none";
  if (widget.element) widget.element.style.display = "none";
  return widget;
}

function normalizeItems(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "[]");
    } catch {
      parsed = [];
    }
  }
  if (parsed && !Array.isArray(parsed)) parsed = parsed.images;
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      filename: String(item.filename || item.name || ""),
      subfolder: String(item.subfolder || ""),
      type: String(item.type || "input"),
      selected: item.selected === true,
      originalName: String(item.originalName || item.original_name || item.filename || item.name || ""),
    }))
    .filter((item) => item.filename);
}

function imageViewUrl(item) {
  if (item.previewUrl) return item.previewUrl;
  if (item.uploading || !item.filename) return "";
  const query = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || "",
    type: item.type || "input",
    preview: "webp;90",
  });
  return `/view?${query.toString()}`;
}

function imageSourceUrl(item) {
  if (!item?.filename) return "";
  const query = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || "",
    type: item.type || "input",
  });
  const path = `/view?${query.toString()}`;
  return typeof api?.apiURL === "function" ? api.apiURL(path) : path;
}

function outputLinks(node, onlySingleOutput = false) {
  const outputs = node?.outputs || [];
  const selectedOutputs = onlySingleOutput
    ? outputs.filter((output, index) => output.name === "逐张单图" || index === 2)
    : outputs;
  return selectedOutputs.flatMap((output) => output.links || []);
}

function downstreamRHTargets(sourceNode) {
  const targets = [];
  const queue = outputLinks(sourceNode, true).map((linkId) => ({ linkId, maxSize: 0, scaleMode: true }));
  const visited = new Set();

  while (queue.length) {
    const state = queue.shift();
    const link = app.graph?.links?.[state.linkId];
    const node = link ? app.graph?.getNodeById?.(link.target_id) : null;
    if (!node) continue;
    const key = `${node.id}:${state.maxSize}:${state.scaleMode}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const type = node.comfyClass || node.type;
    const directRunner = null;
    if (directRunner) {
      // 每个 API 节点保留自己的运行状态与接口；批量加载器只负责分发图片。
      targets.push({ node, run: directRunner, maxSize: state.maxSize, scaleMode: state.scaleMode });
      continue;
    }

    let maxSize = state.maxSize;
    let scaleMode = state.scaleMode;
    if (type === "easy imageScaleDownToSize") {
      maxSize = Number(findWidget(node, "size")?.value || 0);
      scaleMode = Boolean(findWidget(node, "mode")?.value ?? true);
    }
    for (const linkId of outputLinks(node)) queue.push({ linkId, maxSize, scaleMode });
  }
  return targets;
}

function isImageFile(file) {
  if (!file) return false;
  if (file.type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic)$/i.test(file.name || "");
}

async function uploadImage(file) {
  const form = new FormData();
  form.append("image", file, file.name);
  form.append("type", "input");
  form.append("overwrite", "false");

  const response = await comfyFetch("/upload/image", { method: "POST", body: form });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `HTTP ${response.status}`);
  }
  const result = await response.json();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename: result.name || file.name,
    subfolder: result.subfolder || "",
    type: result.type || "input",
    selected: false,
  };
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function revokePreviewUrl(item) {
  if (item?.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

async function createThumbnailUrl(file) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", THUMBNAIL_QUALITY));
    return blob ? URL.createObjectURL(blob) : URL.createObjectURL(file);
  } catch (error) {
    console.warn("[BatchImageLoader] thumbnail generation failed, using original preview", file.name, error);
    return URL.createObjectURL(file);
  } finally {
    bitmap?.close?.();
  }
}

function itemLabel(item) {
  if (item.uploading) return `${item.filename} · 上传中`;
  if (item.error) return `${item.filename} · 上传失败`;
  return item.filename;
}

function updateItemCard(node, item) {
  const card = node._batchImageCards?.get(item.id);
  if (!card) {
    renderItems(node);
    return;
  }
  card.className = `mcbil-card${item.selected ? " is-selected" : ""}${item.uploading ? " is-uploading" : ""}${item.error ? " is-error" : ""}`;

  const image = card.querySelector("img");
  const url = imageViewUrl(item);
  if (image && url && image.dataset.src !== url) {
    image.dataset.src = url;
    image.src = url;
  }

  const name = card.querySelector(".mcbil-name");
  if (name) {
    name.textContent = itemLabel(item);
    name.title = item.filename;
  }
}

async function generateThumbnails(node, items) {
  let cursor = 0;
  const runNext = async () => {
    const item = items[cursor];
    cursor += 1;
    if (!item) return;
    if (item._file && !item.previewUrl) {
      const url = await createThumbnailUrl(item._file);
      if ((node._batchImageItems || []).includes(item)) {
        revokePreviewUrl(item);
        item.previewUrl = url;
        updateItemCard(node, item);
      } else {
        URL.revokeObjectURL(url);
      }
    }
    await runNext();
  };
  await Promise.all(Array.from({ length: Math.min(THUMBNAIL_CONCURRENCY, items.length) }, runNext));
}

function syncData(node) {
  const widget = findWidget(node, DATA_WIDGET);
  if (!widget) return;
  const items = (node._batchImageItems || [])
    .filter((item) => item.filename && !item.uploading && !item.error)
    .map((item) => ({
      id: item.id,
      filename: item.filename,
      subfolder: item.subfolder || "",
      type: item.type || "input",
      selected: item.selected === true,
      originalName: item.originalName || item.filename,
    }));
  widget.value = JSON.stringify(items);
  node.properties ||= {};
  node.properties.batchImageItems = items;
  node.properties[QUEUE_SEQUENTIAL_PROPERTY] = Boolean(node._batchQueueSequential);
  writeStoredItems(node, items);
  node.graph?.setDirtyCanvas?.(true, true);
}

function setStatus(node, text, isError = false) {
  if (!node._batchImageStatus) return;
  node._batchImageStatus.textContent = text;
  node._batchImageStatus.dataset.error = isError ? "true" : "false";
}

function updateSummary(node) {
  const items = node._batchImageItems || [];
  const selected = items.filter((item) => item.selected).length;
  if (!items.length) {
    setStatus(node, "等待添加图片");
  } else if (!selected) {
    setStatus(node, `共 ${items.length} 张 · 未勾选，逐张运行会处理全部`);
  } else {
    setStatus(node, `共 ${items.length} 张 · 逐张运行会处理 ${selected} 张`);
  }
  if (node._batchSelectButton) {
    node._batchSelectButton.textContent = selected === items.length && items.length ? "取消全选" : "全选";
  }
}

function setQueueSequential(node, enabled) {
  node._batchQueueSequential = Boolean(enabled);
  node.properties ||= {};
  node.properties[QUEUE_SEQUENTIAL_PROPERTY] = node._batchQueueSequential;
  if (node._batchQueueSequentialCheckbox) {
    node._batchQueueSequentialCheckbox.checked = node._batchQueueSequential;
  }
  node.graph?.setDirtyCanvas?.(true, true);
}

function activeItems(node) {
  const items = node._batchImageItems || [];
  const selected = items.filter((item) => item.selected);
  return selected.length ? selected : items;
}

function singleItemPayload(item) {
  return JSON.stringify([{ ...item, selected: true }]);
}

function queueEligibleItems(node) {
  return activeItems(node).filter((item) => !item.uploading && !item.error);
}

function setPromptNodeImageData(promptData, node, imageData) {
  const id = String(node.id);
  const output = promptData?.output || promptData?.prompt;
  const promptNode = output?.[id];
  if (!promptNode?.inputs) {
    throw new Error("没有在当前工作流 prompt 中找到图像批量加载节点");
  }
  promptNode.inputs[DATA_WIDGET] = imageData;

  const workflowNode = promptData?.workflow?.nodes?.find((item) => String(item.id) === id);
  if (workflowNode && Array.isArray(workflowNode.widgets_values)) {
    const widgetIndex = node.widgets?.findIndex((widget) => widget.name === DATA_WIDGET) ?? -1;
    if (widgetIndex >= 0 && widgetIndex < workflowNode.widgets_values.length) {
      workflowNode.widgets_values[widgetIndex] = imageData;
    }
  }
}

async function queuePromptData(promptData) {
  // Submit through ComfyUI's normal API chain.  Direct /prompt fetches skip
  // prompt transformers installed by encrypted groups, virtual nodes and
  // other extensions, which makes an otherwise valid workflow fail only in
  // sequential mode.
  internalSequentialSubmissionDepth += 1;
  try {
    return await api.queuePrompt(0, promptData);
  } finally {
    internalSequentialSubmissionDepth = Math.max(0, internalSequentialSubmissionDepth - 1);
  }
}

function sequentialErrorMessage(error) {
  const response = error?.response;
  if (!response || typeof response !== "object") return error?.message || String(error || "未知错误");

  const nodeErrors = response.node_errors && typeof response.node_errors === "object"
    ? Object.entries(response.node_errors)
    : [];
  if (nodeErrors.length) {
    const [nodeId, detail] = nodeErrors[0];
    const messages = Array.isArray(detail?.errors)
      ? detail.errors.map((item) => item?.message || item?.details).filter(Boolean)
      : [];
    const title = detail?.class_type || detail?.node_type || nodeId;
    return `${title}：${messages[0] || "节点输入校验失败"}`;
  }

  return response.error?.details || response.error?.message || error.message || "提示词校验失败";
}

function promptIdFromQueueResult(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.prompt_id === "string") return result.prompt_id;
  if (typeof result.promptId === "string") return result.promptId;
  if (Array.isArray(result)) {
    for (const item of result) {
      const found = promptIdFromQueueResult(item);
      if (found) return found;
    }
  }
  if (typeof result === "object") {
    for (const value of Object.values(result)) {
      const found = promptIdFromQueueResult(value);
      if (found) return found;
    }
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPromptDone(promptId) {
  if (!promptId) return;
  while (true) {
    const response = await comfyFetch(`/history/${encodeURIComponent(promptId)}`);
    if (response.ok) {
      const history = await response.json().catch(() => ({}));
      if (history?.[promptId] || Object.keys(history || {}).length > 0) return;
    }
    await sleep(1500);
  }
}

function abortError() {
  const error = new Error("逐张运行已停止");
  error.name = "AbortError";
  return error;
}

async function waitForPromptDoneWithCancel(node, promptId) {
  if (!promptId) return;
  while (true) {
    if (!node._batchSequentialQueueing) throw abortError();
    const response = await comfyFetch(`/history/${encodeURIComponent(promptId)}`);
    if (response.ok) {
      const history = await response.json().catch(() => ({}));
      if (history?.[promptId] || Object.keys(history || {}).length > 0) return;
    }
    await sleep(1500);
  }
}

async function queueSequentialRun(node) {
  const items = queueEligibleItems(node);
  if (!items.length) {
    setStatus(node, "请先添加图片", true);
    return;
  }
  if (node._batchSequentialQueueing) return;

  node._batchSequentialQueueing = true;
  // 图像批量加载是通用的队列节点：逐张时始终执行当前完整工作流，
  // 不探测、不直接调用任何指定的下游节点。
  const directTargets = [];

  try {
    syncData(node);
    for (let index = 0; index < items.length; index += 1) {
      if (!node._batchSequentialQueueing) throw abortError();
      if (directTargets.length) {
        setStatus(node, `API并发运行 ${index + 1} / ${items.length}：${items[index].filename}`);
        await Promise.all(directTargets.map((target) => target.run(target.node, {
          imageItems: [items[index]],
          maxSize: target.maxSize,
          scaleMode: target.scaleMode,
        })));
      } else {
        setStatus(node, `逐张排队 ${index + 1} / ${items.length}：${items[index].filename}`);
        const promptData = await app.graphToPrompt();
        setPromptNodeImageData(promptData, node, singleItemPayload(items[index]));
        // Queue the complete workflow exactly like the top Run button.  The
        // execution cache already skips unaffected branches.  Cropping the
        // prompt by graph links breaks encrypted/virtual group nodes because
        // some of their required internal nodes are not represented as normal
        // LiteGraph links.
        const result = await queuePromptData(promptData);
        const promptId = promptIdFromQueueResult(result);
        await waitForPromptDoneWithCancel(node, promptId);
      }
    }
    setStatus(node, directTargets.length ? `API并发组已完成：${items.length} 张` : `已逐张加入队列：${items.length} 张`);
  } catch (error) {
    console.error("[BatchImageLoader] sequential queue failed", error);
    if (error?.name === "AbortError") {
      setStatus(node, "逐张运行已停止");
    } else {
      setStatus(node, `逐张运行失败：${sequentialErrorMessage(error)}`, true);
    }
  } finally {
    node._batchSequentialQueueing = false;
  }
}

function installQueueRunMode() {
  if (globalThis.__myComfnodeBatchQueueRunModeInstalledV25) return;
  globalThis.__myComfnodeBatchQueueRunModeInstalledV25 = true;

  const originalQueuePrompt = app.queuePrompt;
  app.queuePrompt = async function() {
    let nodes = Array.from(ACTIVE_BATCH_NODES).filter((node) => {
      if (!node || node.mode === 2) return false;
      const graph = node.graph;
      return graph && graph.getNodeById?.(node.id) === node;
    });
    if (nodes.length) {
      try {
        const promptData = await app.graphToPrompt();
        nodes = nodes.filter((node) => promptContainsNode(promptData, node));
      } catch {
        // 原始队列函数负责展示工作流本身的验证错误。
        nodes = [];
      }
    }
    const sequentialNodes = nodes.filter((node) => node._batchQueueSequential);
    if (sequentialNodes.length) {
      await Promise.all(sequentialNodes.map((node) => queueSequentialRun(node)));
      return;
    }

    const restoreValues = [];
    try {
      for (const node of nodes) {
        const first = queueEligibleItems(node)[0];
        const widget = findWidget(node, DATA_WIDGET);
        if (!first || !widget) continue;
        restoreValues.push([widget, widget.value]);
        widget.value = singleItemPayload(first);
      }
      return await originalQueuePrompt.apply(app, arguments);
    } finally {
      for (const [widget, value] of restoreValues) widget.value = value;
    }
  };
}

function currentActiveBatchNodes() {
  return Array.from(ACTIVE_BATCH_NODES).filter((node) => {
    if (!node || node.mode === 2) return false;
    const graph = node.graph;
    return graph && graph.getNodeById?.(node.id) === node;
  });
}

function promptContainsNode(promptData, node) {
  const output = promptData?.output || promptData?.prompt || promptData;
  return Boolean(output && typeof output === "object" && output[String(node?.id)]);
}

function installApiQueueRunMode() {
  if (api.queuePrompt?._myComfnodeBatchQueueV25) return;
  const originalQueuePrompt = api.queuePrompt;

  const wrappedQueuePrompt = async function(index, prompt, ...args) {
    if (internalSequentialSubmissionDepth > 0) {
      return await originalQueuePrompt.call(this, index, prompt, ...args);
    }
    // 只允许实际进入本次可执行 prompt 的批量节点接管队列。
    const nodes = currentActiveBatchNodes().filter((node) => promptContainsNode(prompt, node));
    const sequentialNodes = nodes.filter((node) => node._batchQueueSequential);
    if (sequentialNodes.length) {
      await Promise.all(sequentialNodes.map((node) => queueSequentialRun(node)));
      return { prompt_id: "", number: 0, node_errors: {} };
    }

    for (const node of nodes) {
      const first = queueEligibleItems(node)[0];
      if (first) setPromptNodeImageData(prompt, node, singleItemPayload(first));
    }
    return await originalQueuePrompt.call(this, index, prompt, ...args);
  };
  wrappedQueuePrompt._myComfnodeBatchQueueV25 = true;
  wrappedQueuePrompt._myComfnodeBatchQueueOriginal = originalQueuePrompt;
  api.queuePrompt = wrappedQueuePrompt;
}

function bindSequentialButton(node, button) {
  button.addEventListener("click", () => {
    if (node._batchSequentialQueueing) {
      node._batchSequentialQueueing = false;
      button.textContent = "逐张运行";
      setStatus(node, "正在停止，当前这张完成后结束");
      return;
    }
    button.textContent = "停止";
    queueSequentialRun(node).finally(() => { button.textContent = "逐张运行"; });
  });
}

function renderItems(node) {
  const grid = node._batchImageGrid;
  if (!grid) return;
  grid.replaceChildren();
  node._batchImageCards = new Map();
  const items = node._batchImageItems || [];

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "mcbil-empty";
    empty.innerHTML = "<strong>拖拽多张图片到这里</strong><span>也可以点击上方添加图片</span>";
    grid.append(empty);
    updateSummary(node);
    return;
  }

  items.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = `mcbil-card${item.selected ? " is-selected" : ""}${item.uploading ? " is-uploading" : ""}${item.error ? " is-error" : ""}`;
    card.dataset.itemId = item.id;
    card.draggable = !item.uploading;
    card.title = "拖拽可调整图片顺序";

    const sequence = document.createElement("span");
    sequence.className = "mcbil-sequence";
    sequence.textContent = String(index + 1);

    const image = document.createElement("img");
    const url = imageViewUrl(item);
    if (url) {
      image.dataset.src = url;
      image.src = url;
    }
    image.alt = item.filename;
    image.loading = "eager";
    image.decoding = "async";
    image.draggable = false;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = item.selected;
    check.title = "勾选后逐张运行只处理勾选图片";
    check.addEventListener("change", () => {
      item.selected = check.checked;
      card.classList.toggle("is-selected", item.selected);
      syncData(node);
      updateSummary(node);
    });

    card.addEventListener("dragstart", (event) => {
      if (item.uploading) {
        event.preventDefault();
        return;
      }
      node._batchDraggedItemId = item.id;
      card.classList.add("is-reordering");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-mycomfnode-batch-item", String(item.id));
      event.dataTransfer.setData("text/plain", String(item.id));
    });
    card.addEventListener("dragover", (event) => {
      if (!node._batchDraggedItemId || node._batchDraggedItemId === item.id) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      card.classList.toggle("drop-before", !after);
      card.classList.toggle("drop-after", after);
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", (event) => {
      if (!node._batchDraggedItemId) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = card.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const moved = moveItem(node._batchImageItems, node._batchDraggedItemId, item.id, after);
      node._batchJustDraggedAt = Date.now();
      node._batchDraggedItemId = null;
      if (moved) syncData(node);
      renderItems(node);
    });
    card.addEventListener("dragend", () => {
      node._batchJustDraggedAt = Date.now();
      node._batchDraggedItemId = null;
      card.classList.remove("is-reordering", "drop-before", "drop-after");
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "mcbil-remove";
    remove.textContent = "×";
    remove.title = "从加载器移除";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      revokePreviewUrl(item);
      node._batchImageItems.splice(index, 1);
      syncData(node);
      renderItems(node);
    });

    const name = document.createElement("div");
    name.className = "mcbil-name";
    name.textContent = itemLabel(item);
    name.title = item.filename;

    card.addEventListener("click", (event) => {
      if (Date.now() - (node._batchJustDraggedAt || 0) < 250) return;
      if (event.target === check || event.target === remove) return;
      check.checked = !check.checked;
      check.dispatchEvent(new Event("change"));
    });
    card.append(image, sequence, check, remove, name);
    grid.append(card);
    node._batchImageCards.set(item.id, card);
  });
  updateSummary(node);
}

async function addFilesFast(node, fileList) {
  const files = Array.from(fileList || []).filter(isImageFile);
  if (!files.length) {
    setStatus(node, "没有检测到支持的图片文件", true);
    return;
  }
  if (node._batchImageUploading) return;

  node._batchImageUploading = true;
  node._batchUploadButton.disabled = true;
  if (node._batchRunButton) node._batchRunButton.disabled = true;

  const pendingItems = files.map((file) => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename: file.name,
    subfolder: "",
    type: "input",
    selected: false,
    originalName: file.name,
    uploading: true,
    previewUrl: "",
    _file: file,
  }));

  node._batchImageItems.push(...pendingItems);
  renderItems(node);
  generateThumbnails(node, pendingItems);
  await nextPaint();

  let completed = 0;
  let cursor = 0;
  const failed = [];
  const concurrency = Math.min(3, files.length);

  const uploadNext = async () => {
    const item = pendingItems[cursor];
    cursor += 1;
    if (!item) return;

    try {
      const uploaded = await uploadImage(item._file);
      item.filename = uploaded.filename;
      item.subfolder = uploaded.subfolder;
      item.type = uploaded.type;
      item.uploading = false;
      delete item.error;
      delete item._file;
    } catch (error) {
      console.error("[BatchImageLoader] upload failed", item.filename, error);
      item.uploading = false;
      item.error = true;
      failed.push(item.filename);
    } finally {
      completed += 1;
      setStatus(node, `正在上传 ${completed} / ${files.length}`);
      updateItemCard(node, item);
      updateSummary(node);
      await uploadNext();
    }
  };

  setStatus(node, `正在上传 0 / ${files.length}`);
  await Promise.all(Array.from({ length: concurrency }, uploadNext));

  node._batchImageUploading = false;
  node._batchUploadButton.disabled = false;
  if (node._batchRunButton) node._batchRunButton.disabled = false;
  syncData(node);
  pendingItems.forEach((item) => updateItemCard(node, item));
  updateSummary(node);

  if (failed.length) {
    setStatus(node, `${files.length - failed.length} 张已添加，${failed.length} 张失败`, true);
  } else {
    setStatus(node, `${files.length} 张已添加，可以逐张运行`);
  }
}

async function addFiles(node, fileList) {
  const files = Array.from(fileList || []).filter(isImageFile);
  if (!files.length) {
    setStatus(node, "没有检测到支持的图片文件", true);
    return;
  }
  if (node._batchImageUploading) return;

  node._batchImageUploading = true;
  node._batchUploadButton.disabled = true;
  setStatus(node, `正在上传 0 / ${files.length}`);
  const uploaded = [];
  const failed = [];
  for (let index = 0; index < files.length; index += 1) {
    try {
      const item = await uploadImage(files[index]);
      item.originalName = files[index].name;
      uploaded.push(item);
    } catch (error) {
      console.error("[BatchImageLoader] upload failed", files[index].name, error);
      failed.push(files[index].name);
    }
    setStatus(node, `正在上传 ${index + 1} / ${files.length}`);
  }

  node._batchImageItems.push(...uploaded);
  node._batchImageUploading = false;
  node._batchUploadButton.disabled = false;
  syncData(node);
  renderItems(node);
  if (failed.length) {
    setStatus(node, `${uploaded.length} 张已添加，${failed.length} 张失败`, true);
  }
}

function createInterface(node) {
  const root = document.createElement("div");
  root.className = "mcbil-root";
  root.innerHTML = `
    <style>
      .mcbil-root { box-sizing: border-box; width: 100%; height: 100%; min-height: ${MIN_VIEW_HEIGHT}px; display: flex; flex-direction: column; gap: 9px; padding: 10px; color: #ececf1; background: #17181c; border: 1px solid #34363d; border-radius: 7px; font: 12px/1.35 Arial, sans-serif; overflow: hidden; }
      .mcbil-root * { box-sizing: border-box; }
      .mcbil-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto auto; gap: 7px; flex: 0 0 auto; align-items: stretch; }
      .mcbil-button { min-height: 32px; border: 1px solid #454852; border-radius: 5px; padding: 0 11px; color: #f7f7f9; background: #292b31; cursor: pointer; font-weight: 600; }
      .mcbil-button:hover { background: #343740; border-color: #626672; }
      .mcbil-button:disabled { opacity: .55; cursor: wait; }
      .mcbil-button.primary { background: #276749; border-color: #3b8b67; }
      .mcbil-button.primary:hover { background: #317a58; }
      .mcbil-button.run { background: #305a8a; border-color: #4d78ad; }
      .mcbil-button.run:hover { background: #3a6aa0; }
      .mcbil-queue-mode { min-height: 32px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid #454852; border-radius: 5px; color: #e7e8ec; background: #23252b; cursor: pointer; white-space: nowrap; font-weight: 600; }
      .mcbil-queue-mode input { width: 17px; height: 17px; margin: 0; accent-color: #4d88c7; cursor: pointer; }
      .mcbil-status { min-height: 18px; color: #a9adb8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mcbil-status[data-error="true"] { color: #ff9f9f; }
      .mcbil-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: 132px; gap: 8px; padding: 2px; overflow: auto; align-content: start; border: 1px dashed #42454f; border-radius: 6px; background: #111216; }
      .mcbil-grid.is-dragging { border-color: #59a87c; background: #15251d; }
      .mcbil-empty { grid-column: 1 / -1; height: 100%; min-height: 250px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: #8e929d; text-align: center; pointer-events: none; }
      .mcbil-empty strong { color: #d8dae0; font-size: 14px; }
      .mcbil-card { position: relative; min-width: 0; overflow: hidden; border: 2px solid transparent; border-radius: 6px; background: #23252b; cursor: pointer; }
      .mcbil-card.is-selected { border-color: #55b381; }
      .mcbil-card.is-reordering { opacity: .55; }
      .mcbil-card.drop-before::after, .mcbil-card.drop-after::after { content: ""; position: absolute; z-index: 5; left: 3px; right: 3px; height: 4px; border-radius: 2px; background: #62a9ef; pointer-events: none; }
      .mcbil-card.drop-before::after { top: 1px; }
      .mcbil-card.drop-after::after { bottom: 1px; }
      .mcbil-card img { width: 100%; height: 100%; display: block; object-fit: contain; background: #0b0c0f; }
      .mcbil-card input { position: absolute; top: 7px; left: 39px; width: 19px; height: 19px; margin: 0; accent-color: #43a672; cursor: pointer; }
      .mcbil-sequence { position: absolute; z-index: 2; top: 6px; left: 7px; min-width: 25px; height: 22px; padding: 0 5px; border: 1px solid #777b85; border-radius: 4px; color: #fff; background: rgba(18, 19, 23, .9); text-align: center; font: 700 13px/20px Arial, sans-serif; pointer-events: none; }
      .mcbil-remove { position: absolute; top: 6px; right: 6px; width: 23px; height: 23px; padding: 0; border: 1px solid #686b73; border-radius: 50%; color: #fff; background: rgba(20, 21, 24, .88); cursor: pointer; font-size: 18px; line-height: 19px; }
      .mcbil-remove:hover { background: #a63d44; border-color: #d36369; }
      .mcbil-name { position: absolute; inset: auto 0 0; padding: 7px 8px 6px; overflow: hidden; color: #fff; background: rgba(10, 11, 13, .84); text-overflow: ellipsis; white-space: nowrap; }
      .mcbil-file { display: none; }
    </style>
    <div class="mcbil-toolbar">
      <button class="mcbil-button primary" type="button">添加图片</button>
      <button class="mcbil-button run" type="button">逐张运行</button>
      <label class="mcbil-queue-mode" title="勾选后，点击ComfyUI顶部队列运行会按当前顺序逐张执行；不勾选时顶部队列只输出第一张。"><input type="checkbox"><span>队列逐张</span></label>
      <button class="mcbil-button mcbil-select" type="button">全选</button>
      <button class="mcbil-button mcbil-clear" type="button">清除</button>
    </div>
    <div class="mcbil-status">等待添加图片</div>
    <div class="mcbil-grid"></div>
    <input class="mcbil-file" type="file" accept="image/*" multiple>
  `;

  const uploadButton = root.querySelector(".primary");
  const runButton = root.querySelector(".run");
  const selectButton = root.querySelector(".mcbil-select");
  const queueSequentialCheckbox = root.querySelector(".mcbil-queue-mode input");
  const clearButton = root.querySelector(".mcbil-clear");
  const fileInput = root.querySelector(".mcbil-file");
  const grid = root.querySelector(".mcbil-grid");
  node._batchUploadButton = uploadButton;
  node._batchRunButton = runButton;
  node._batchSelectButton = selectButton;
  node._batchQueueSequentialCheckbox = queueSequentialCheckbox;
  node._batchImageStatus = root.querySelector(".mcbil-status");
  node._batchImageGrid = grid;

  uploadButton.addEventListener("click", () => fileInput.click());
  bindSequentialButton(node, runButton);
  queueSequentialCheckbox.checked = Boolean(node._batchQueueSequential);
  queueSequentialCheckbox.addEventListener("change", () => {
    setQueueSequential(node, queueSequentialCheckbox.checked);
  });
  fileInput.addEventListener("change", () => {
    addFilesFast(node, fileInput.files);
    fileInput.value = "";
  });
  selectButton.addEventListener("click", () => {
    const items = node._batchImageItems || [];
    const select = !items.length ? false : !items.every((item) => item.selected);
    items.forEach((item) => { item.selected = select; });
    syncData(node);
    renderItems(node);
  });
  clearButton.addEventListener("click", () => {
    (node._batchImageItems || []).forEach(revokePreviewUrl);
    node._batchImageItems = [];
    syncData(node);
    renderItems(node);
  });

  for (const eventName of ["dragenter", "dragover"]) {
    root.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      grid.classList.add("is-dragging");
    });
  }
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget)) grid.classList.remove("is-dragging");
  });
  root.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    grid.classList.remove("is-dragging");
    if (node._batchDraggedItemId) {
      const moved = moveItem(node._batchImageItems, node._batchDraggedItemId);
      node._batchJustDraggedAt = Date.now();
      node._batchDraggedItemId = null;
      if (moved) syncData(node);
      renderItems(node);
      return;
    }
    addFilesFast(node, event.dataTransfer?.files);
  });
  return root;
}

function restoreItems(node) {
  const widget = findWidget(node, DATA_WIDGET);
  const fromProperties = normalizeItems(node.properties?.batchImageItems);
  const fromConfigure = normalizeItems(node._batchConfiguredImageData);
  const fromWidget = normalizeItems(widget?.value);
  const fromStorage = readStoredItems(node);
  const restored = fromProperties.length
    ? fromProperties
    : fromConfigure.length
      ? fromConfigure
      : fromWidget.length
        ? fromWidget
        : fromStorage;
  node._batchImageItems = restored;
  if (restored.length) {
    if (widget) widget.value = JSON.stringify(restored);
    node.properties ||= {};
    node.properties.batchImageItems = restored;
  }
  renderItems(node);
}

function scheduleRestoreItems(node) {
  restoreItems(node);
  for (const delay of [0, 80, 300, 800]) {
    setTimeout(() => {
      if (!node._batchImageItems?.length) restoreItems(node);
    }, delay);
  }
}

function setInitialNodeSize(node) {
  const width = Math.max(node.size?.[0] || 420, 420);
  const height = Math.max(node.size?.[1] || 0, DEFAULT_VIEW_HEIGHT + NODE_SHELL_HEIGHT);
  node.min_size = [Math.max(node.min_size?.[0] || 0, 360), MIN_VIEW_HEIGHT + NODE_SHELL_HEIGHT];
  if (node.size && Math.abs(node.size[0] - width) < 0.5 && Math.abs(node.size[1] - height) < 0.5) return;
  node.setSize?.([width, height]);
  node.graph?.setDirtyCanvas?.(true, true);
}

function updateWidgetHeight(node, widget) {
  const height = Math.max(MIN_VIEW_HEIGHT, (node.size?.[1] || 0) - NODE_SHELL_HEIGHT);
  widget.element.style.height = `${height}px`;
  widget.element.style.minHeight = `${MIN_VIEW_HEIGHT}px`;
}

function installResizableLayout(node, widget) {
  widget.computeSize = (width) => [width || 400, MIN_VIEW_HEIGHT];
  node.min_size = [Math.max(node.min_size?.[0] || 0, 360), MIN_VIEW_HEIGHT + NODE_SHELL_HEIGHT];
  node.onResize = function() {
    updateWidgetHeight(this, widget);
    this.graph?.setDirtyCanvas?.(true, true);
  };
  updateWidgetHeight(node, widget);
}

function initNode(node) {
  if (node) ACTIVE_BATCH_NODES.add(node);
  installApiQueueRunMode();
  if (!node || node._batchImageLoaderVersion >= 25) return;
  if (node._batchImageLoaderReady) {
    node._batchImageLoaderVersion = 25;
    const widget = node.widgets?.find((item) => item.name === "batch_image_loader");
    const root = node._batchImageGrid?.closest?.(".mcbil-root") || widget?.element;
    if (root) root.style.minHeight = `${MIN_VIEW_HEIGHT}px`;
    if (widget) {
      installResizableLayout(node, widget);
    }

    const oldRunButton = node._batchRunButton;
    if (oldRunButton?.parentNode) {
      const runButton = oldRunButton.cloneNode(true);
      oldRunButton.replaceWith(runButton);
      bindSequentialButton(node, runButton);
      node._batchRunButton = runButton;
    }

    node.onDrawForeground = null;
    node.graph?.setDirtyCanvas?.(true, true);
    return;
  }
  node._batchImageLoaderReady = true;
  node._batchImageLoaderVersion = 25;
  if (node.title === NODE_CLASS) node.title = "图像批量加载";
  hideWidget(node, DATA_WIDGET);
  node._batchQueueSequential = Boolean(node.properties?.[QUEUE_SEQUENTIAL_PROPERTY]);
  node._batchImageItems = normalizeItems(node.properties?.batchImageItems);
  if (!node._batchImageItems.length) {
    node._batchImageItems = normalizeItems(findWidget(node, DATA_WIDGET)?.value);
  }
  if (!node._batchImageItems.length) {
    node._batchImageItems = readStoredItems(node);
  }

  const root = createInterface(node);
  const widget = node.addDOMWidget("batch_image_loader", "MYCOMFNODE_BATCH_IMAGE_LOADER", root, {
    serialize: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.serialize = false;
  setInitialNodeSize(node);
  installResizableLayout(node, widget);

  const originalDragOver = node.onDragOver;
  node.onDragOver = function(event) {
    if (event?.dataTransfer?.types && Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault?.();
      return true;
    }
    return originalDragOver?.apply?.(this, arguments) ?? false;
  };

  const originalDragDrop = node.onDragDrop;
  node.onDragDrop = function(event) {
    const files = event?.dataTransfer?.files;
    if (files?.length && Array.from(files).some(isImageFile)) {
      event.preventDefault?.();
      addFilesFast(this, files);
      return true;
    }
    return originalDragDrop?.apply?.(this, arguments) ?? false;
  };

  const originalSerialize = node.onSerialize;
  node.onSerialize = function(info) {
    syncData(this);
    return originalSerialize?.apply?.(this, arguments);
  };
  const originalRemoved = node.onRemoved;
  node.onRemoved = function() {
    ACTIVE_BATCH_NODES.delete(this);
    return originalRemoved?.apply?.(this, arguments);
  };
  scheduleRestoreItems(node);
}

const EXTENSION_GUARD = "__myComfnodeBatchImageLoaderExtensionRegisteredV25";

if (!globalThis[EXTENSION_GUARD]) {
  globalThis[EXTENSION_GUARD] = true;
  app.registerExtension({
    name: "MyComfnode.BatchImageLoader.V25",
    async setup() {
      installQueueRunMode();
    },
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
      nodeType.prototype.onConfigure = function(info) {
        const values = Array.isArray(info?.widgets_values) ? info.widgets_values : [];
        const configured = values.find((value) => normalizeItems(value).length > 0);
        if (configured) this._batchConfiguredImageData = configured;
        if (Array.isArray(info?.properties?.batchImageItems)) {
          this.properties ||= {};
          this.properties.batchImageItems = info.properties.batchImageItems;
        }
        if (info?.properties && QUEUE_SEQUENTIAL_PROPERTY in info.properties) {
          this.properties ||= {};
          this.properties[QUEUE_SEQUENTIAL_PROPERTY] = Boolean(
            info.properties[QUEUE_SEQUENTIAL_PROPERTY],
          );
        }
        const result = originalConfigured?.apply?.(this, arguments);
      setTimeout(() => {
        initNode(this);
        hideWidget(this, DATA_WIDGET);
        setQueueSequential(this, Boolean(this.properties?.[QUEUE_SEQUENTIAL_PROPERTY]));
        scheduleRestoreItems(this);
      }, 0);
        return result;
      };
    },
  });
}
