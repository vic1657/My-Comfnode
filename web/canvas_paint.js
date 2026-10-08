// Myyyds Canvas Paint Node - ComfyUI 交互式画布扩展
// 在 ComfyUI 节点内实现完整的画笔/橡皮擦/颜色选择等功能
import { app } from "../../scripts/app.js";
import "./okaypixels_image_editor.js";

// ============ 常量定义 ============
const CANVAS_TOKEN = "__CANVAS_BASE64__:";
const PAINT_TOKEN = "__PAINT_BASE64__:";
const MASK_TOKEN = "__MASK_BASE64__:";
const EDITOR_PAINT_PREFIX = "__OP_FULL_COMPOSITE__:";
const WORK_PAINT_TOKEN = "__OP_WORK_PAINT__:";
const IMAGE_REF_PREFIX = "__OP_IMAGE_REF__:";
const PROJECT_TOKEN = "__OP_PROJECT__:";
const PROJECT_DB_NAME = "CanvasPaintOkayPixelsProjects";
const PROJECT_STORE_NAME = "projects";

const WIDGET_NAMES = {
    PAINT_DATA: "paint_base64",
    MASK_DATA: "mask_base64",
    PROJECT_REF: "op_project_ref",
    BRUSH_SIZE: "brush_size",
    MAX_SIZE: "max_size"
};

const LAYOUT = {
    toolWidth: 160,
    portWidth: 78,
    padding: 12,
    btnH: 34,
    btnGap: 8,
    sliderH: 8,
    colorSize: 22,
    colorGap: 6,
    titleH: 28,
    sectionGap: 18,
    labelH: 14,
    topOffset: 58,      // 节点标题栏 + 端口行的高度偏移
    // 面板分区样式
    panelGap: 8,       // 工具面板与画布面板之间的间隙
    panelPad: 10,      // 画布面板内部边距
    innerPad: 12,      // 画布内容距面板边缘的内边距
    panelRadius: 8,    // 面板圆角半径
    panelBorderW: 2,   // 面板边框宽度
    headerPadTop: 10,   // 工具面板卡片内顶部留白（与端口行的视觉分隔）
};

const UI_COLORS = {
    sidebarBg: "#1e1e24",
    sidebarBorder: "#2a2a35",
    sectionLabel: "#8a8a9a",
    btnBg: "#2a2a35",
    btnBgHover: "#333344",
    btnBorder: "#3a3a4a",
    btnActiveBg: "#2563eb",
    btnActiveGlow: "#3b82f6",
    btnActiveBorder: "#60a5fa",
    undoBg: "#2a2a35",
    undoBorder: "#3b82f6",
    clearBg: "#2a2a35",
    clearBorder: "#ef4444",
    sliderTrack: "#2a2a35",
    sliderFill: "#2563eb",
    sliderThumb: "#60a5fa",
    hexBg: "#2a2a35",
    hexBorder: "#3a3a4a",
    fitBg: "#2563eb",
    fitBgHover: "#3b82f6",
    tipsBg: "#1a1a22",
    tipsBorder: "#2a2a35",
    loadBtnBg: "#2563eb",
    loadBtnBgHover: "#3b82f6",
    textMain: "#e0e0e8",
    textDim: "#8a8a9a",
    textBright: "#ffffff",
    panelBorder: "#3a3a50"      // 面板分区边框（非激活态 -- 与节点底色调和）
};

const COLORS = [
    "#FF0000", "#FF6600", "#FFCC00", "#00FF00", "#00FFFF",
    "#0066FF", "#9900FF", "#FF00FF", "#000000", "#FFFFFF"
];

// ============ 工具函数 ============
function getStore() {
    if (!window.__canvas_paint_store) window.__canvas_paint_store = {};
    return window.__canvas_paint_store;
}

function ensureExternalPaintCanvas(node) {
    if (!node?._paintCanvas) return null;
    const nd = getNodeData(node);
    if (!node._externalPaintCanvas) node._externalPaintCanvas = document.createElement("canvas");
    if (node._externalPaintCanvas.width !== node._paintCanvas.width || node._externalPaintCanvas.height !== node._paintCanvas.height) {
        const old = node._externalPaintCanvas;
        const next = document.createElement("canvas");
        next.width = node._paintCanvas.width;
        next.height = node._paintCanvas.height;
        if (old.width && old.height) next.getContext("2d").drawImage(old, 0, 0, next.width, next.height);
        node._externalPaintCanvas = next;
    }
    if (nd.externalPaintDirty === undefined) nd.externalPaintDirty = false;
    return node._externalPaintCanvas;
}

function clearExternalPaintCanvas(node) {
    const canvas = ensureExternalPaintCanvas(node);
    if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    const nd = getNodeData(node);
    nd.externalPaintDirty = false;
    nd.maskDirty = false;
    nd.outputDirty = true;
}

function fillMaskBlack(maskCanvas) {
    if (!maskCanvas) return;
    const mctx = maskCanvas.getContext("2d");
    mctx.globalCompositeOperation = "source-over";
    mctx.fillStyle = "#000000";
    mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
}

function canvasHasAlphaPixels(canvas) {
    if (!canvas?.width || !canvas?.height) return false;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) return true;
    }
    return false;
}

function setOutputDirty(node, maskDirty = null) {
    const nd = getNodeData(node);
    nd.outputDirty = true;
    if (maskDirty !== null) nd.maskDirty = !!maskDirty;
}

function makeUploadName(prefix = "okaypixels") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.png`;
}

function base64ToBlob(base64, mime = "image/png") {
    const raw = atob(base64.includes(",") ? base64.split(",").pop() : base64);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let i = 0; i < raw.length; i += chunkSize) {
        const slice = raw.slice(i, i + chunkSize);
        const bytes = new Uint8Array(slice.length);
        for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
        chunks.push(bytes);
    }
    return new Blob(chunks, { type: mime });
}

function encodeImageRef(ref) {
    return IMAGE_REF_PREFIX + encodeURIComponent(JSON.stringify(ref || {}));
}

async function uploadImageBlob(blob, prefix) {
    if (!blob) return "";
    const form = new FormData();
    const filename = makeUploadName(prefix);
    form.append("image", blob, filename);
    form.append("type", "input");
    form.append("overwrite", "true");
    const res = await fetch("/upload/image", { method: "POST", body: form });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const data = await res.json().catch(() => ({}));
    return encodeImageRef({
        filename: data.name || filename,
        subfolder: data.subfolder || "",
        type: data.type || "input",
    });
}

async function uploadBase64Image(base64, prefix) {
    if (!base64) return "";
    return await uploadImageBlob(base64ToBlob(base64), prefix);
}

function splitEditorPayload(value) {
    if (typeof value !== "string" || !value.startsWith(EDITOR_PAINT_PREFIX)) {
        return { prefix: "", body: value || "" };
    }
    const rest = value.slice(EDITOR_PAINT_PREFIX.length);
    if (rest.startsWith("changed:")) {
        return { prefix: `${EDITOR_PAINT_PREFIX}changed:`, body: rest.slice("changed:".length) };
    }
    if (rest.startsWith("same:")) {
        return { prefix: `${EDITOR_PAINT_PREFIX}same:`, body: rest.slice("same:".length) };
    }
    return { prefix: EDITOR_PAINT_PREFIX, body: rest };
}

async function imagePayloadForPrompt(value, prefix, cache) {
    if (!value || typeof value !== "string") return "";
    const { prefix: editorPrefix, body } = splitEditorPayload(value);
    const raw = (body || "").trim();
    if (!raw || raw.startsWith(IMAGE_REF_PREFIX)) return value;
    if (raw.startsWith("__")) return value;
    if (raw.includes(WORK_PAINT_TOKEN)) {
        const [basePart, overlayPart] = raw.split(WORK_PAINT_TOKEN, 2);
        const sep = overlayPart ? overlayPart.indexOf(":") : -1;
        if (sep < 0) return value;
        const sizePart = overlayPart.slice(0, sep);
        const overlayRaw = overlayPart.slice(sep + 1);
        const basePayload = await imagePayloadForPrompt(basePart, `${prefix}_base`, cache);
        const overlayPayload = await imagePayloadForPrompt(overlayRaw, `${prefix}_overlay`, cache);
        return `${editorPrefix}${basePayload}${WORK_PAINT_TOKEN}${sizePart}:${overlayPayload}`;
    }
    const sig = imageSignatureFromBase64(raw);
    const cacheKey = `${prefix}:${sig}`;
    if (cache?.has(cacheKey)) return editorPrefix + await cache.get(cacheKey);
    try {
        const uploadPromise = uploadBase64Image(raw, prefix);
        cache?.set(cacheKey, uploadPromise);
        const ref = await uploadPromise;
        if (ref) {
            cache?.set(cacheKey, ref);
            return editorPrefix + ref;
        }
    } catch (err) {
        cache?.delete(cacheKey);
        console.warn("[CanvasPaint] image upload failed, falling back to base64:", err);
    }
    return value;
}

async function warmPromptImageUpload(node, base64, prefix = "canvas_paint") {
    if (!node || !base64) return "";
    const nd = getNodeData(node);
    const store = getStore();
    if (!store.__canvasPaintUploadCache) store.__canvasPaintUploadCache = new Map();
    try {
        const ref = await imagePayloadForPrompt(base64, prefix, store.__canvasPaintUploadCache);
        if (typeof ref !== "string" || !ref.startsWith(IMAGE_REF_PREFIX)) return "";
        if (nd.editorCompositeBase64 !== base64) return ref;
        nd.editorCompositeRef = ref;
        nd.outputDirty = true;
        syncToWidgets(node);
        return ref;
    } catch (err) {
        console.warn("[CanvasPaint] background image upload failed:", err);
        return "";
    }
}

async function warmPromptBlobUpload(node, base64, blob, prefix = "canvas_paint") {
    if (!node || !base64 || !blob) {
        return await warmPromptImageUpload(node, base64, prefix);
    }
    const nd = getNodeData(node);
    const store = getStore();
    if (!store.__canvasPaintUploadCache) store.__canvasPaintUploadCache = new Map();
    const sig = imageSignatureFromBase64(base64);
    const cacheKey = `${prefix}:${sig}`;
    try {
        const uploadPromise = uploadImageBlob(blob, prefix);
        store.__canvasPaintUploadCache.set(cacheKey, uploadPromise);
        const ref = await uploadPromise;
        store.__canvasPaintUploadCache.set(cacheKey, ref);
        if (nd.editorCompositeBase64 !== base64) return ref;
        nd.editorCompositeRef = ref;
        nd.outputDirty = true;
        syncToWidgets(node);
        return ref;
    } catch (err) {
        store.__canvasPaintUploadCache.delete(cacheKey);
        console.warn("[CanvasPaint] background blob upload failed:", err);
        return "";
    }
}

async function preparePromptOutputValue(nodeKey, kind, inputValue = "") {
    const store = getStore();
    const token = kind === "_mask" ? MASK_TOKEN : PAINT_TOKEN;
    const inputText = typeof inputValue === "string" ? inputValue : "";
    const storeKey = inputText.startsWith(token) ? inputText.slice(token.length) : nodeKey;
    const raw = store[storeKey + kind] || (inputText && !inputText.startsWith(token) ? inputText : "");
    if (!raw) return "";
    if (!store.__canvasPaintUploadCache) store.__canvasPaintUploadCache = new Map();
    const prefix = kind === "_mask" ? "canvas_paint_mask" : "canvas_paint";
    return await imagePayloadForPrompt(raw, prefix, store.__canvasPaintUploadCache);
}

function stableProjectId(node) {
    if (!node.properties) node.properties = {};
    if (!node.properties.opProjectId) {
        node.properties.opProjectId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return node.properties.opProjectId;
}

function projectStoreKey(node) {
    return `op_project_${stableProjectId(node)}`;
}

function imageSignatureFromBase64(base64, width = 0, height = 0) {
    const text = String(base64 || "");
    if (!text) return "";
    const len = text.length;
    return `${width || 0}x${height || 0}:${len}:${text.slice(0, 96)}:${text.slice(Math.max(0, len - 96))}`;
}

function setProjectWidgetRef(node, key = projectStoreKey(node)) {
    const widget = node.widgets?.find(w => w.name === WIDGET_NAMES.PROJECT_REF);
    if (widget) widget.value = PROJECT_TOKEN + key;
}

function ensureProjectWidget(node) {
    if (!node || node.widgets?.some(w => w.name === WIDGET_NAMES.PROJECT_REF)) return;
    if (typeof node.addWidget === "function") {
        node.addWidget("text", WIDGET_NAMES.PROJECT_REF, "", () => {}, { serialize: true });
    }
}

function openProjectDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error("IndexedDB is unavailable"));
            return;
        }
        const req = window.indexedDB.open(PROJECT_DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(PROJECT_STORE_NAME)) {
                req.result.createObjectStore(PROJECT_STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function writeProjectRecord(key, record) {
    getStore()[key] = record;
    try {
        const db = await openProjectDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(PROJECT_STORE_NAME, "readwrite");
            tx.objectStore(PROJECT_STORE_NAME).put(record, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    } catch (e) {
        try {
            window.localStorage?.setItem(key, JSON.stringify(record));
        } catch (localErr) {
            console.warn("[CanvasPaint] Project persistence failed:", e, localErr);
        }
    }
}

async function readProjectRecord(key) {
    if (!key) return null;
    const store = getStore();
    if (store[key]) return store[key];
    try {
        const db = await openProjectDb();
        const record = await new Promise((resolve, reject) => {
            const tx = db.transaction(PROJECT_STORE_NAME, "readonly");
            const req = tx.objectStore(PROJECT_STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
        db.close();
        if (record) store[key] = record;
        return record;
    } catch (_e) {
        try {
            const raw = window.localStorage?.getItem(key);
            const record = raw ? JSON.parse(raw) : null;
            if (record) store[key] = record;
            return record;
        } catch (_localErr) {
            return null;
        }
    }
}

function clearProjectRecord(node) {
    const key = projectStoreKey(node);
    delete getStore()[key];
    const widget = node.widgets?.find(w => w.name === WIDGET_NAMES.PROJECT_REF);
    if (widget) widget.value = "";
    const nd = getNodeData(node);
    nd.opProject = null;
    nd.opProjectInputSignature = "";
    if (node.properties) {
        node.properties.opProjectInputSignature = "";
    }
    try { window.localStorage?.removeItem(key); } catch (_e) { }
    openProjectDb().then(db => {
        const tx = db.transaction(PROJECT_STORE_NAME, "readwrite");
        tx.objectStore(PROJECT_STORE_NAME).delete(key);
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
    }).catch(() => {
        try { window.localStorage?.removeItem(key); } catch (_e) { }
    });
}

function projectRefKeyFromNode(node) {
    const raw = node.widgets?.find(w => w.name === WIDGET_NAMES.PROJECT_REF)?.value || "";
    if (typeof raw === "string" && raw.startsWith(PROJECT_TOKEN)) return raw.slice(PROJECT_TOKEN.length);
    return projectStoreKey(node);
}

function installFetchPatch() {
    if (window.__mycomfnode_canvas_fetch_patched) return;
    window.__mycomfnode_canvas_fetch_patched = true;
    const orig = window.fetch?.bind(window);
    if (!orig) return;
    window.fetch = async function(input, init) {
        try {
            const url = typeof input === "string" ? input : input?.url;
            const body = init?.body;
            if (typeof url === "string" && url.includes("/api/prompt") && typeof body === "string") {
                const store = getStore();
                const payload = JSON.parse(body);
                const canvasPaintNodeIds = new Set();
                const prompt = payload?.prompt || payload?.workflow?.prompt;
                if (prompt && typeof prompt === "object") {
                    for (const [nodeId, def] of Object.entries(prompt)) {
                        if (def?.class_type === "MyComfnodeCanvasPaintNode") canvasPaintNodeIds.add(String(nodeId));
                    }
                }
                const visit = (v, key = "", parent = null) => {
                    if (typeof v === "string") {
                        if (v.startsWith(CANVAS_TOKEN)) return store[v.slice(CANVAS_TOKEN.length)] || "";
                        const isCanvasPaintInput = parent?.class_type === "MyComfnodeCanvasPaintNode";
                        if (v.startsWith(PAINT_TOKEN)) {
                            if ((key === "paint_base64" && isCanvasPaintInput) || canvasPaintNodeIds.has(v.slice(PAINT_TOKEN.length))) return v;
                            return store[v.slice(PAINT_TOKEN.length) + "_paint"] || "";
                        }
                        if (v.startsWith(MASK_TOKEN)) {
                            if ((key === "mask_base64" && isCanvasPaintInput) || canvasPaintNodeIds.has(v.slice(MASK_TOKEN.length))) return v;
                            return store[v.slice(MASK_TOKEN.length) + "_mask"] || "";
                        }
                        return v;
                    }
                    if (!v || typeof v !== "object") return v;
                    if (Array.isArray(v)) return v.map(item => visit(item, "", null));
                    for (const k of Object.keys(v)) v[k] = visit(v[k], k, v);
                    return v;
                };
                visit(payload);
                if (prompt && typeof prompt === "object") {
                    for (const [nodeId, def] of Object.entries(prompt)) {
                        if (!def || def.class_type !== "MyComfnodeCanvasPaintNode" || !def.inputs) continue;
                        const graphNode = app.graph?.getNodeById?.(Number(nodeId));
                        const nodeKey = String(graphNode?.id ?? nodeId);
                        if (graphNode) {
                            const nd = getNodeData(graphNode);
                            const store = getStore();
                            if (nd.outputDirty || store[nodeKey + "_paint"] === undefined || store[nodeKey + "_mask"] === undefined) {
                                syncToWidgets(graphNode);
                            }
                        }
                        const maxFromNode = Number(graphNode?.properties?.maxSize);
                        const brushFromNode = Number(graphNode?.properties?.brushSize);
                        if (!Number.isFinite(Number(def.inputs.max_size))) {
                            def.inputs.max_size = Number.isFinite(maxFromNode) ? maxFromNode : 1024;
                        }
                        def.inputs.max_size = Math.max(256, Math.min(4096, Number(def.inputs.max_size) || 1024));
                        if (!Number.isFinite(Number(def.inputs.brush_size))) {
                            def.inputs.brush_size = Number.isFinite(brushFromNode) ? brushFromNode : 30;
                        }
                        def.inputs.paint_base64 = await preparePromptOutputValue(nodeKey, "_paint", def.inputs.paint_base64);
                        def.inputs.mask_base64 = await preparePromptOutputValue(nodeKey, "_mask", def.inputs.mask_base64);
                    }
                }
                init = { ...(init || {}), body: JSON.stringify(payload) };
            }
        } catch (_e) { }
        return orig(input, init);
    };
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function getContrastColor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    // 亮度计算
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    // 亮色背景用深色线，深色背景用亮色线；中性色用蓝色
    if (luminance > 0.7) return "#0066FF"; // 浅色/黄色背景 → 蓝色
    if (luminance < 0.3) return "#00CCFF"; // 深色背景 → 浅蓝
    return "#0080FF"; // 中性背景 → 蓝
}

function parseRgb(hex) {
    return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    ];
}

// ============ 核心逻辑 ============
function initProperties(node) {
    if (!node.properties) node.properties = {};
    const p = node.properties;

    // 清理旧版本可能残留的大属性（避免工作流保存失败）
    delete p.bgImage;
    delete p.bgBase64;
    delete p.undoStack;
    delete p.opProject;
    delete p.okayPixelsProject;

    const defs = {
        canvasWidth: 512, canvasHeight: 512,
        scale: 1.0, offsetX: 0, offsetY: 0,
        tool: "brush", brushSize: 30, brushColor: "#FF0000",
        brushAlpha: 100,
        maxSize: 1024,
        isDrawing: false, isPanning: false,
        currentPath: [], brushPaths: [],
        penPoints: [], penState: "idle", toolMenuOpen: false,
        maxUndo: 20,
        opProjectId: "",
        opProjectInputSignature: "",
        ui: null
        // 注意：不存储 bgImage / bgBase64 / undoStack 到 properties
        // 这些数据太大，会导致工作流保存失败
    };
    for (const [k, v] of Object.entries(defs)) {
        if (p[k] === undefined) p[k] = v;
    }
    if (p.tool === "maskBrush") p.tool = "brush";
    delete p.maskPaintOnly;
    return p;
}

function getToolLabel(tool) {
    if (tool === "pen") return "✒ 钢笔";
    if (tool === "eraser") return "🧽 橡皮擦";
    return "🖌 画笔";
}

function getNodeImageData(node) {
    const nd = getNodeData(node);
    if (nd.editorBaseBase64) return "data:image/png;base64," + nd.editorBaseBase64;
    if (nd.bgBase64) return "data:image/png;base64," + nd.bgBase64;
    const storeValue = getStore()[String(node.id)];
    if (storeValue) return "data:image/png;base64," + storeValue;
    return "";
}

async function loadProjectForEditor(node) {
    const nd = getNodeData(node);
    const signature = nd.inputSignature || node.properties?.opProjectInputSignature || "";
    const key = projectRefKeyFromNode(node);
    const record = await readProjectRecord(key);
    const project = record?.project || nd.opProject || null;
    const savedSignature = record?.inputSignature || project?.inputSignature || nd.opProjectInputSignature || "";
    if (project && signature && savedSignature === signature) {
        nd.opProject = project;
        nd.opProjectInputSignature = signature;
        setProjectWidgetRef(node, key);
        return { project, inputSignature: signature };
    }
    if (project && signature && savedSignature && savedSignature !== signature) {
        clearProjectRecord(node);
    }
    return { project: null, inputSignature: signature };
}

async function openOkayPixelsImageEditor(node) {
    const imageData = getNodeImageData(node);
    if (!imageData) {
        try {
            app.extensionManager?.toast?.add?.({
                severity: "warn",
                summary: "图片编辑",
                detail: "请先连接或加载一张图片",
                life: 2600,
            });
        } catch (_e) {
            console.warn("[CanvasPaint] No image data available for editor");
        }
        autoLoadConnectedImage(node);
        return;
    }
    if (!window.OkayPixelsComfyImageEditor?.open) {
        console.error("[CanvasPaint] OkayPixels image editor module is not loaded");
        return;
    }
    const nd = getNodeData(node);
    if (!nd.inputSignature) {
        const raw = imageData.includes(",") ? imageData.split(",")[1] : imageData;
        nd.inputSignature = node.properties?.opProjectInputSignature || imageSignatureFromBase64(raw);
    }
    const { project, inputSignature } = await loadProjectForEditor(node);
    window.OkayPixelsComfyImageEditor.open({
        node,
        imageData,
        project,
        inputSignature,
        onSave: async ({ imageBase64, imageBlob, maskBase64, maskBlob, width, height, project }) => {
            await applyEditorResultToNode(node, imageBase64, maskBase64, width, height, project, imageBlob, maskBlob);
        },
    });
}

function getNodeData(node) {
    const store = getStore();
    const key = "node_data_" + node.id;
    if (!store[key]) {
        store[key] = {
            bgImage: null,
            bgBase64: "",
            editorBaseBase64: "",
            editorCompositeBase64: "",
            editorCompositeRef: "",
            editorCompositeMode: "",
            editorCompositeWidth: 0,
            editorCompositeHeight: 0,
            externalPaintDirty: false,
            maskDirty: false,
            outputDirty: true,
            outputCacheKey: "",
            undoStack: [],
            opProject: null,
            opProjectInputSignature: "",
            inputSignature: "",
        };
    }
    return store[key];
}

function startUpstreamWatcher(node) {
    if (node._upstreamWatcher) clearInterval(node._upstreamWatcher);
    node._upstreamWatcher = setInterval(() => {
        if (!app.graph) return;
        const link = resolveLink(node, 0);
        if (!link) return;
        const srcNode = app.graph.getNodeById(link.origin_id);
        if (!srcNode) return;
        const imgWidget = srcNode.widgets?.find(w => w.name === "image") || srcNode.widgets?.[0];
        if (!imgWidget?.value) return;
        const currentFilename = imgWidget.value;
        const nd = getNodeData(node);
        if (nd._lastFilename && nd._lastFilename !== currentFilename) {
            console.log("[CanvasPaint] Upstream image changed: " + nd._lastFilename + " -> " + currentFilename);
            nd.bgImage = null;
            nd.bgBase64 = "";
            nd.editorBaseBase64 = "";
            nd.editorCompositeBase64 = "";
            nd.editorCompositeRef = "";
            nd.editorCompositeMode = "";
            nd.externalPaintDirty = false;
            nd.maskDirty = false;
            nd.outputDirty = true;
            clearProjectRecord(node);
            autoLoadConnectedImage(node);
        }
        nd._lastFilename = currentFilename;
    }, 1000);
}

function stopUpstreamWatcher(node) {
    if (node._upstreamWatcher) {
        clearInterval(node._upstreamWatcher);
        node._upstreamWatcher = null;
    }
}

// 工具面板内容最小高度：从 buildUI 布局链计算
// topOffset=58 是卡片顶部，内容从 cardTop+headerPadTop+titleH+6=102 开始
// 底部最后一个元素 fitBtn 约在 y=620，加底部留白
const TOOL_PANEL_MIN_CONTENT_H = 660;  // 工具面板内容区最小高度（卡片内）
const NODE_MIN_HEIGHT = 740;           // 节点最小高度（含标题栏+端口行）
const NODE_MIN_WIDTH = 720;            // 节点最小宽度（默认）

// 计算并确保节点尺寸刚好容纳画布图像 + 工具箱
function ensureNodeFits(node) {
    const p = node.properties;
    if (!p || !p.canvasWidth) return;
    const sw = p.canvasWidth * p.scale;
    const sh = p.canvasHeight * p.scale;

    const horizontalChrome = LAYOUT.toolWidth + LAYOUT.panelGap + LAYOUT.portWidth + LAYOUT.panelPad * 2 + LAYOUT.innerPad * 2;
    const verticalChrome = LAYOUT.topOffset + LAYOUT.panelPad * 2 + LAYOUT.innerPad * 2;
    const neededW = Math.ceil(sw + horizontalChrome);
    const neededH = Math.ceil(sh + verticalChrome);

    // 宽度下限：工具面板(160) + 间距(6) + 最小画布(100) + 端口(40) ≈ 306
    const finalW = Math.max(neededW, NODE_MIN_WIDTH);
    // 高度下限：工具面板内容或 node 默认高度
    const finalH = Math.max(neededH, NODE_MIN_HEIGHT);

    const changed = (node.size[0] !== finalW || node.size[1] !== finalH);
    if (changed) {
        node.size = [finalW, finalH];
        // 尺寸变更后，重新居中图像（与 updateLayout 公式一致）
        const canvasX = LAYOUT.toolWidth + LAYOUT.panelGap + LAYOUT.panelPad;
        const canvasW = finalW - LAYOUT.toolWidth - LAYOUT.panelGap - LAYOUT.portWidth - LAYOUT.panelPad * 2;
        const canvasY = LAYOUT.topOffset + LAYOUT.panelPad;
        const canvasH = finalH - LAYOUT.topOffset - LAYOUT.panelPad * 2;
        p.offsetX = canvasX + LAYOUT.innerPad + (canvasW - LAYOUT.innerPad * 2 - sw) / 2;
        p.offsetY = canvasY + LAYOUT.innerPad + (canvasH - LAYOUT.innerPad * 2 - sh) / 2;
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    }
}

function updateLayout(node) {
    const p = node.properties;
    // 画布面板内部可用区域（扣除面板边距和内容内边距）
    const canvasX = LAYOUT.toolWidth + LAYOUT.panelGap + LAYOUT.panelPad;
    const canvasW = node.size[0] - LAYOUT.toolWidth - LAYOUT.panelGap - LAYOUT.portWidth - LAYOUT.panelPad * 2;
    // 画布面板卡片与工具面板对齐：统一从 topOffset 开始
    const canvasY = LAYOUT.topOffset + LAYOUT.panelPad;
    const canvasH = node.size[1] - LAYOUT.topOffset - LAYOUT.panelPad * 2;
    const maxDisp = Math.min(canvasW - LAYOUT.innerPad * 2, canvasH - LAYOUT.innerPad * 2);
    const sx = maxDisp / p.canvasWidth;
    const sy = maxDisp / p.canvasHeight;
    p.scale = Math.min(sx, sy, 1.0);
    const sw = p.canvasWidth * p.scale;
    const sh = p.canvasHeight * p.scale;
    p.offsetX = canvasX + LAYOUT.innerPad + (canvasW - LAYOUT.innerPad * 2 - sw) / 2;
    p.offsetY = canvasY + LAYOUT.innerPad + (canvasH - LAYOUT.innerPad * 2 - sh) / 2;
}

function buildUI(node) {
    const p = node.properties;
    const tw = LAYOUT.toolWidth;
    const pad = LAYOUT.padding;
    // 工具面板卡片起始 Y（= topOffset），但内容区需要留出标题空间
    const cardTop = LAYOUT.topOffset;
    // 内容区起始：卡片顶部 + 标题区内边距 + 标题高度 + 标题与内容间距
    let y = cardTop + LAYOUT.headerPadTop + LAYOUT.titleH + 6;

    const sH = LAYOUT.sliderH + 18;
    const menuBtnH = LAYOUT.btnH;
    const menuItemH = 32;

    const menuOpen = !!p.toolMenuOpen;
    const editorBtnY = y + 4;
    const editorBtnH = 44;
    const editorHintY = editorBtnY + editorBtnH + 14;
    const toolMenuLabelY = editorHintY + 24;
    const menuBtnY = toolMenuLabelY + LAYOUT.labelH + 2;

    p.ui = {
        cardTop: cardTop,            // 卡片顶部 Y（供 drawToolbar 画卡片用）
        titleY: cardTop + LAYOUT.headerPadTop,  // 标题绘制 Y
        editorBtn: null,
        editorHintY: 0,
        toolMenuLabelY,
        toolMenuBtn: {
            x: pad, y: menuBtnY,
            w: tw - pad * 2, h: menuBtnH,
            open: menuOpen
        },
        toolMenuItems: [],
        // === MAX SIZE ===
        maxSizeLabelY: 0,
        maxSizeSlider: null,
        // === BRUSH SIZE ===
        sizeLabelY: 0,
        sizeSlider: null,
        // === COLOR ===
        colorSectionY: 0,
        colorPreview: null,
        hexInput: null,
        colorPalette: null,
        // === OPACITY ===
        alphaLabelY: 0,
        alphaSlider: null,
        // === ACTIONS ===
        actionsLabelY: 0,
        undoBtn: null,
        clearBtn: null,
        // === VIEW ===
        viewLabelY: 0,
        zoomBtns: null,
        fitBtn: null
    };

    const ui = p.ui;
    ui.editorBtn = {
        x: pad,
        y: editorBtnY,
        w: tw - pad * 2,
        h: editorBtnH,
        type: "imageEditor",
        label: "图片编辑"
    };
    ui.editorHintY = editorHintY;

    // Tool menu items
    if (menuOpen) {
        let itemY = menuBtnY + menuBtnH + 2;
        ui.toolMenuItems = [
            { x: pad + 4, y: itemY, w: tw - pad * 2 - 8, h: menuItemH, type: "brush", label: "🖌 画笔" },
            { x: pad + 4, y: itemY + menuItemH, w: tw - pad * 2 - 8, h: menuItemH, type: "pen", label: "✒ 钢笔" },
            { x: pad + 4, y: itemY + menuItemH * 2, w: tw - pad * 2 - 8, h: menuItemH, type: "eraser", label: "🧽 橡皮擦" }
        ];
    }

    // Calculate where the next section starts
    let sectionStart = menuBtnY + menuBtnH;
    if (menuOpen) {
        sectionStart = menuBtnY + menuBtnH + 2 + menuItemH * 3 + LAYOUT.sectionGap;
    } else {
        sectionStart += LAYOUT.sectionGap;
    }

    // MAX SIZE slider
    ui.maxSizeLabelY = sectionStart;
    ui.maxSizeSlider = {
        x: pad, y: sectionStart + LAYOUT.labelH + 14, w: tw - pad * 2, h: sH,
        trackY: sectionStart + LAYOUT.labelH + 14 + 14, trackH: LAYOUT.sliderH,
        min: 256, max: 4096, step: 128, value: p.maxSize, dragging: false
    };

    // BRUSH SIZE slider
    const sy = sectionStart + LAYOUT.labelH + 14 + sH + LAYOUT.sectionGap;
    ui.sizeLabelY = sy;
    ui.sizeSlider = {
        x: pad, y: sy, w: tw - pad * 2, h: sH,
        trackY: sy + 14, trackH: LAYOUT.sliderH,
        min: 1, max: 100, value: p.brushSize, dragging: false
    };

    // COLOR section
    const cy = sy + sH + LAYOUT.sectionGap;
    ui.colorSectionY = cy;
    ui.colorPreview = { x: pad, y: cy + LAYOUT.labelH + 2, w: 28, h: 28 };
    ui.hexInput = { x: pad + 36, y: cy + LAYOUT.labelH + 2, w: tw - pad * 2 - 36, h: 28 };

    const cpY = cy + LAYOUT.labelH + 2 + 28 + 8;
    const cols = 5, rows = 2;
    const cs = LAYOUT.colorSize, cg = LAYOUT.colorGap;
    const gw = cols * cs + (cols - 1) * cg;
    const cpX = pad + (tw - pad * 2 - gw) / 2;
    ui.colorPalette = { x: cpX, y: cpY, cols, rows, size: cs, gap: cg };

    // OPACITY slider (below color palette)
    const alphaY = cpY + rows * cs + (rows - 1) * cg + 8;
    ui.alphaLabelY = alphaY;
    ui.alphaSlider = {
        x: pad, y: alphaY + LAYOUT.labelH + 14, w: tw - pad * 2, h: sH,
        trackY: alphaY + LAYOUT.labelH + 14 + 14, trackH: LAYOUT.sliderH,
        min: 0, max: 100, value: p.brushAlpha, dragging: false
    };

    // ACTIONS section
    const ay = alphaY + LAYOUT.labelH + 14 + sH + LAYOUT.sectionGap;
    ui.actionsLabelY = ay;
    const actBtnW = (tw - pad * 2 - 8) / 2;
    ui.undoBtn = { x: pad, y: ay + LAYOUT.labelH + 2, w: actBtnW, h: 32, type: "undo", label: "↩ 撤销" };
    ui.clearBtn = { x: pad + actBtnW + 8, y: ay + LAYOUT.labelH + 2, w: actBtnW, h: 32, type: "clear", label: "🗑 清除" };

    // VIEW section
    const vy = ay + LAYOUT.labelH + 2 + 32 + LAYOUT.sectionGap;
    ui.viewLabelY = vy;
    const zy = vy + LAYOUT.labelH + 2;
    const zBtnW = (tw - pad * 2 - 16) / 3;
    ui.zoomBtns = [
        { x: pad, y: zy, w: zBtnW, h: 30, type: "zoomOut", label: "−" },
        { x: pad + zBtnW + 8, y: zy, w: zBtnW, h: 30, type: "fit", label: "适配", isPercent: true },
        { x: pad + zBtnW * 2 + 16, y: zy, w: zBtnW, h: 30, type: "zoomIn", label: "+" }
    ];

    ui.fitBtn = { x: pad, y: zy + 30 + 8, w: tw - pad * 2, h: 32, type: "fitWindow", label: "🎯 适配窗口" };

    updateLayout(node);
}

function setupWidgets(node) {
    ensureProjectWidget(node);
    // 彻底隐藏所有默认 widget，不让它们显示或占用空间
    if (!node.widgets) return;
    for (const w of node.widgets) {
        w.hidden = true;
        w.computedHeight = 0;
        w.last_y = -9999;  // 让 LiteGraph 把 widget 画在可视区域外
        if (w.element) w.element.style.display = "none";
        // 覆盖绘制方法为无操作
        w._origDraw = w.draw;
        w.draw = function() {};
    }
    // 阻止 ComfyUI 的 widget 布局系统
    node.widgets_start_y = -9999;
}

// 根据 maxSize 计算画布工作尺寸（最长边不超过 maxSize，保持宽高比）
// 使用 Math.floor 与 Python 端 int() 行为一致，避免尺寸不匹配
function getCanvasSize(origW, origH, maxSize) {
    const maxDim = Math.max(origW, origH);
    if (maxDim <= maxSize) return { w: origW, h: origH };
    const s = maxSize / maxDim;
    return {
        w: Math.floor(origW * s),
        h: Math.floor(origH * s)
    };
}

function setDisplayImageFromSource(node, sourceImg, width, height) {
    const nd = getNodeData(node);
    if (!sourceImg || !width || !height) return;
    const displayCanvas = document.createElement("canvas");
    displayCanvas.width = width;
    displayCanvas.height = height;
    const dctx = displayCanvas.getContext("2d");
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = "medium";
    dctx.drawImage(sourceImg, 0, 0, width, height);
    const displayImg = new Image();
    displayImg.onload = () => {
        nd.bgImage = displayImg;
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    };
    displayImg.src = displayCanvas.toDataURL("image/png");
}

function loadImageToNode(node, base64OrUrl) {
    if (!base64OrUrl) return;
    let base64 = base64OrUrl;
    if (base64.includes(",")) base64 = base64.split(",")[1];
    base64 = base64.trim();
    if (!base64) return;

    const nd = getNodeData(node);
    const p = node.properties;
    getStore()[String(node.id)] = base64;
    nd.bgBase64 = base64;
    nd.editorBaseBase64 = base64;
    nd.editorCompositeBase64 = "";
    nd.editorCompositeRef = "";
    nd.editorCompositeMode = "";
    nd.editorCompositeWidth = 0;
    nd.editorCompositeHeight = 0;
    nd.externalPaintDirty = false;

    const img = new Image();
    img.onload = () => {
        // 保存原始尺寸（供 Python 端输出原图尺寸 painted_image/mask 使用）
        nd.origWidth = img.width;
        nd.origHeight = img.height;

        const maxSize = p.maxSize || 1024;
        const { w, h } = getCanvasSize(img.width, img.height, maxSize);
        const nextSignature = imageSignatureFromBase64(base64, w, h);
        const prevSignature = nd.inputSignature || p.opProjectInputSignature || "";
        if (prevSignature && prevSignature !== nextSignature) {
            clearProjectRecord(node);
            delete getStore()[node.id + "_paint"];
            delete getStore()[node.id + "_mask"];
            const pw = node.widgets?.find(widget => widget.name === WIDGET_NAMES.PAINT_DATA);
            const mw = node.widgets?.find(widget => widget.name === WIDGET_NAMES.MASK_DATA);
            if (pw) pw.value = "";
            if (mw) mw.value = "";
            p.brushPaths = [];
            p.currentPath = [];
            p.penPoints = [];
            p.penState = "idle";
        }
        nd.inputSignature = nextSignature;
        p.opProjectInputSignature = nextSignature;
        p.canvasWidth = w;
        p.canvasHeight = h;
        node._paintCanvas.width = w;
        node._paintCanvas.height = h;
        node._maskCanvas.width = w;
        node._maskCanvas.height = h;
        node._externalPaintCanvas = document.createElement("canvas");
        node._externalPaintCanvas.width = w;
        node._externalPaintCanvas.height = h;
        setDisplayImageFromSource(node, img, w, h);
        nd.maskDirty = false;
        nd.outputDirty = true;

        // 遮罩初始全黑
        const mctx = node._maskCanvas.getContext("2d");
        mctx.fillStyle = "#000000";
        mctx.fillRect(0, 0, w, h);

        // 在当前默认节点尺寸内计算 fit scale，然后微调节点
        updateLayout(node);
        ensureNodeFits(node);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    };
    img.onerror = () => console.error("[CanvasPaint] Failed to load image");
    img.src = base64OrUrl.includes("data:") ? base64OrUrl : "data:image/png;base64," + base64;
}

function resolveLink(node, slot) {
    const linkInfo = node.getInputLink(slot);
    if (!linkInfo) return null;
    // LiteGraph 不同版本 getInputLink 可能返回 link ID(number) 或 link object
    if (typeof linkInfo === 'number') {
        return app.graph.links[linkInfo] || null;
    }
    if (typeof linkInfo === 'object' && linkInfo !== null) {
        return linkInfo;
    }
    return null;
}

function autoLoadConnectedImage(node) {
    if (!app.graph) {
        console.log("[CanvasPaint] autoLoad: app.graph not ready");
        return;
    }
    const link = resolveLink(node, 0);
    if (!link) {
        console.log("[CanvasPaint] autoLoad: no input link on slot 0");
        return;
    }
    const srcNode = app.graph.getNodeById(link.origin_id);
    if (!srcNode) {
        console.log("[CanvasPaint] autoLoad: source node not found, origin_id=" + link.origin_id);
        return;
    }

    console.log("[CanvasPaint] autoLoad: srcNode.type=" + srcNode.type + ", widgets=" + (srcNode.widgets?.map(w => w.name).join(",") || "none"));

    // 支持多种 LoadImage 变体
    const isLoadImage = srcNode.type === "LoadImage" ||
                        srcNode.type === "LoadImage //Browser" ||
                        srcNode.type === "LoadImageMask" ||
                        srcNode.type?.includes("LoadImage") ||
                        srcNode.type?.includes("load_image");

    if (!isLoadImage) {
        console.log("[CanvasPaint] autoLoad: source is not a LoadImage type");
        return;
    }

    // 获取图片文件名 - 不同版本的 ComfyUI 可能用不同 widget 名
    let imgWidget = srcNode.widgets?.find(w => w.name === "image");
    if (!imgWidget) {
        imgWidget = srcNode.widgets?.[0]; // 回退到第一个 widget
    }

    if (!imgWidget?.value) {
        console.log("[CanvasPaint] autoLoad: no image value found");
        return;
    }

    const filename = imgWidget.value;
    console.log("[CanvasPaint] autoLoad: filename=" + filename);

    // 如果 filename 本身就是 dataURL，直接使用
    if (typeof filename === "string" && filename.startsWith("data:")) {
        loadImageToNode(node, filename);
        return;
    }

    // 构建 ComfyUI view URL
    const subfolder = imgWidget.options?.subfolder || "";
    const type = imgWidget.options?.type || "input";
    let url = `/view?filename=${encodeURIComponent(filename)}&type=${type}`;
    if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;

    console.log("[CanvasPaint] autoLoad: fetching " + url);

    fetch(url)
        .then(r => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.blob();
        })
        .then(blob => {
            const reader = new FileReader();
            reader.onload = e => {
                console.log("[CanvasPaint] autoLoad: image loaded successfully");
                loadImageToNode(node, e.target.result);
            };
            reader.readAsDataURL(blob);
        })
        .catch(e => {
            console.error("[CanvasPaint] Auto-load failed:", e);
            // 回退：尝试使用 ComfyUI 的 api.viewURL
            tryLoadViaApi(node, filename, type, subfolder);
        });
}

function tryLoadViaApi(node, filename, type, subfolder) {
    // 尝试从 ComfyUI 的 input 目录加载
    let url = `/view?filename=${encodeURIComponent(filename)}&type=${type}`;
    if (subfolder) url += `&subfolder=${encodeURIComponent(subfolder)}`;

    console.log("[CanvasPaint] autoLoad: fallback fetching " + url);

    fetch(url)
        .then(r => {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.blob();
        })
        .then(blob => {
            const reader = new FileReader();
            reader.onload = e => loadImageToNode(node, e.target.result);
            reader.readAsDataURL(blob);
        })
        .catch(e2 => console.error("[CanvasPaint] Fallback load also failed:", e2));
}

// ============ 绘画与数据同步 ============
function strokeSmoothPath(ctx, points, mapPoint) {
    if (!ctx || !points || points.length < 2) return;
    const toPoint = mapPoint || (pt => pt);
    const first = toPoint(points[0]);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    if (points.length === 2) {
        const last = toPoint(points[1]);
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        return;
    }
    for (let i = 1; i < points.length - 1; i++) {
        const current = toPoint(points[i]);
        const next = toPoint(points[i + 1]);
        ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    const last = toPoint(points[points.length - 1]);
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
}

function commitStroke(node) {
    const p = node.properties;
    if (p.currentPath.length < 2) {
        p.currentPath = [];
        return;
    }

    // 保存撤销快照到独立存储（不在 properties 中）
    const nd = getNodeData(node);
    if (nd.undoStack.length >= p.maxUndo) nd.undoStack.shift();
    nd.undoStack.push(node._paintCanvas.toDataURL("image/png"));

    // 绘制到离屏 canvas
    const ctx = node._paintCanvas.getContext("2d");
    const mctx = node._maskCanvas.getContext("2d");
    const extCanvas = ensureExternalPaintCanvas(node);
    const ectx = extCanvas?.getContext("2d");
    const writesPaint = true;

    if (writesPaint) ctx.save();
    mctx.save();
    if (writesPaint) ectx?.save();

    if (p.tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
        mctx.globalCompositeOperation = "destination-out";
        mctx.strokeStyle = "rgba(255,255,255,1)";
        if (ectx) {
            ectx.globalCompositeOperation = "destination-out";
            ectx.strokeStyle = "rgba(0,0,0,1)";
        }
    } else {
        const alphaVal = (p.brushAlpha || 100) / 100;
        if (writesPaint) {
            ctx.globalCompositeOperation = "source-over";
            ctx.strokeStyle = hexToRgba(p.brushColor, alphaVal);
        }
        mctx.globalCompositeOperation = "source-over";
        mctx.strokeStyle = hexToRgba("#FFFFFF", alphaVal);
        if (writesPaint && ectx) {
            ectx.globalCompositeOperation = "source-over";
            ectx.strokeStyle = hexToRgba(p.brushColor, alphaVal);
        }
    }

    if (writesPaint) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = p.brushSize;
    }
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.lineWidth = p.brushSize;
    if (writesPaint && ectx) {
        ectx.lineCap = "round";
        ectx.lineJoin = "round";
        ectx.lineWidth = p.brushSize;
    }

    if (writesPaint) strokeSmoothPath(ctx, p.currentPath);
    strokeSmoothPath(mctx, p.currentPath);
    if (writesPaint) strokeSmoothPath(ectx, p.currentPath);

    if (writesPaint) ctx.restore();
    mctx.restore();
    if (writesPaint) ectx?.restore();
    if (writesPaint) nd.externalPaintDirty = true;
    nd.maskDirty = true;
    nd.outputDirty = true;

    // 保存到历史
    p.brushPaths.push({
        tool: p.tool,
        size: p.brushSize,
        color: p.brushColor,
        alpha: p.brushAlpha,
        points: [...p.currentPath]
    });

    p.currentPath = [];

    // 同步到隐藏 widget
    syncToWidgets(node);
}

function commitPenFill(node) {
    const p = node.properties;
    if (!p.penPoints || p.penPoints.length < 3) {
        p.penPoints = [];
        p.penState = "idle";
        return;
    }

    // 保存撤销快照
    const nd = getNodeData(node);
    if (nd.undoStack.length >= p.maxUndo) nd.undoStack.shift();
    nd.undoStack.push(node._paintCanvas.toDataURL("image/png"));

    const ctx = node._paintCanvas.getContext("2d");
    const mctx = node._maskCanvas.getContext("2d");
    const extCanvas = ensureExternalPaintCanvas(node);
    const ectx = extCanvas?.getContext("2d");
    const rgb = parseRgb(p.brushColor);
    const alphaVal = (p.brushAlpha || 100) / 100;
    const points = p.penPoints;
    const writesPenPaint = true;

    // 填充绘画层（带透明度）
    if (writesPenPaint) {
        ctx.save();
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alphaVal})`;
        ctx.globalCompositeOperation = "source-over";
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        if (ectx) {
            ectx.save();
            ectx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alphaVal})`;
            ectx.globalCompositeOperation = "source-over";
            ectx.beginPath();
            ectx.moveTo(points[0].x, points[0].y);
            for (let i = 1; i < points.length; i++) {
                ectx.lineTo(points[i].x, points[i].y);
            }
            ectx.closePath();
            ectx.fill();
            ectx.restore();
        }
    }

    // 填充遮罩层（白色 = 已绘制区域，根据透明度调整 alpha）
    mctx.save();
    mctx.fillStyle = `rgba(255,255,255,${alphaVal})`;
    mctx.globalCompositeOperation = "source-over";
    mctx.beginPath();
    mctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        mctx.lineTo(points[i].x, points[i].y);
    }
    mctx.closePath();
    mctx.fill();
    mctx.restore();

    // 保存到历史
    p.brushPaths.push({
        tool: "pen",
        color: p.brushColor,
        alpha: p.brushAlpha,
        points: [...points]
    });

    p.penPoints = [];
    p.penState = "idle";
    if (writesPenPaint) nd.externalPaintDirty = true;
    nd.maskDirty = true;
    nd.outputDirty = true;

    syncToWidgets(node);
}

function syncToWidgets(node) {
    try {
        let paintData = "";
        const nd = getNodeData(node);
        const externalCanvas = ensureExternalPaintCanvas(node);
        const visiblePaintCanvas = node._paintCanvas;
        const hasEditorComposite = !!nd.editorCompositeBase64;
        const workW = node._paintCanvas?.width || 0;
        const workH = node._paintCanvas?.height || 0;
        const cacheKey = [
            hasEditorComposite ? "editor" : "paint",
            nd.editorCompositeMode || "",
            nd.editorCompositeWidth || 0,
            nd.editorCompositeHeight || 0,
            workW,
            workH,
            nd.externalPaintDirty ? 1 : 0,
            nd.maskDirty ? 1 : 0,
        ].join("|");
        const store = getStore();
        if (!nd.outputDirty && nd.outputCacheKey === cacheKey && store[node.id + "_paint"] !== undefined && store[node.id + "_mask"] !== undefined) {
            const pw = node.widgets?.find(w => w.name === WIDGET_NAMES.PAINT_DATA);
            const mw = node.widgets?.find(w => w.name === WIDGET_NAMES.MASK_DATA);
            if (pw) pw.value = PAINT_TOKEN + node.id;
            if (mw) mw.value = MASK_TOKEN + node.id;
            return;
        }
        if (hasEditorComposite) {
            const editorBasePayload = nd.editorCompositeRef || nd.editorCompositeBase64;
            if (!nd.externalPaintDirty) {
                paintData = editorBasePayload;
            } else {
                const overlayData = visiblePaintCanvas ? visiblePaintCanvas.toDataURL("image/png").split(",")[1] : "";
                paintData = overlayData
                    ? `${editorBasePayload}${WORK_PAINT_TOKEN}${workW}x${workH}:${overlayData}`
                    : editorBasePayload;
            }
            paintData = `${EDITOR_PAINT_PREFIX}${nd.editorCompositeMode || "same"}:${paintData}`;
        } else if (visiblePaintCanvas) {
            const hasPaintPixels = canvasHasAlphaPixels(visiblePaintCanvas);
            if (hasPaintPixels) {
                paintData = visiblePaintCanvas.toDataURL("image/png").split(",")[1];
            }
        }
        let maskData = "";
        if (nd.maskDirty) {
            maskData = node._maskCanvas.toDataURL("image/png").split(",")[1];
        }
        store[node.id + "_paint"] = paintData;
        store[node.id + "_mask"] = maskData;
        nd.outputDirty = false;
        nd.outputCacheKey = cacheKey;

        const pw = node.widgets?.find(w => w.name === WIDGET_NAMES.PAINT_DATA);
        const mw = node.widgets?.find(w => w.name === WIDGET_NAMES.MASK_DATA);
        if (pw) pw.value = PAINT_TOKEN + node.id;
        if (mw) mw.value = MASK_TOKEN + node.id;
    } catch (e) {
        console.error("[CanvasPaint] sync error:", e);
    }
}

async function persistEditorProject(node, project, width, height) {
    if (!node || !project) return;
    const nd = getNodeData(node);
    const p = node.properties || initProperties(node);
    const inputSignature = nd.inputSignature || p.opProjectInputSignature || project.inputSignature || "";
    const projectRecord = {
        version: 1,
        inputSignature,
        width: width || project.width || p.canvasWidth,
        height: height || project.height || p.canvasHeight,
        project: {
            ...project,
            inputSignature,
            width: width || project.width || p.canvasWidth,
            height: height || project.height || p.canvasHeight,
        },
        updatedAt: Date.now(),
    };
    const key = projectStoreKey(node);
    nd.opProject = projectRecord.project;
    nd.opProjectInputSignature = inputSignature;
    p.opProjectInputSignature = inputSignature;
    setProjectWidgetRef(node, key);
    await writeProjectRecord(key, projectRecord);
}

async function applyEditorResultToNode(node, imageBase64, maskBase64, width, height, project = null, imageBlob = null, maskBlob = null) {
    if (!node || !imageBase64) return;
    const p = node.properties || initProperties(node);
    const nd = getNodeData(node);
    const prevCanvasWidth = p.canvasWidth;
    const prevCanvasHeight = p.canvasHeight;
    const preservedMask = document.createElement("canvas");
    if (node._maskCanvas?.width && node._maskCanvas?.height) {
        preservedMask.width = node._maskCanvas.width;
        preservedMask.height = node._maskCanvas.height;
        preservedMask.getContext("2d").drawImage(node._maskCanvas, 0, 0);
    }
    const preservedExternal = document.createElement("canvas");
    const hadExternalPaint = !!nd.externalPaintDirty;
    if (node._externalPaintCanvas?.width && node._externalPaintCanvas?.height) {
        preservedExternal.width = node._externalPaintCanvas.width;
        preservedExternal.height = node._externalPaintCanvas.height;
        preservedExternal.getContext("2d").drawImage(node._externalPaintCanvas, 0, 0);
    }
    const editorW = width || nd.origWidth || p.canvasWidth;
    const editorH = height || nd.origHeight || p.canvasHeight;
    const workSize = getCanvasSize(editorW, editorH, p.maxSize || 1024);
    p.canvasWidth = workSize.w;
    p.canvasHeight = workSize.h;
    if (!node._paintCanvas) node._paintCanvas = document.createElement("canvas");
    if (!node._maskCanvas) node._maskCanvas = document.createElement("canvas");
    if (!node._externalPaintCanvas) node._externalPaintCanvas = document.createElement("canvas");
    node._paintCanvas.width = p.canvasWidth;
    node._paintCanvas.height = p.canvasHeight;
    node._maskCanvas.width = p.canvasWidth;
    node._maskCanvas.height = p.canvasHeight;
    node._externalPaintCanvas.width = p.canvasWidth;
    node._externalPaintCanvas.height = p.canvasHeight;

    return await new Promise(resolve => {
        const editedImg = new Image();
        const finish = async () => {
            const pctx = node._paintCanvas.getContext("2d");
            const ectx = node._externalPaintCanvas.getContext("2d");
            const mctx = node._maskCanvas.getContext("2d");
            pctx.clearRect(0, 0, node._paintCanvas.width, node._paintCanvas.height);
            ectx.clearRect(0, 0, node._externalPaintCanvas.width, node._externalPaintCanvas.height);
            fillMaskBlack(node._maskCanvas);
            if (preservedExternal.width && preservedExternal.height) {
                pctx.drawImage(preservedExternal, 0, 0, node._paintCanvas.width, node._paintCanvas.height);
                ectx.drawImage(preservedExternal, 0, 0, node._externalPaintCanvas.width, node._externalPaintCanvas.height);
            }
            if (maskBase64) {
                await new Promise(maskDone => {
                    const editorMask = new Image();
                    editorMask.onload = () => {
                        mctx.drawImage(editorMask, 0, 0, node._maskCanvas.width, node._maskCanvas.height);
                        maskDone();
                    };
                    editorMask.onerror = () => maskDone();
                    editorMask.src = "data:image/png;base64," + maskBase64;
                });
            }

            setDisplayImageFromSource(node, editedImg, p.canvasWidth, p.canvasHeight);
            nd.bgBase64 = imageBase64;
            nd.editorCompositeBase64 = imageBase64;
            nd.editorCompositeRef = "";
            nd.editorCompositeWidth = editorW;
            nd.editorCompositeHeight = editorH;
            getStore()[String(node.id)] = imageBase64;
            const baseW = nd.origWidth || prevCanvasWidth;
            const baseH = nd.origHeight || prevCanvasHeight;
            const editorCanvasMode = (width && height && baseW && baseH && (width !== baseW || height !== baseH)) ? "changed" : "same";
            nd.editorCompositeMode = editorCanvasMode;
            nd.externalPaintDirty = hadExternalPaint && preservedExternal.width > 0 && preservedExternal.height > 0;
            nd.maskDirty = !!maskBase64;
            nd.outputDirty = true;
            syncToWidgets(node);
            await warmPromptBlobUpload(node, imageBase64, imageBlob, "canvas_paint_editor");
            await persistEditorProject(node, project, editorW, editorH);
            if (editorCanvasMode === "changed") p.brushPaths = [];
            p.currentPath = [];
            p.penPoints = [];
            p.penState = "idle";
            updateLayout(node);
            ensureNodeFits(node);
            if (app.graph) app.graph.setDirtyCanvas(true, true);
            resolve();
        };
        editedImg.onload = finish;
        editedImg.onerror = () => resolve();
        editedImg.src = "data:image/png;base64," + imageBase64;
    });
}

function undo(node) {
    const p = node.properties;
    // 如果正在钢笔绘制，清除当前路径
    if (p.tool === "pen" && p.penPoints && p.penPoints.length > 0) {
        p.penPoints = [];
        p.penState = "idle";
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return;
    }
    const nd = getNodeData(node);
    if (nd.undoStack.length === 0) return;
    const snap = nd.undoStack.pop();
    const img = new Image();
    img.onload = () => {
        const ctx = node._paintCanvas.getContext("2d");
        const mctx = node._maskCanvas.getContext("2d");
        const externalCanvas = ensureExternalPaintCanvas(node);
        const ectx = externalCanvas?.getContext("2d");
        ctx.clearRect(0, 0, node._paintCanvas.width, node._paintCanvas.height);
        ectx?.clearRect(0, 0, externalCanvas.width, externalCanvas.height);
        mctx.clearRect(0, 0, node._maskCanvas.width, node._maskCanvas.height);
        ctx.drawImage(img, 0, 0);
        ectx?.drawImage(img, 0, 0, externalCanvas.width, externalCanvas.height);
        nd.externalPaintDirty = canvasHasAlphaPixels(node._paintCanvas);
        // 遮罩不能从快照恢复（因为是单色），这里简单处理：清除后重绘所有路径的遮罩
        mctx.fillStyle = "#000000";
        mctx.fillRect(0, 0, node._maskCanvas.width, node._maskCanvas.height);
        for (const path of p.brushPaths.slice(0, nd.undoStack.length)) {
            drawPathToMask(mctx, path);
        }
        nd.maskDirty = p.brushPaths.slice(0, nd.undoStack.length).length > 0;
        nd.outputDirty = true;
        syncToWidgets(node);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
    };
    img.src = snap;
}

function clearCanvas(node) {
    const p = node.properties;
    const nd = getNodeData(node);
    // 清除当前钢笔路径
    p.penPoints = [];
    p.penState = "idle";
    const ctx = node._paintCanvas.getContext("2d");
    const mctx = node._maskCanvas.getContext("2d");
    ctx.clearRect(0, 0, node._paintCanvas.width, node._paintCanvas.height);
    mctx.fillStyle = "#000000";
    mctx.fillRect(0, 0, node._maskCanvas.width, node._maskCanvas.height);
    clearExternalPaintCanvas(node);
    p.brushPaths = [];
    nd.undoStack = [];
    nd.maskDirty = false;
    nd.outputDirty = true;
    syncToWidgets(node);
    if (app.graph) app.graph.setDirtyCanvas(true, true);
}

function drawPathToMask(mctx, pathObj) {
    if (pathObj.points.length < 2) return;
    if (pathObj.tool === "pen") {
        const pathAlpha = (pathObj.alpha || 100) / 100;
        mctx.save();
        mctx.globalCompositeOperation = "source-over";
        mctx.fillStyle = `rgba(255,255,255,${pathAlpha})`;
        mctx.beginPath();
        mctx.moveTo(pathObj.points[0].x, pathObj.points[0].y);
        for (let i = 1; i < pathObj.points.length; i++) {
            const pt = pathObj.points[i];
            mctx.lineTo(pt.x, pt.y);
        }
        mctx.closePath();
        mctx.fill();
        mctx.restore();
        return;
    }
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.lineWidth = pathObj.size;
    if (pathObj.tool === "eraser") {
        mctx.globalCompositeOperation = "destination-out";
        mctx.strokeStyle = "rgba(255,255,255,1)";
    } else {
        mctx.globalCompositeOperation = "source-over";
        const pathAlpha = (pathObj.alpha || 100) / 100;
        mctx.strokeStyle = `rgba(255,255,255,${pathAlpha})`;
    }
    strokeSmoothPath(mctx, pathObj.points);
    mctx.globalCompositeOperation = "source-over";
}

// ============ 渲染 ============
function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawSectionLabel(ctx, label, x, y) {
    ctx.fillStyle = UI_COLORS.sectionLabel;
    ctx.font = "bold 10px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(label, x, y);
}

function drawModeButton(ctx, btn) {
    const r = 6;
    if (btn.active) {
        // Active: blue background with glow
        ctx.fillStyle = UI_COLORS.btnActiveBg;
        roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
        ctx.fill();
        ctx.strokeStyle = UI_COLORS.btnActiveBorder;
        ctx.lineWidth = 1.5;
        roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
        ctx.stroke();
        // Subtle inner glow - isolated with save/restore to prevent leaking
        ctx.save();
        ctx.shadowColor = UI_COLORS.btnActiveGlow;
        ctx.shadowBlur = 8;
        roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = UI_COLORS.textBright;
    } else {
        ctx.fillStyle = UI_COLORS.btnBg;
        roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
        ctx.fill();
        ctx.strokeStyle = UI_COLORS.btnBorder;
        ctx.lineWidth = 1;
        roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
        ctx.stroke();
        ctx.fillStyle = UI_COLORS.textDim;
    }
    ctx.font = `11px Arial`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2);
}

function drawActionButton(ctx, btn, accentColor) {
    const r = 6;
    ctx.fillStyle = UI_COLORS.btnBg;
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
    ctx.fill();
    // Left accent border
    ctx.fillStyle = accentColor;
    ctx.fillRect(btn.x, btn.y + 4, 3, btn.h - 8);
    ctx.strokeStyle = UI_COLORS.btnBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
    ctx.stroke();
    ctx.fillStyle = UI_COLORS.textMain;
    ctx.font = "11px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(btn.label, btn.x + btn.w / 2, btn.y + btn.h / 2);
}

function drawZoomButton(ctx, btn) {
    const r = 6;
    ctx.fillStyle = UI_COLORS.btnBg;
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.btnBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, btn.x, btn.y, btn.w, btn.h, r);
    ctx.stroke();
    ctx.fillStyle = UI_COLORS.textMain;
    ctx.font = btn.isPercent ? "10px Arial" : "14px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = btn.isPercent ? `${Math.round(ctx._paintScale * 100)}%` : btn.label;
    ctx.fillText(text, btn.x + btn.w / 2, btn.y + btn.h / 2);
}

function drawSlider(ctx, slider, value, maxLabel) {
    const trackY = slider.trackY;
    // Track background
    ctx.fillStyle = UI_COLORS.sliderTrack;
    roundRectPath(ctx, slider.x, trackY, slider.w, slider.trackH, slider.trackH / 2);
    ctx.fill();
    // Fill
    const prog = (value - slider.min) / (slider.max - slider.min);
    ctx.fillStyle = UI_COLORS.sliderFill;
    roundRectPath(ctx, slider.x, trackY, slider.w * prog, slider.trackH, slider.trackH / 2);
    ctx.fill();
    // Thumb
    const thumbX = slider.x + slider.w * prog;
    ctx.fillStyle = UI_COLORS.sliderThumb;
    ctx.beginPath();
    ctx.arc(thumbX, trackY + slider.trackH / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    // Thumb border
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(thumbX, trackY + slider.trackH / 2, 7, 0, Math.PI * 2);
    ctx.stroke();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const chars = String(text || "").split("");
    let line = "";
    let lines = 0;
    for (const ch of chars) {
        const testLine = line + ch;
        if (ctx.measureText(testLine).width > maxWidth && line) {
            ctx.fillText(line, x, y + lines * lineHeight);
            line = ch;
            lines += 1;
            if (lines >= maxLines) return;
        } else {
            line = testLine;
        }
    }
    if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
}

function drawToolbar(ctx, node) {
    const p = node.properties;
    const ui = p.ui;
    const tw = LAYOUT.toolWidth;
    const to = ui.cardTop || LAYOUT.topOffset;

    // Reset all drawing state to prevent ghosting from previous frames/nodes
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([]);

    // 工具面板卡片（带圆角和边框，与画布面板风格统一）
    const cardX = 0;
    const cardY = to;
    const cardW = tw;
    const cardH = node.size[1] - cardY;

    ctx.fillStyle = UI_COLORS.sidebarBg;
    roundRectPath(ctx, cardX, cardY, cardW, cardH, LAYOUT.panelRadius);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.panelBorder;
    ctx.lineWidth = LAYOUT.panelBorderW;
    roundRectPath(ctx, cardX, cardY, cardW, cardH, LAYOUT.panelRadius);
    ctx.stroke();

    // Header: 🖌 Tools — 在卡片内顶部绘制，与端口标签行有明确分隔
    ctx.fillStyle = UI_COLORS.textMain;
    ctx.font = "bold 13px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("图片编辑", LAYOUT.padding, ui.titleY || to + LAYOUT.headerPadTop);

    // 标题下方分隔线
    const sepY = (ui.titleY || to + LAYOUT.headerPadTop) + LAYOUT.titleH + 1;
    ctx.strokeStyle = hexToRgba(UI_COLORS.panelBorder, 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LAYOUT.padding, sepY);
    ctx.lineTo(tw - LAYOUT.padding, sepY);
    ctx.stroke();

    const editorBtn = ui.editorBtn;
    const hasImage = !!getNodeImageData(node);
    ctx.fillStyle = hasImage ? UI_COLORS.fitBg : "#2a2a35";
    roundRectPath(ctx, editorBtn.x, editorBtn.y, editorBtn.w, editorBtn.h, 8);
    ctx.fill();
    ctx.strokeStyle = hasImage ? UI_COLORS.btnActiveBorder : UI_COLORS.btnBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, editorBtn.x, editorBtn.y, editorBtn.w, editorBtn.h, 8);
    ctx.stroke();
    ctx.fillStyle = hasImage ? UI_COLORS.textBright : UI_COLORS.textDim;
    ctx.font = "bold 13px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("图片编辑", editorBtn.x + editorBtn.w / 2, editorBtn.y + editorBtn.h / 2);

    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = "10px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const hint = hasImage ? "打开 OkayPixels 全屏编辑器" : "请先连接或加载图片";
    wrapText(ctx, hint, LAYOUT.padding, ui.editorHintY, tw - LAYOUT.padding * 2, 15, 3);

    // === TOOL ===
    drawSectionLabel(ctx, "工具", LAYOUT.padding, ui.toolMenuLabelY);
    const tmb = ui.toolMenuBtn;
    // Dropdown button background
    ctx.fillStyle = UI_COLORS.btnBg;
    roundRectPath(ctx, tmb.x, tmb.y, tmb.w, tmb.h, 6);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.btnBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, tmb.x, tmb.y, tmb.w, tmb.h, 6);
    ctx.stroke();
    // Label
    ctx.fillStyle = UI_COLORS.textMain;
    ctx.font = "12px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(getToolLabel(p.tool), tmb.x + 10, tmb.y + tmb.h / 2);
    // Dropdown arrow
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = "10px Arial";
    ctx.textAlign = "right";
    ctx.fillText(tmb.open ? "▲" : "▼", tmb.x + tmb.w - 10, tmb.y + tmb.h / 2);

    // Dropdown menu items
    if (tmb.open && ui.toolMenuItems.length > 0) {
        const first = ui.toolMenuItems[0];
        const last = ui.toolMenuItems[ui.toolMenuItems.length - 1];
        ctx.fillStyle = "#252530";
        roundRectPath(ctx, first.x - 2, first.y - 2, first.w + 4, (last.y + last.h) - first.y + 4, 6);
        ctx.fill();
        ctx.strokeStyle = UI_COLORS.btnBorder;
        ctx.lineWidth = 1;
        roundRectPath(ctx, first.x - 2, first.y - 2, first.w + 4, (last.y + last.h) - first.y + 4, 6);
        ctx.stroke();
        for (const item of ui.toolMenuItems) {
            const isActive = p.tool === item.type;
            if (isActive) {
                ctx.fillStyle = UI_COLORS.btnActiveBg;
                roundRectPath(ctx, item.x, item.y, item.w, item.h, 4);
                ctx.fill();
                ctx.fillStyle = UI_COLORS.textBright;
            } else {
                ctx.fillStyle = UI_COLORS.textDim;
            }
            ctx.font = "11px Arial";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(item.label, item.x + 10, item.y + item.h / 2);
        }
    }

    // === MAX SIZE ===
    drawSectionLabel(ctx, "最大尺寸", LAYOUT.padding, ui.maxSizeLabelY);
    const msy = ui.maxSizeSlider.y;
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = "10px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("限制", LAYOUT.padding, msy - 14);
    ctx.textAlign = "right";
    ctx.fillText(`${p.maxSize}px`, tw - LAYOUT.padding, msy - 14);
    drawSlider(ctx, ui.maxSizeSlider, p.maxSize);

    // === BRUSH SIZE ===
    drawSectionLabel(ctx, "画笔大小", LAYOUT.padding, ui.sizeLabelY);
    const sy = ui.sizeSlider.y;
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = "10px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("大小", LAYOUT.padding, sy - 14);
    ctx.textAlign = "right";
    ctx.fillText(`${p.brushSize}px`, tw - LAYOUT.padding, sy - 14);
    drawSlider(ctx, ui.sizeSlider, p.brushSize);

    // === COLOR ===
    drawSectionLabel(ctx, "颜色", LAYOUT.padding, ui.colorSectionY);
    // Color preview square (with checkerboard for transparency)
    const cp = ui.colorPreview;
    const cpBgSize = 6;
    for (let bx = 0; bx < cp.w; bx += cpBgSize) {
        for (let by = 0; by < cp.h; by += cpBgSize) {
            ctx.fillStyle = (Math.floor(bx / cpBgSize) + Math.floor(by / cpBgSize)) % 2 === 0 ? "#555" : "#888";
            ctx.fillRect(cp.x + bx, cp.y + by, cpBgSize, cpBgSize);
        }
    }
    // Color overlay
    const alphaVal = (p.brushAlpha || 100) / 100;
    ctx.fillStyle = hexToRgba(p.brushColor, alphaVal);
    roundRectPath(ctx, cp.x, cp.y, cp.w, cp.h, 4);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.btnBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, cp.x, cp.y, cp.w, cp.h, 4);
    ctx.stroke();
    // Hex input box
    const hex = ui.hexInput;
    ctx.fillStyle = UI_COLORS.hexBg;
    roundRectPath(ctx, hex.x, hex.y, hex.w, hex.h, 4);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.hexBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, hex.x, hex.y, hex.w, hex.h, 4);
    ctx.stroke();
    ctx.fillStyle = UI_COLORS.textMain;
    ctx.font = "11px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const alphaSuffix = p.brushAlpha < 100 ? ` ${p.brushAlpha}%` : "";
    ctx.fillText(p.brushColor.toUpperCase() + alphaSuffix, hex.x + 8, hex.y + hex.h / 2);

    // Color palette
    const pal = ui.colorPalette;
    for (let i = 0; i < COLORS.length; i++) {
        const col = i % pal.cols;
        const row = Math.floor(i / pal.cols);
        const x = pal.x + col * (pal.size + pal.gap);
        const yp = pal.y + row * (pal.size + pal.gap);
        ctx.fillStyle = COLORS[i];
        roundRectPath(ctx, x, yp, pal.size, pal.size, 4);
        ctx.fill();
        if (COLORS[i].toUpperCase() === p.brushColor.toUpperCase()) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2.5;
            roundRectPath(ctx, x - 1, yp - 1, pal.size + 2, pal.size + 2, 5);
            ctx.stroke();
        }
    }

    // === OPACITY ===
    drawSectionLabel(ctx, "不透明度", LAYOUT.padding, ui.alphaLabelY);
    const ay = ui.alphaSlider.y;
    ctx.fillStyle = UI_COLORS.textDim;
    ctx.font = "10px Arial";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("Alpha", LAYOUT.padding, ay - 14);
    ctx.textAlign = "right";
    ctx.fillText(`${p.brushAlpha}%`, tw - LAYOUT.padding, ay - 14);
    drawSlider(ctx, ui.alphaSlider, p.brushAlpha);

    // === ACTIONS ===
    drawSectionLabel(ctx, "操作", LAYOUT.padding, ui.actionsLabelY);
    drawActionButton(ctx, ui.undoBtn, UI_COLORS.undoBorder);
    drawActionButton(ctx, ui.clearBtn, UI_COLORS.clearBorder);

    // === VIEW ===
    drawSectionLabel(ctx, "视图", LAYOUT.padding, ui.viewLabelY);
    // Pass scale to zoom button via context property
    ctx._paintScale = p.scale;
    for (const zb of ui.zoomBtns) {
        drawZoomButton(ctx, zb);
    }
    ctx._paintScale = undefined;

    // Fit to Window button
    const fb = ui.fitBtn;
    ctx.fillStyle = UI_COLORS.fitBg;
    roundRectPath(ctx, fb.x, fb.y, fb.w, fb.h, 6);
    ctx.fill();
    ctx.fillStyle = UI_COLORS.textBright;
    ctx.font = "11px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fb.label, fb.x + fb.w / 2, fb.y + fb.h / 2);
}

function drawLoadImageButton(ctx, x, y, w, h) {
    ctx.fillStyle = UI_COLORS.loadBtnBg;
    roundRectPath(ctx, x, y, w, h, 8);
    ctx.fill();
    // Inner highlight
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    roundRectPath(ctx, x + 1, y + 1, w - 2, h / 2 - 1, 7);
    ctx.fill();
    ctx.fillStyle = UI_COLORS.textBright;
    ctx.font = "bold 12px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("📁 Load Image", x + w / 2, y + h / 2);
}

function drawCanvasArea(ctx, node) {
    const p = node.properties;
    const cw = p.canvasWidth, ch = p.canvasHeight;
    const sw = cw * p.scale, sh = ch * p.scale;
    const ox = p.offsetX, oy = p.offsetY;

    // 画布面板卡片（右侧，与工具面板顶部对齐）
    const cardX = LAYOUT.toolWidth + LAYOUT.panelGap;
    const cardY = LAYOUT.topOffset;
    const cardW = node.size[0] - LAYOUT.toolWidth - LAYOUT.panelGap - LAYOUT.portWidth - LAYOUT.panelPad;
    const cardH = node.size[1] - LAYOUT.topOffset - LAYOUT.panelPad;

    // Reset drawing state to prevent ghosting
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([]);

    // 画布面板卡片背景 + 边框
    ctx.fillStyle = "#18181c";
    roundRectPath(ctx, cardX, cardY, cardW, cardH, LAYOUT.panelRadius);
    ctx.fill();
    ctx.strokeStyle = UI_COLORS.panelBorder;
    ctx.lineWidth = LAYOUT.panelBorderW;
    roundRectPath(ctx, cardX, cardY, cardW, cardH, LAYOUT.panelRadius);
    ctx.stroke();

    // 裁剪到画布面板内部（给面板边框留空间）
    ctx.save();
    roundRectPath(ctx, cardX + LAYOUT.panelBorderW, cardY + LAYOUT.panelBorderW,
                  cardW - LAYOUT.panelBorderW * 2, cardH - LAYOUT.panelBorderW * 2,
                  LAYOUT.panelRadius);
    ctx.clip();

    // 棋盘格背景（填满整个面板内部）
    const cs = 16;
    ctx.fillStyle = "#1e1e22";
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.fillStyle = "#26262a";
    for (let x = cardX; x < cardX + cardW; x += cs * 2) {
        for (let y = cardY; y < cardY + cardH; y += cs * 2) {
            ctx.fillRect(x, y, cs, cs);
            ctx.fillRect(x + cs, y + cs, cs, cs);
        }
    }

    // 画布图像边框（图片实际显示区域的外框）
    ctx.strokeStyle = "#44444a";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, sw + 1, sh + 1);

    // 裁剪到画布图像区域
    ctx.save();
    ctx.rect(ox, oy, sw, sh);
    ctx.clip();

    // 背景图
    const nd = getNodeData(node);
    if (nd.bgImage?.complete) {
        ctx.drawImage(nd.bgImage, ox, oy, sw, sh);
    } else {
        ctx.fillStyle = "#2a2a32";
        ctx.fillRect(ox, oy, sw, sh);
        ctx.fillStyle = "#55555a";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Load image or connect node", ox + sw / 2, oy + sh / 2);
    }

    // 绘画层
    if (node._paintCanvas) {
        ctx.drawImage(node._paintCanvas, ox, oy, sw, sh);
    }

    // 当前路径（画笔/橡皮擦）
    if (p.isDrawing && p.currentPath.length > 1) {
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = p.brushSize * p.scale;
        if (p.tool === "eraser") {
            ctx.strokeStyle = "rgba(255,50,50,0.5)";
        } else {
            const prevAlpha = (p.brushAlpha || 100) / 100;
            ctx.strokeStyle = hexToRgba(p.brushColor, prevAlpha);
        }
        strokeSmoothPath(ctx, p.currentPath, pt => ({
            x: ox + pt.x * p.scale,
            y: oy + pt.y * p.scale
        }));
    }

    // 钢笔路径预览（细线，像 PS）
    if (p.penPoints && p.penPoints.length > 0) {
        const prevAlpha = (p.brushAlpha || 100) / 100;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const contrastColor = getContrastColor(p.brushColor);
        ctx.lineWidth = 1;
        ctx.strokeStyle = hexToRgba(contrastColor, Math.max(0.6, prevAlpha));
        ctx.beginPath();
        for (let i = 0; i < p.penPoints.length; i++) {
            const pt = p.penPoints[i];
            const px = ox + pt.x * p.scale;
            const py = oy + pt.y * p.scale;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // 绘制中显示闭合预览虚线（1px）
        if (p.penState === "drawing" && p.penPoints.length >= 3) {
            const last = p.penPoints[p.penPoints.length - 1];
            const first = p.penPoints[0];
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = hexToRgba(contrastColor, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ox + last.x * p.scale, oy + last.y * p.scale);
            ctx.lineTo(ox + first.x * p.scale, oy + first.y * p.scale);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 微小的起点指示器（2px 实心点）
        if (p.penPoints.length > 0) {
            const fp = p.penPoints[0];
            ctx.fillStyle = hexToRgba("#4488FF", 0.8);
            ctx.beginPath();
            ctx.arc(ox + fp.x * p.scale, oy + fp.y * p.scale, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    ctx.restore(); // 恢复画布图像 clip
    ctx.restore(); // 恢复面板 clip
}

// ============ 鼠标交互 ============
function hitTest(btn, x, y) {
    return x >= btn.x && x <= btn.x + btn.w && y >= btn.y && y <= btn.y + btn.h;
}

function getLocalPoint(node, e) {
    const p = node.properties;
    const mx = e.canvasX - node.pos[0];
    const my = e.canvasY - node.pos[1];
    return {
        x: (mx - p.offsetX) / p.scale,
        y: (my - p.offsetY) / p.scale,
        mx, my
    };
}

function isInCanvas(node, mx, my) {
    const p = node.properties;
    const sw = p.canvasWidth * p.scale;
    const sh = p.canvasHeight * p.scale;
    return mx >= p.offsetX && mx <= p.offsetX + sw && my >= p.offsetY && my <= p.offsetY + sh;
}

// 画布面板整体区域（含空隙），用于右键拖拽平移
function isInCanvasPanel(node, mx, my) {
    const cardX = LAYOUT.toolWidth + LAYOUT.panelGap;
    const cardY = LAYOUT.topOffset;
    const cardW = node.size[0] - LAYOUT.toolWidth - LAYOUT.panelGap - LAYOUT.portWidth - LAYOUT.panelPad;
    const cardH = node.size[1] - LAYOUT.topOffset - LAYOUT.panelPad;
    return mx >= cardX && mx <= cardX + cardW && my >= cardY && my <= cardY + cardH;
}

function handleToolbarClick(node, mx, my, e) {
    const p = node.properties;
    const ui = p.ui;

    if (ui.editorBtn && hitTest(ui.editorBtn, mx, my)) {
        openOkayPixelsImageEditor(node).catch(e => console.error("[CanvasPaint] editor open failed:", e));
        return true;
    }

    // 工具菜单按钮
    const tmb = ui.toolMenuBtn;
    if (hitTest(tmb, mx, my)) {
        p.toolMenuOpen = !p.toolMenuOpen;
        buildUI(node);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return true;
    }

    // 菜单项
    if (p.toolMenuOpen) {
        for (const item of ui.toolMenuItems) {
            if (hitTest(item, mx, my)) {
                p.tool = item.type;
                p.toolMenuOpen = false;
                if (p.tool !== "pen") {
                    p.penPoints = [];
                    p.penState = "idle";
                }
                buildUI(node);
                if (app.graph) app.graph.setDirtyCanvas(true, true);
                return true;
            }
        }
    }

    // 最大尺寸滑块
    const ms = ui.maxSizeSlider;
    const msTrackY = ms.trackY;
    if (mx >= ms.x && mx <= ms.x + ms.w && my >= msTrackY - 8 && my <= msTrackY + ms.trackH + 8) {
        ms.dragging = true;
        let prog = Math.max(0, Math.min(1, (mx - ms.x) / ms.w));
        let raw = ms.min + prog * (ms.max - ms.min);
        p.maxSize = Math.round(raw / ms.step) * ms.step;
        p.maxSize = Math.max(ms.min, Math.min(ms.max, p.maxSize));
        const mw = node.widgets?.find(w => w.name === WIDGET_NAMES.MAX_SIZE);
        if (mw) mw.value = p.maxSize;
        node.capture = true;
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return true;
    }

    // 大小滑块
    const s = ui.sizeSlider;
    const trackY = s.trackY;
    if (mx >= s.x && mx <= s.x + s.w && my >= trackY - 8 && my <= trackY + s.trackH + 8) {
        s.dragging = true;
        const prog = Math.max(0, Math.min(1, (mx - s.x) / s.w));
        p.brushSize = Math.round(s.min + prog * (s.max - s.min));
        p.brushSize = Math.max(s.min, Math.min(s.max, p.brushSize));
        const bw = node.widgets?.find(w => w.name === WIDGET_NAMES.BRUSH_SIZE);
        if (bw) bw.value = p.brushSize;
        node.capture = true;
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return true;
    }

    // 透明度滑块
    const as = ui.alphaSlider;
    const aTrackY = as.trackY;
    if (mx >= as.x && mx <= as.x + as.w && my >= aTrackY - 8 && my <= aTrackY + as.trackH + 8) {
        as.dragging = true;
        const prog = Math.max(0, Math.min(1, (mx - as.x) / as.w));
        p.brushAlpha = Math.round(as.min + prog * (as.max - as.min));
        p.brushAlpha = Math.max(as.min, Math.min(as.max, p.brushAlpha));
        node.capture = true;
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return true;
    }

    // 色板
    const cp = ui.colorPalette;
    for (let i = 0; i < COLORS.length; i++) {
        const col = i % cp.cols;
        const row = Math.floor(i / cp.cols);
        const x = cp.x + col * (cp.size + cp.gap);
        const y = cp.y + row * (cp.size + cp.gap);
        if (mx >= x && mx <= x + cp.size && my >= y && my <= y + cp.size) {
            p.brushColor = COLORS[i];
            if (p.tool === "eraser") p.tool = "brush";
            if (app.graph) app.graph.setDirtyCanvas(true, true);
            return true;
        }
    }

    // 撤销
    if (hitTest(ui.undoBtn, mx, my)) {
        undo(node);
        return true;
    }

    // 清除
    if (hitTest(ui.clearBtn, mx, my)) {
        clearCanvas(node);
        return true;
    }

    // 缩放按钮
    for (const zb of ui.zoomBtns) {
        if (hitTest(zb, mx, my)) {
            if (zb.type === "zoomIn") { p.scale = Math.min(5, p.scale * 1.2); ensureNodeFits(node); }
            else if (zb.type === "zoomOut") { p.scale = Math.max(0.1, p.scale / 1.2); ensureNodeFits(node); }
            else if (zb.type === "fit") { updateLayout(node); ensureNodeFits(node); }
            if (app.graph) app.graph.setDirtyCanvas(true, true);
            return true;
        }
    }

    // Fit to Window
    if (hitTest(ui.fitBtn, mx, my)) {
        updateLayout(node);
        ensureNodeFits(node);
        if (app.graph) app.graph.setDirtyCanvas(true, true);
        return true;
    }

    return false;
}

// ============ 注册扩展 ============
app.registerExtension({
    name: "MyComfnode.CanvasPaint",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "MyComfnodeCanvasPaintNode") return;

        installFetchPatch();

        const origNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origNodeCreated) origNodeCreated.apply(this, arguments);

            initProperties(this);
            setupWidgets(this);
            buildUI(this);

            // 同步 widget 值到 properties（max_size 等）
            const maxW = this.widgets?.find(w => w.name === WIDGET_NAMES.MAX_SIZE);
            if (maxW && maxW.value !== undefined) this.properties.maxSize = maxW.value;
            const brushW = this.widgets?.find(w => w.name === WIDGET_NAMES.BRUSH_SIZE);
            if (brushW && brushW.value !== undefined) this.properties.brushSize = brushW.value;

            // 隐藏输入端口标签，避免和工具栏重叠
            if (this.inputs && this.inputs[0]) this.inputs[0].label = "";
            // 隐藏输出端口标签，避免和画布内容重叠
            if (this.outputs) {
                for (const o of this.outputs) o.label = "";
            }

            // 创建离屏 canvas
            this._paintCanvas = document.createElement("canvas");
            this._paintCanvas.width = this.properties.canvasWidth;
            this._paintCanvas.height = this.properties.canvasHeight;
            this._maskCanvas = document.createElement("canvas");
            this._maskCanvas.width = this.properties.canvasWidth;
            this._maskCanvas.height = this.properties.canvasHeight;
            // 遮罩初始为全黑
            const mctx = this._maskCanvas.getContext("2d");
            mctx.fillStyle = "#000000";
            mctx.fillRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);

            this.size = [NODE_MIN_WIDTH, NODE_MIN_HEIGHT];
            updateLayout(this);
            if (app.graph) app.graph.setDirtyCanvas(true, true);

            // 尝试自动加载上游图片（多次重试，确保上游已就绪）
            const nd = getNodeData(this);
            nd.bgImage = null;  // 强制清除旧缓存
            nd.bgBase64 = "";
            nd.editorBaseBase64 = "";
            setTimeout(() => autoLoadConnectedImage(this), 300);
            setTimeout(() => autoLoadConnectedImage(this), 1000);
            setTimeout(() => autoLoadConnectedImage(this), 2000);
            startUpstreamWatcher(this);
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            if (origConfigure) origConfigure.apply(this, arguments);
            initProperties(this);
            setupWidgets(this);
            // 确保数据存储已初始化
            getNodeData(this);
            // 保存用户当前的选择状态
            const savedTool = this.properties.tool;
            const savedColor = this.properties.brushColor;
            const savedSize = this.properties.brushSize;
            const savedMax = this.properties.maxSize;
            const savedAlpha = this.properties.brushAlpha;
            buildUI(this);
            // 恢复选择状态
            this.properties.tool = savedTool;
            this.properties.brushColor = savedColor;
            this.properties.brushSize = savedSize;
            this.properties.maxSize = savedMax;
            this.properties.brushAlpha = savedAlpha;
            // 同步 widget 值
            const maxW2 = this.widgets?.find(w => w.name === WIDGET_NAMES.MAX_SIZE);
            if (maxW2 && savedMax !== undefined) maxW2.value = savedMax;
            if (this.properties.ui && this.properties.ui.toolMenuBtn) {
                this.properties.ui.toolMenuBtn.label = getToolLabel(savedTool);
            }
            if (!this._paintCanvas) {
                this._paintCanvas = document.createElement("canvas");
                this._paintCanvas.width = this.properties.canvasWidth;
                this._paintCanvas.height = this.properties.canvasHeight;
                this._maskCanvas = document.createElement("canvas");
                this._maskCanvas.width = this.properties.canvasWidth;
                this._maskCanvas.height = this.properties.canvasHeight;
                const mctx = this._maskCanvas.getContext("2d");
                mctx.fillStyle = "#000000";
                mctx.fillRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
            }
            // 工作流恢复时清除旧缓存并重试加载
            if (this.inputs && this.inputs[0]) this.inputs[0].label = "";
            if (this.outputs) {
                for (const o of this.outputs) o.label = "";
            }
            const nd2 = getNodeData(this);
            nd2.bgImage = null;
            nd2.bgBase64 = "";
            nd2.editorBaseBase64 = "";
            nd2.editorCompositeBase64 = "";
            nd2.editorCompositeRef = "";
            nd2.editorCompositeMode = "";
            nd2._lastFilename = null;
            setTimeout(() => autoLoadConnectedImage(this), 500);
            setTimeout(() => autoLoadConnectedImage(this), 1500);
            startUpstreamWatcher(this);
            updateLayout(this);
            ensureNodeFits(this);
            if (app.graph) app.graph.setDirtyCanvas(true, true);
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function() {
            stopUpstreamWatcher(this);
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        // 连接变化时自动检测上游图片
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function(type, slotIndex, isConnected, link, ioSlot) {
            if (origOnConnectionsChange) {
                origOnConnectionsChange.apply(this, arguments);
            }
            // type: 1 = input, 2 = output; slotIndex: 端口索引
            if (type === LiteGraph.INPUT && slotIndex === 0) {
                if (isConnected) {
                    console.log("[CanvasPaint] Input 0 connected, clearing cache and auto-loading image...");
                    // 清除旧缓存，防止显示之前残留的图片
                    const nd = getNodeData(this);
                    nd.bgImage = null;
                    nd.bgBase64 = "";
                    nd.editorBaseBase64 = "";
                    nd._lastFilename = null;
                    // 多次重试：上游节点可能还没准备好
                    setTimeout(() => autoLoadConnectedImage(this), 200);
                    setTimeout(() => autoLoadConnectedImage(this), 800);
                    setTimeout(() => autoLoadConnectedImage(this), 1500);
                    startUpstreamWatcher(this);
                } else {
                    console.log("[CanvasPaint] Input 0 disconnected, stopping watcher");
                    stopUpstreamWatcher(this);
                }
            }
        };

        nodeType.prototype.onDrawForeground = function (ctx) {
            if (this.flags?.collapsed) return;
            if (!this.properties) return;
            if (this.size[0] < NODE_MIN_WIDTH || this.size[1] < NODE_MIN_HEIGHT) {
                this.size[0] = Math.max(this.size[0], NODE_MIN_WIDTH);
                this.size[1] = Math.max(this.size[1], NODE_MIN_HEIGHT);
                updateLayout(this);
            }
            ctx.save();
            try {
                drawToolbar(ctx, this);
                drawCanvasArea(ctx, this);
            } finally {
                ctx.restore();
            }
        };

        nodeType.prototype.onMouseDown = function (e) {
            const mx = e.canvasX - this.pos[0];
            const my = e.canvasY - this.pos[1];
            const p = this.properties;
            if (!p) return false;

            // 安全重置：如果 isPanning/capture 卡在 true（onMouseUp 被 LiteGraph 拦截），
            // 任何新的 mousedown 都能强制重置状态，恢复功能
            const rmbStillDown = (e.buttons & 2) !== 0;
            if (p.isPanning && !rmbStillDown) {
                p.isPanning = false;
                this.capture = false;
            }

            // 右键拖拽平移：最高优先级，在画布面板区域内即可（含图像上方）
            const isRMB = (e.button === 2) || rmbStillDown;
            if (isRMB && isInCanvasPanel(this, mx, my)) {
                if (p.ui?.sizeSlider) p.ui.sizeSlider.dragging = false;
                if (p.ui?.maxSizeSlider) p.ui.maxSizeSlider.dragging = false;
                if (p.ui?.alphaSlider) p.ui.alphaSlider.dragging = false;
                p.isPanning = true;
                p._panStart = { x: mx, y: my, ox: p.offsetX, oy: p.offsetY };
                this.capture = true;
                return true;
            }

            // 左侧工具栏 + 画布区域内的控件
            if (my > LAYOUT.topOffset) {
                const handled = handleToolbarClick(this, mx, my, e);
                if (handled) return true;
            }

            // 防御：重置任何卡住的滑块拖动状态
            if (p.ui?.sizeSlider) p.ui.sizeSlider.dragging = false;
            if (p.ui?.maxSizeSlider) p.ui.maxSizeSlider.dragging = false;
            if (p.ui?.alphaSlider) p.ui.alphaSlider.dragging = false;

            // 左键绘画：仅限图像实际显示区域
            if (e.button === 0 && isInCanvas(this, mx, my)) {
                const lp = getLocalPoint(this, e);

                // 钢笔工具 - 自由绘制模式
                if (p.tool === "pen") {
                    p.penPoints = [{ x: lp.x, y: lp.y }];
                    p.penState = "drawing";
                    this.capture = true;
                    if (app.graph) app.graph.setDirtyCanvas(true, true);
                    return true;
                }

                // 画笔/橡皮擦
                p.isDrawing = true;
                p.currentPath = [{ x: lp.x, y: lp.y }];
                this.capture = true;
                return true;
            }
            return false;
        };

        nodeType.prototype.onMouseMove = function (e) {
            const p = this.properties;
            if (!p) return false;

            const mx = e.canvasX - this.pos[0];
            const my = e.canvasY - this.pos[1];

            // 右键拖拽 — 直接检测按钮状态，绕过 LiteGraph 对 onMouseDown/onMouseUp 右键的拦截
            // e.buttons & 2 → 右键当前是否按下
            const rmbHeld = (e.buttons & 2) !== 0;

            // 安全重置：LiteGraph 可能拦截右键 mouseup，导致 isPanning/capture 卡住
            // 当检测到右键已释放但状态仍为平移时，立即重置（关键修复！）
            if (p.isPanning && !rmbHeld) {
                p.isPanning = false;
                this.capture = false;
            }

            // 开始平移
            if (rmbHeld && !p.isPanning && isInCanvasPanel(this, mx, my)) {
                p.isPanning = true;
                p._panStart = { x: mx, y: my, ox: p.offsetX, oy: p.offsetY };
                this.capture = true;
                if (p.ui?.sizeSlider) p.ui.sizeSlider.dragging = false;
                if (p.ui?.maxSizeSlider) p.ui.maxSizeSlider.dragging = false;
                if (p.ui?.alphaSlider) p.ui.alphaSlider.dragging = false;
            }

            // 平移
            if (p.isPanning) {
                p.offsetX = p._panStart.ox + (mx - p._panStart.x);
                p.offsetY = p._panStart.oy + (my - p._panStart.y);
                if (app.graph) app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // max_size 滑块拖动
            if (p.ui?.maxSizeSlider?.dragging) {
                const mx = e.canvasX - this.pos[0];
                const ms = p.ui.maxSizeSlider;
                let prog = Math.max(0, Math.min(1, (mx - ms.x) / ms.w));
                let raw = ms.min + prog * (ms.max - ms.min);
                p.maxSize = Math.round(raw / ms.step) * ms.step;
                p.maxSize = Math.max(ms.min, Math.min(ms.max, p.maxSize));
                const mw = this.widgets?.find(w => w.name === WIDGET_NAMES.MAX_SIZE);
                if (mw) mw.value = p.maxSize;
                if (app.graph) app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // 滑块拖动
            if (p.ui?.sizeSlider?.dragging) {
                const mx = e.canvasX - this.pos[0];
                const s = p.ui.sizeSlider;
                const prog = Math.max(0, Math.min(1, (mx - s.x) / s.w));
                p.brushSize = Math.round(s.min + prog * (s.max - s.min));
                const bw = this.widgets?.find(w => w.name === WIDGET_NAMES.BRUSH_SIZE);
                if (bw) bw.value = p.brushSize;
                if (app.graph) app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // 透明度滑块拖动
            if (p.ui?.alphaSlider?.dragging) {
                const mx = e.canvasX - this.pos[0];
                const as = p.ui.alphaSlider;
                const prog = Math.max(0, Math.min(1, (mx - as.x) / as.w));
                p.brushAlpha = Math.round(as.min + prog * (as.max - as.min));
                p.brushAlpha = Math.max(as.min, Math.min(as.max, p.brushAlpha));
                if (app.graph) app.graph.setDirtyCanvas(true, false);
                return true;
            }

            // 钢笔自由绘制
            if (p.tool === "pen" && p.penState === "drawing") {
                const lp = getLocalPoint(this, e);
                const last = p.penPoints[p.penPoints.length - 1];
                const dist = Math.sqrt(Math.pow(lp.x - last.x, 2) + Math.pow(lp.y - last.y, 2));
                if (dist > 0.5) {
                    p.penPoints.push({ x: lp.x, y: lp.y });
                    if (!this._pendingRedraw) {
                        this._pendingRedraw = true;
                        requestAnimationFrame(() => {
                            this._pendingRedraw = false;
                            if (app.graph) app.graph.setDirtyCanvas(true, false);
                        });
                    }
                }
                return true;
            }

            // 绘画 - 使用 requestAnimationFrame 节流，避免频繁触发保存
            if (p.isDrawing) {
                const lp = getLocalPoint(this, e);
                const last = p.currentPath[p.currentPath.length - 1];
                const dist = Math.sqrt(Math.pow(lp.x - last.x, 2) + Math.pow(lp.y - last.y, 2));
                const minStep = Math.max(0.2, Math.min(0.5, 0.35 / Math.max(p.scale || 1, 0.1)));
                if (dist > minStep) {
                    p.currentPath.push({ x: lp.x, y: lp.y });
                    if (!this._pendingRedraw) {
                        this._pendingRedraw = true;
                        requestAnimationFrame(() => {
                            this._pendingRedraw = false;
                            if (app.graph) app.graph.setDirtyCanvas(true, false);
                        });
                    }
                }
                return true;
            }

            return false;
        };

        nodeType.prototype.onMouseUp = function (e) {
            const p = this.properties;
            if (!p) return false;

            if (p.isPanning) {
                p.isPanning = false;
                this.capture = false;
                return true;
            }

            if (p.penState === "drawing") {
                p.penState = "idle";
                if (p.penPoints.length >= 3) {
                    commitPenFill(this);
                } else {
                    p.penPoints = [];
                }
                this.capture = false;
                if (app.graph) app.graph.setDirtyCanvas(true, true);
                return true;
            }

            if (p.isDrawing) {
                p.isDrawing = false;
                if (p.currentPath.length > 1) {
                    commitStroke(this);
                }
                p.currentPath = [];
                this.capture = false;
                if (app.graph) app.graph.setDirtyCanvas(true, true);
                return true;
            }

            if (p.ui?.maxSizeSlider?.dragging) {
                p.ui.maxSizeSlider.dragging = false;
                this.capture = false;
                return true;
            }

            if (p.ui?.sizeSlider?.dragging) {
                p.ui.sizeSlider.dragging = false;
                this.capture = false;
                return true;
            }

            if (p.ui?.alphaSlider?.dragging) {
                p.ui.alphaSlider.dragging = false;
                this.capture = false;
                return true;
            }

            return false;
        };

        nodeType.prototype.onWheel = function (e) {
            const p = this.properties;
            if (!p) return false;
            const mx = e.canvasX - this.pos[0];
            const my = e.canvasY - this.pos[1];
            if (mx < LAYOUT.toolWidth) return false;

            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            const oldScale = p.scale;
            p.scale = Math.max(0.1, Math.min(5, p.scale * delta));

            // 以鼠标位置为中心缩放
            const relX = (mx - p.offsetX) / oldScale;
            const relY = (my - p.offsetY) / oldScale;
            p.offsetX = mx - relX * p.scale;
            p.offsetY = my - relY * p.scale;

            // 节点跟随缩放扩展/收缩
            ensureNodeFits(this);

            if (app.graph) app.graph.setDirtyCanvas(true, true);
            return true;
        };

        // 拖拽上传
        const origOnDropFile = nodeType.prototype.onDropFile;
        nodeType.prototype.onDropFile = function (e) {
            if (origOnDropFile) {
                const r = origOnDropFile.apply(this, arguments);
                if (r) return r;
            }
            const mx = e.canvasX - this.pos[0];
            const my = e.canvasY - this.pos[1];
            if (mx < LAYOUT.toolWidth) return false;

            if (e.dataTransfer?.files?.length > 0) {
                const file = e.dataTransfer.files[0];
                if (!file.type.startsWith("image/")) return false;
                const reader = new FileReader();
                reader.onload = ev => loadImageToNode(this, ev.target.result);
                reader.readAsDataURL(file);
                return true;
            }
            return false;
        };
    }
});
