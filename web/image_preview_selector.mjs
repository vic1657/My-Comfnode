import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "MyComfnodeImagePreviewSelector";
const PAYLOAD_WIDGET = "selection_payload";
const VIEW_HEIGHT = 500;
const SELECTOR_NODES = new Set();
const SESSIONS_ROUTE = "/my-comfnode/image-preview-selector/sessions";
const SELECT_TIMEOUT_MS = 20000;
let sessionPollTimer = null;
let sessionPollBusy = false;

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function hideWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget || widget._previewSelectorHidden) return widget;
  widget._previewSelectorHidden = true;
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

function imageUrl(item) {
  const query = new URLSearchParams({
    filename: item.filename || "",
    subfolder: item.subfolder || "",
    type: item.type || "temp",
    preview: "webp;95",
  });
  return `/view?${query.toString()}`;
}

function imageKey(item) {
  return [item?.type || "temp", item?.subfolder || "", item?.filename || ""].join("/");
}

function imageAspectRatio(item) {
  const explicit = Number(item?.aspect_ratio ?? item?.aspectRatio);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const width = Number(item?.width);
  const height = Number(item?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return width / height;
  }
  return 2 / 3;
}

function setStatus(node, text, tone = "normal") {
  if (!node._previewSelectorStatus) return;
  node._previewSelectorStatus.textContent = text;
  node._previewSelectorStatus.dataset.tone = tone;
}

function updateControls(node) {
  const count = node._previewSelectorImages?.length || 0;
  const waiting = node._previewSelectorState?.status === "waiting";
  const selected = Number.isInteger(node._previewSelectorSelected)
    && node._previewSelectorSelected >= 0
    && node._previewSelectorSelected < count;

  if (node._previewSelectorNext) {
    node._previewSelectorNext.disabled = !waiting || !selected || node._previewSelectorQueueing;
  }
  if (node._previewSelectorPreviewBack) {
    node._previewSelectorPreviewBack.disabled = node._previewSelectorMode !== "preview";
  }
}

function currentSessionNodeId(node) {
  const rootNodeId = node._previewSelectorStatus?.closest?.(".mcips-root")?.dataset.nodeId;
  return String(rootNodeId || node._previewSelectorSessionNodeId || node.id);
}

function markSelectionSubmitted(node, state, selectedIndex, sessionNodeId) {
  node._previewSelectorQueueing = false;
  node._previewSelectorSubmitted = {
    session_id: state.session_id,
    signature: state.signature,
    selected_index: selectedIndex,
    node_id: String(sessionNodeId || currentSessionNodeId(node)),
  };
  node._previewSelectorState = {
    ...state,
    status: "passed",
    selected_index: selectedIndex,
  };
  node._previewSelectorSelected = selectedIndex;
  setStatus(node, `已放行第 ${selectedIndex + 1} 张，等待下游节点完成...`, "selected");
  renderGrid(node);
  updateControls(node);
}

function resetTransform(node) {
  node._previewSelectorZoom = 1;
  node._previewSelectorPanX = 0;
  node._previewSelectorPanY = 0;
  applyTransform(node);
}

function applyTransform(node) {
  const image = node._previewSelectorLargeImage;
  if (!image) return;
  image.style.transform = `translate(${node._previewSelectorPanX || 0}px, ${node._previewSelectorPanY || 0}px) scale(${node._previewSelectorZoom || 1})`;
}

function showList(node) {
  node._previewSelectorMode = "list";
  node._previewSelectorGrid?.classList.remove("is-hidden");
  node._previewSelectorPreview?.classList.add("is-hidden");
  resetTransform(node);
  updateControls(node);
  scheduleGridLayout(node);
}

function showPreview(node, index) {
  const item = node._previewSelectorImages?.[index];
  if (!item || !node._previewSelectorLargeImage) return;
  node._previewSelectorMode = "preview";
  node._previewSelectorPreviewIndex = index;
  node._previewSelectorLargeImage.src = imageUrl(item);
  node._previewSelectorLargeImage.alt = `预览第 ${index + 1} 张图片`;
  node._previewSelectorPreviewLabel.textContent = `${index + 1} / ${node._previewSelectorImages.length}`;
  node._previewSelectorGrid?.classList.add("is-hidden");
  node._previewSelectorPreview?.classList.remove("is-hidden");
  resetTransform(node);
  updateControls(node);
}

function selectImage(node, index) {
  node._previewSelectorSelected = index;
  for (const [cardIndex, card] of [...(node._previewSelectorGrid?.querySelectorAll(".mcips-card") || [])].entries()) {
    card.classList.toggle("is-selected", cardIndex === index);
  }
  updateControls(node);
  setStatus(node, `已选择第 ${index + 1} 张，点击“下一步”继续`, "selected");
}

function layoutGridCards(node) {
  const grid = node._previewSelectorGrid;
  if (!grid || grid.classList.contains("is-hidden")) return;
  const cards = [...grid.querySelectorAll(".mcips-card")];
  if (!cards.length || !grid.clientWidth || !grid.clientHeight) return;

  const gap = 8;
  const padding = 16;
  const availableWidth = Math.max(1, grid.clientWidth - padding - gap * Math.max(0, cards.length - 1));
  const availableHeight = Math.max(1, grid.clientHeight - padding);
  const ratios = cards.map((card) => Math.max(0.1, Number(card.dataset.aspectRatio) || 2 / 3));
  const fitHeight = availableWidth / ratios.reduce((sum, ratio) => sum + ratio, 0);
  const cardHeight = Math.min(availableHeight, Math.max(Math.min(120, availableHeight), fitHeight));
  let totalWidth = gap * Math.max(0, cards.length - 1);

  cards.forEach((card, index) => {
    const width = Math.max(1, cardHeight * ratios[index]);
    card.style.width = `${width}px`;
    card.style.height = `${cardHeight}px`;
    totalWidth += width;
  });
  grid.style.justifyContent = totalWidth <= grid.clientWidth - padding ? "center" : "flex-start";
}

function clearGridLayoutSchedule(node) {
  if (node._previewSelectorLayoutFrame) cancelAnimationFrame(node._previewSelectorLayoutFrame);
  node._previewSelectorLayoutFrame = 0;
  for (const timer of node._previewSelectorLayoutTimers || []) clearTimeout(timer);
  node._previewSelectorLayoutTimers = [];
}

function scheduleGridLayout(node) {
  clearGridLayoutSchedule(node);
  const generation = node._previewSelectorGridGeneration || 0;
  const run = () => {
    if ((node._previewSelectorGridGeneration || 0) !== generation) return;
    layoutGridCards(node);
  };
  node._previewSelectorLayoutFrame = requestAnimationFrame(() => {
    node._previewSelectorLayoutFrame = 0;
    run();
  });
  node._previewSelectorLayoutTimers = [50, 150, 350, 800, 1600].map((delay) => (
    setTimeout(run, delay)
  ));
}

function renderGrid(node) {
  const grid = node._previewSelectorGrid;
  if (!grid) return;
  node._previewSelectorGridGeneration = (node._previewSelectorGridGeneration || 0) + 1;
  const generation = node._previewSelectorGridGeneration;
  clearGridLayoutSchedule(node);
  grid.replaceChildren();
  const images = node._previewSelectorImages || [];

  if (!images.length) {
    const empty = document.createElement("div");
    empty.className = "mcips-empty";
    empty.textContent = "执行工作流后在这里显示图片";
    grid.append(empty);
    updateControls(node);
    return;
  }

  images.forEach((item, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `mcips-card${node._previewSelectorSelected === index ? " is-selected" : ""}`;
    card.title = "单击选择，双击放大预览";

    const image = document.createElement("img");
    image.alt = `第 ${index + 1} 张图片`;
    image.loading = "eager";
    image.decoding = "async";
    image.fetchPriority = "high";
    image.draggable = false;
    card.dataset.aspectRatio = String(imageAspectRatio(item));
    const imageSettled = () => {
      if ((node._previewSelectorGridGeneration || 0) !== generation) return;
      if (image.naturalWidth && image.naturalHeight) {
        card.dataset.aspectRatio = String(image.naturalWidth / image.naturalHeight);
      }
      scheduleGridLayout(node);
    };
    image.addEventListener("load", imageSettled, { once: true });
    image.addEventListener("error", imageSettled, { once: true });
    image.src = imageUrl(item);
    image.decode?.().then(imageSettled).catch(() => {});

    const number = document.createElement("span");
    number.className = "mcips-number";
    number.textContent = String(index + 1);

    const check = document.createElement("span");
    check.className = "mcips-check";
    check.textContent = "✓";

    card.addEventListener("click", () => selectImage(node, index));
    card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      showPreview(node, index);
    });
    card.append(image, number, check);
    grid.append(card);
  });
  scheduleGridLayout(node);
  updateControls(node);
}

async function continueWorkflow(node) {
  const state = node._previewSelectorState;
  const index = node._previewSelectorSelected;
  if (state?.status !== "waiting" || !Number.isInteger(index)) return;

  const sessionNodeId = currentSessionNodeId(node);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SELECT_TIMEOUT_MS);
  node._previewSelectorQueueing = true;
  setStatus(node, `正在将第 ${index + 1} 张图片传给下一个节点...`, "selected");
  updateControls(node);

  try {
    const response = await api.fetchApi("/my-comfnode/image-preview-selector/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        node_id: sessionNodeId,
        session_id: state.session_id,
        signature: state.signature,
        index,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    markSelectionSubmitted(node, state, index, result.node_id || sessionNodeId);
  } catch (error) {
    console.error("[ImagePreviewSelector] continue failed", error);
    node._previewSelectorQueueing = false;
    const message = error?.name === "AbortError"
      ? "云端放行请求超时，请重新点一次“下一步”"
      : (error?.message || "继续执行失败，请重试");
    setStatus(node, message, "error");
    updateControls(node);
  } finally {
    clearTimeout(timeoutId);
  }
}

function createInterface(node) {
  const root = document.createElement("div");
  root.className = "mcips-root";
  root.innerHTML = `
    <style>
      .mcips-root { box-sizing: border-box; width: 100%; height: 100%; min-height: ${VIEW_HEIGHT}px; display: flex; flex-direction: column; gap: 8px; padding: 10px; color: #eceef2; background: #17191d; border: 1px solid #353840; border-radius: 7px; font: 12px/1.35 Arial, sans-serif; overflow: hidden; }
      .mcips-root * { box-sizing: border-box; }
      .mcips-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 7px; flex: 0 0 auto; }
      .mcips-status { min-width: 0; overflow: hidden; color: #aeb2bc; text-overflow: ellipsis; white-space: nowrap; }
      .mcips-status[data-tone="selected"] { color: #7ed9a6; }
      .mcips-status[data-tone="error"] { color: #ff9d9d; }
      .mcips-button { min-width: 78px; height: 32px; border: 1px solid #4b4f59; border-radius: 5px; padding: 0 12px; color: #f7f8fa; background: #2b2e35; cursor: pointer; font-weight: 600; }
      .mcips-button:hover:not(:disabled) { background: #373b44; border-color: #666b77; }
      .mcips-button.primary { background: #27714d; border-color: #42966c; }
      .mcips-button.primary:hover:not(:disabled) { background: #31835b; }
      .mcips-button:disabled { opacity: .42; cursor: default; }
      .mcips-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; border: 1px solid #3d414a; border-radius: 6px; background: #0d0f12; }
      .mcips-grid { width: 100%; height: 100%; display: flex; flex-flow: row nowrap; align-items: center; justify-content: center; gap: 8px; padding: 8px; overflow: auto; }
      .mcips-grid.is-hidden, .mcips-preview.is-hidden { display: none; }
      .mcips-empty { width: 100%; min-height: 300px; display: flex; align-items: center; justify-content: center; color: #858a95; }
      .mcips-card { position: relative; flex: 0 0 auto; min-width: 1px; min-height: 1px; padding: 0; overflow: hidden; border: 2px solid transparent; border-radius: 6px; background: #08090b; cursor: pointer; }
      .mcips-card:hover { border-color: #656b78; }
      .mcips-card.is-selected { border-color: #55c58a; box-shadow: inset 0 0 0 1px #55c58a; }
      .mcips-card img { width: 100%; height: 100%; display: block; object-fit: fill; background: #08090b; }
      .mcips-number { position: absolute; left: 7px; bottom: 7px; min-width: 23px; height: 23px; display: grid; place-items: center; border: 1px solid #646975; border-radius: 4px; color: #fff; background: rgba(15, 17, 20, .88); font-weight: 700; }
      .mcips-check { position: absolute; top: 7px; right: 7px; width: 24px; height: 24px; display: none; place-items: center; border-radius: 50%; color: #07130c; background: #65d497; font-size: 16px; font-weight: 900; }
      .mcips-card.is-selected .mcips-check { display: grid; }
      .mcips-preview { position: absolute; inset: 0; overflow: hidden; cursor: grab; user-select: none; touch-action: none; }
      .mcips-preview.is-dragging { cursor: grabbing; }
      .mcips-preview img { position: absolute; left: 50%; top: 50%; max-width: 100%; max-height: 100%; transform-origin: center center; translate: -50% -50%; object-fit: contain; will-change: transform; pointer-events: none; }
      .mcips-preview-label { position: absolute; right: 9px; bottom: 9px; z-index: 2; padding: 5px 8px; border: 1px solid #555b67; border-radius: 4px; color: #f5f6f8; background: rgba(17, 19, 23, .86); }
    </style>
    <div class="mcips-toolbar">
      <div class="mcips-status">等待执行并加载图片</div>
      <button class="mcips-button mcips-back" type="button" disabled>返回列表</button>
      <button class="mcips-button primary mcips-next" type="button" disabled>下一步</button>
    </div>
    <div class="mcips-stage">
      <div class="mcips-grid"><div class="mcips-empty">执行工作流后在这里显示图片</div></div>
      <div class="mcips-preview is-hidden">
        <img draggable="false" alt="单图预览">
        <span class="mcips-preview-label"></span>
      </div>
    </div>
  `;

  node._previewSelectorStatus = root.querySelector(".mcips-status");
  node._previewSelectorNext = root.querySelector(".mcips-next");
  node._previewSelectorPreviewBack = root.querySelector(".mcips-back");
  node._previewSelectorGrid = root.querySelector(".mcips-grid");
  node._previewSelectorPreview = root.querySelector(".mcips-preview");
  node._previewSelectorLargeImage = root.querySelector(".mcips-preview img");
  node._previewSelectorPreviewLabel = root.querySelector(".mcips-preview-label");

  node._previewSelectorNext.addEventListener("click", () => continueWorkflow(node));
  node._previewSelectorPreviewBack.addEventListener("click", () => showList(node));

  const preview = node._previewSelectorPreview;
  preview.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.16 : 1 / 1.16;
    node._previewSelectorZoom = Math.min(8, Math.max(1, (node._previewSelectorZoom || 1) * factor));
    if (node._previewSelectorZoom === 1) {
      node._previewSelectorPanX = 0;
      node._previewSelectorPanY = 0;
    }
    applyTransform(node);
  }, { passive: false });

  preview.addEventListener("pointerdown", (event) => {
    if ((node._previewSelectorZoom || 1) <= 1) return;
    preview.setPointerCapture(event.pointerId);
    preview.classList.add("is-dragging");
    node._previewSelectorDrag = {
      x: event.clientX,
      y: event.clientY,
      panX: node._previewSelectorPanX || 0,
      panY: node._previewSelectorPanY || 0,
    };
  });
  preview.addEventListener("pointermove", (event) => {
    const drag = node._previewSelectorDrag;
    if (!drag) return;
    node._previewSelectorPanX = drag.panX + event.clientX - drag.x;
    node._previewSelectorPanY = drag.panY + event.clientY - drag.y;
    applyTransform(node);
  });
  const endDrag = () => {
    node._previewSelectorDrag = null;
    preview.classList.remove("is-dragging");
  };
  preview.addEventListener("pointerup", endDrag);
  preview.addEventListener("pointercancel", endDrag);
  preview.addEventListener("dblclick", resetTransform.bind(null, node));
  return root;
}

function suppressNativePreview(node, preferredSize) {
  node.hideOutputImages = true;
  node.imgs = [];
  node.imageIndex = null;
  node.overIndex = null;
  node.imageRects = null;
  if (
    Array.isArray(preferredSize)
    && preferredSize.length >= 2
    && node.size?.[1] > preferredSize[1]
  ) {
    node.setSize?.([Math.max(node.size[0], preferredSize[0]), preferredSize[1]]);
  }
  node.graph?.setDirtyCanvas?.(true, true);
  requestAnimationFrame(() => layoutGridCards(node));
}

function scheduleNativePreviewSuppression(node, preferredSize) {
  suppressNativePreview(node, preferredSize);
  requestAnimationFrame(() => suppressNativePreview(node, preferredSize));
  setTimeout(() => suppressNativePreview(node, preferredSize), 50);
  setTimeout(() => suppressNativePreview(node, preferredSize), 200);
  setTimeout(() => suppressNativePreview(node, preferredSize), 800);
}

function handleExecuted(node, message) {
  const states = message?.selector_state;
  const state = Array.isArray(states) ? states[0] : states;
  const images = message?.selector_images ?? message?.images;
  if (!state || !Array.isArray(images)) return;

  const inputChanged = node._previewSelectorState?.signature !== state.signature;
  node._previewSelectorImages = images;
  node._previewSelectorState = state;
  node._previewSelectorQueueing = false;

  if (state.status === "passed") {
    node._previewSelectorSubmitted = null;
  }

  if (inputChanged || state.status === "waiting") {
    node._previewSelectorSelected = Number.isInteger(state.selected_index)
      ? state.selected_index
      : null;
    showList(node);
  }

  if (state.status === "passed") {
    node._previewSelectorSelected = state.selected_index;
    const widget = findWidget(node, PAYLOAD_WIDGET);
    if (widget) widget.value = "";
    setStatus(node, `已放行第 ${state.selected_index + 1} 张图片`, "selected");
  } else {
    setStatus(node, `共 ${state.count} 张，请选择一张后点击“下一步”`);
  }
  renderGrid(node);
  updateControls(node);
}

function findSelectorNode(nodeId) {
  let node = app.graph?.getNodeById?.(nodeId) || app.graph?.getNodeById?.(Number(nodeId));
  if (!node || (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS)) {
    const graphCandidates = (app.graph?._nodes || []).filter((item) => (
      item?._previewSelectorReady
      || item?.comfyClass === NODE_CLASS
      || item?.type === NODE_CLASS
    ));
    const liveCandidates = [...SELECTOR_NODES].filter((item) => (
      item?._previewSelectorStatus?.isConnected
    ));
    const candidates = graphCandidates.length ? graphCandidates : liveCandidates;
    node = candidates.find((item) => (
      item?._previewSelectorStatus?.closest?.(".mcips-root")?.dataset.nodeId === String(nodeId)
    ));
    if (!node && candidates.length === 1) node = candidates[0];
  }
  return node;
}

function handleWaitingDetail(detail) {
  const nodeId = detail?.node_id;
  const node = findSelectorNode(nodeId);
  if (!node) return;

  const incomingImages = Array.isArray(detail.images) ? detail.images : [];
  const currentImages = node._previewSelectorImages || [];
  const submitted = node._previewSelectorSubmitted;
  const incomingState = detail.selector_state || {};
  const sameSubmittedSession = (
    submitted?.session_id
    && incomingState.session_id
    && submitted.session_id === incomingState.session_id
  );
  if (sameSubmittedSession) {
    if (node._previewSelectorStatus?.closest?.(".mcips-root")) {
      node._previewSelectorStatus.closest(".mcips-root").dataset.nodeId = String(nodeId);
    }
    node._previewSelectorSessionNodeId = String(nodeId);
    node._previewSelectorImages = incomingImages.length ? incomingImages : currentImages;
    setStatus(node, `已放行第 ${submitted.selected_index + 1} 张，等待下游节点完成...`, "selected");
    updateControls(node);
    return;
  }
  if (submitted && incomingState.session_id !== submitted.session_id) {
    node._previewSelectorSubmitted = null;
  }

  const sameWaitingSession = (
    node._previewSelectorState?.status === "waiting"
    && node._previewSelectorState?.session_id === incomingState.session_id
    && node._previewSelectorState?.signature === detail.selector_state?.signature
  );
  const sameImages = (
    currentImages.length === incomingImages.length
    && currentImages.every((item, index) => imageKey(item) === imageKey(incomingImages[index]))
  );
  if (sameWaitingSession && sameImages) return;

  const preferredSize = Array.isArray(node.size) ? [...node.size] : null;
  initNode(node);
  if (node._previewSelectorStatus?.closest?.(".mcips-root")) {
    node._previewSelectorStatus.closest(".mcips-root").dataset.nodeId = String(nodeId);
  }
  node._previewSelectorSessionNodeId = String(nodeId);
  handleExecuted(node, {
    images: incomingImages,
    selector_state: [detail.selector_state],
  });
  scheduleNativePreviewSuppression(node, preferredSize);
}

function handleWaitingEvent(event) {
  handleWaitingDetail(event?.detail || {});
}

async function pollWaitingSessions() {
  if (sessionPollBusy || ![...SELECTOR_NODES].some((node) => node?._previewSelectorStatus?.isConnected)) return;
  sessionPollBusy = true;
  try {
    const response = await api.fetchApi(SESSIONS_ROUTE);
    if (!response.ok) return;
    const result = await response.json();
    for (const session of result.sessions || []) handleWaitingDetail(session);
  } catch (error) {
    console.debug("[ImagePreviewSelector] session poll unavailable", error);
  } finally {
    sessionPollBusy = false;
  }
}

function ensureSessionPolling() {
  if (sessionPollTimer !== null) return;
  sessionPollTimer = setInterval(pollWaitingSessions, 600);
  pollWaitingSessions();
}

function initNode(node) {
  if (!node || node._previewSelectorReady) return;
  node._previewSelectorReady = true;
  node.hideOutputImages = true;
  SELECTOR_NODES.add(node);
  ensureSessionPolling();
  if (node.title === NODE_CLASS) node.title = "图像预览选择器";
  hideWidget(node, PAYLOAD_WIDGET);
  node._previewSelectorImages = [];
  node._previewSelectorSelected = null;
  node._previewSelectorMode = "list";
  node._previewSelectorZoom = 1;
  node._previewSelectorPanX = 0;
  node._previewSelectorPanY = 0;
  node._previewSelectorGridGeneration = 0;
  node._previewSelectorLayoutTimers = [];

  const root = createInterface(node);
  const syncNodeId = () => { root.dataset.nodeId = String(node.id); };
  syncNodeId();
  requestAnimationFrame(syncNodeId);
  setTimeout(syncNodeId, 0);
  const widget = node.addDOMWidget("image_preview_selector", "MYCOMFNODE_IMAGE_PREVIEW_SELECTOR", root, {
    serialize: false,
    getValue: () => "",
    setValue: () => {},
  });
  widget.serialize = false;
  widget.computeSize = (width) => [width || 430, VIEW_HEIGHT];
  node.setSize?.([Math.max(node.size?.[0] || 440, 440), Math.max(node.size?.[1] || 560, 560)]);

  const originalResize = node.onResize;
  node.onResize = function() {
    const result = originalResize?.apply?.(this, arguments);
    scheduleGridLayout(this);
    return result;
  };

  node._previewSelectorResizeObserver = new ResizeObserver(() => scheduleGridLayout(node));
  node._previewSelectorResizeObserver.observe(node._previewSelectorGrid);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function() {
    SELECTOR_NODES.delete(this);
    clearGridLayoutSchedule(this);
    this._previewSelectorResizeObserver?.disconnect();
    return originalRemoved?.apply?.(this, arguments);
  };
}

const EXTENSION_GUARD = "__myComfnodeImagePreviewSelectorRegistered";

if (!globalThis[EXTENSION_GUARD]) {
  globalThis[EXTENSION_GUARD] = true;
  api.addEventListener("my-comfnode-image-preview-selector", handleWaitingEvent);
  app.registerExtension({
    name: "MyComfnode.ImagePreviewSelector",
    async nodeCreated(node) {
      if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) {
        initNode(node);
      }
    },
    async loadedGraphNode(node) {
      if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) {
        initNode(node);
        hideWidget(node, PAYLOAD_WIDGET);
      }
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
        setTimeout(() => {
          initNode(this);
          hideWidget(this, PAYLOAD_WIDGET);
        }, 0);
        return result;
      };

      const originalExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function(message) {
        const preferredSize = Array.isArray(this.size) ? [...this.size] : null;
        const nativeSafeMessage = message && typeof message === "object"
          ? { ...message, images: undefined }
          : message;
        const result = originalExecuted?.call?.(this, nativeSafeMessage);
        initNode(this);
        handleExecuted(this, message);
        scheduleNativePreviewSuppression(this, preferredSize);
        return result;
      };
    },
  });
}
