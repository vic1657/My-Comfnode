// Image Mask Brush V2 sticker integration.  Geometry, depth deformation and
// lighting are delegated to the same renderer used by the MY Texture node.

const STYLE_ID = "okaypixels-texture-editor-v2-style";
const DEPTH_MODEL = "depth_anything_v2_vitl_fp16.safetensors";
const COMPOSITE_SEMANTICS_VERSION = 2;
const SURFACE_ASSET_CACHE = new Map();

function inputSurfaceKey(inputSignature, imageData = "") {
  const signature = String(inputSignature || "").trim();
  return signature ? `input:${signature}` : `url:${String(imageData || "")}`;
}

function injectStyle() {
  const existing = document.getElementById(STYLE_ID);
  const style = existing || document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .op-ie-texture-tool{border-color:rgba(34,211,238,.45)!important;color:#a5f3fc!important}
    .op-ie-texture-tool.active{background:rgba(6,182,212,.18)!important;border-color:#22d3ee!important;color:#ecfeff!important}
    .op-ie-texture-panel{margin-top:10px;padding:10px;border:1px solid rgba(34,211,238,.35);border-radius:9px;background:rgba(8,47,73,.22);display:grid;gap:9px}
    .op-ie-texture-panel[hidden]{display:none}
    .op-ie-texture-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#dffaff;font-size:12px;font-weight:700}
    .op-ie-texture-help{margin:0;color:#9fb4c3;font-size:10px;line-height:1.5}
    .op-ie-texture-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .op-ie-texture-grid label{display:grid;gap:4px;color:#b9dbe8;font-size:10px}
    .op-ie-texture-grid input,.op-ie-texture-grid select{width:100%;accent-color:#22d3ee}
    .op-ie-texture-grid select{height:25px;border:1px solid #334155;border-radius:5px;background:#111827;color:#e5e7eb}
    .op-ie-texture-value{color:#f8fafc;font-variant-numeric:tabular-nums}
    .op-ie-texture-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .op-ie-texture-status{font-size:10px;line-height:1.45;color:#8dd9eb;min-height:28px}
    .op-ie-texture-status[data-tone="error"]{color:#fda4af}
    .op-ie-texture-status[data-tone="ready"]{color:#86efac}
    .op-ie-stage>.mytexture-embedded-stage{box-shadow:none;background:transparent}
    .op-ie-stage>.mytexture-embedded-stage .mytexture-canvas{cursor:move}
    .op-ie-stage>.mytexture-embedded-stage.texture-eraser-active .mytexture-canvas{cursor:crosshair}
    #okaypixels-comfy-image-editor .op-ie-brush-cursor{z-index:20}
    .op-ie-stage>.mytexture-embedded-stage .mytexture-transform-point{transform:scale(var(--texture-handle-scale,1));transform-origin:center}
  `;
  if (!existing) document.head.appendChild(style);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas?.toBlob?.(
    (blob) => blob ? resolve(blob) : reject(new Error("无法生成图片数据")),
    "image/png",
  ));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

async function imageFromCanvas(canvas) {
  const blob = await canvasToBlob(canvas);
  const url = URL.createObjectURL(blob);
  return { image: await loadImage(url), blob, url };
}

function viewUrl(file) {
  const query = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || "",
    type: file.type || "temp",
  });
  query.set("t", String(Date.now()));
  return `/view?${query.toString()}`;
}

async function uploadDepthSource(blob) {
  const filename = `v2-depth-${Date.now()}.png`;
  const form = new FormData();
  form.append("image", blob, filename);
  form.append("type", "input");
  form.append("subfolder", "my_image_mask_brush_v2/depth_preview");
  form.append("overwrite", "true");
  const response = await fetch("/upload/image", { method: "POST", body: form });
  if (!response.ok) throw new Error(`深度源图上传失败（HTTP ${response.status}）`);
  const data = await response.json();
  return data.subfolder ? `${data.subfolder}/${data.name || filename}` : (data.name || filename);
}

async function waitForHistory(promptId, timeoutMs = 240000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error(`读取深度结果失败（HTTP ${response.status}）`);
    const history = await response.json();
    const item = history?.[promptId];
    const status = item?.status;
    if (item?.outputs && (status?.completed || status?.status_str === "success" || !status)) return item;
    if (status?.status_str === "error" || status?.status_str === "failed") {
      const message = status?.messages?.find?.((entry) => entry?.[0] === "execution_error")?.[1]?.exception_message;
      throw new Error(message || "Depth Anything V2 执行失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  throw new Error("Depth Anything V2 执行超时");
}

async function generateSurfaceAssets(sourceBlob) {
  const sourcePath = await uploadDepthSource(sourceBlob);
  const depthPreviewId = "4";
  const maskPreviewId = "8";
  const prompt = {
    "1": { class_type: "LoadImage", inputs: { image: sourcePath } },
    "2": {
      class_type: "ImageScaleToTotalPixels",
      inputs: { image: ["1", 0], upscale_method: "lanczos", megapixels: 1.0, resolution_steps: 1 },
    },
    "3": {
      class_type: "DownloadAndLoadDepthAnythingV2Model",
      inputs: { model: DEPTH_MODEL, precision: "auto" },
    },
    "5": { class_type: "DepthAnything_V2", inputs: { da_model: ["3", 0], images: ["2", 0] } },
    [depthPreviewId]: { class_type: "PreviewImage", inputs: { images: ["5", 0] } },
    "6": {
      class_type: "RMBG",
      inputs: {
        image: ["1", 0], model: "RMBG-2.0", sensitivity: 1.0, process_res: 1024,
        mask_blur: 1, mask_offset: 1, invert_output: false,
        refine_foreground: false, background: "Alpha", background_color: "#222222",
      },
    },
    "7": { class_type: "MaskToImage", inputs: { mask: ["6", 1] } },
    [maskPreviewId]: { class_type: "PreviewImage", inputs: { images: ["7", 0] } },
  };
  const response = await fetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: globalThis.crypto?.randomUUID?.() || `image-mask-v2-${Date.now()}`,
      prompt,
      partial_execution_targets: [depthPreviewId, maskPreviewId],
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.error) {
    const detail = result?.node_errors ? JSON.stringify(result.node_errors) : (result?.error || "提交失败");
    throw new Error(`Depth Anything V2 提交失败：${detail}`);
  }
  const history = await waitForHistory(result.prompt_id);
  const depthFile = history?.outputs?.[depthPreviewId]?.images?.[0];
  const maskFile = history?.outputs?.[maskPreviewId]?.images?.[0];
  if (!depthFile?.filename) throw new Error("深度模型没有返回预览图");
  if (!maskFile?.filename) throw new Error("RMBG 没有返回人物主体遮罩");
  const [depthImage, maskImage] = await Promise.all([
    loadImage(viewUrl(depthFile)),
    loadImage(viewUrl(maskFile)),
  ]);
  return { depthImage, maskImage };
  /* Legacy depth-only return kept out of execution after the combined asset path.
  const file = history?.outputs?.[previewId]?.images?.[0];
  if (!file?.filename) throw new Error("深度模型没有返回预览图");
  return loadImage(viewUrl(file));
  */
}

function surfaceCacheKey(canvas) {
  const sample = document.createElement("canvas");
  sample.width = 24;
  sample.height = 24;
  const ctx = sample.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
  const bytes = ctx.getImageData(0, 0, sample.width, sample.height).data;
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(16)}`;
}

function cachedSurfaceAssets(key, sourceBlob, force = false) {
  if (force) SURFACE_ASSET_CACHE.delete(key);
  const cached = SURFACE_ASSET_CACHE.get(key);
  if (cached) {
    SURFACE_ASSET_CACHE.delete(key);
    SURFACE_ASSET_CACHE.set(key, cached);
    return cached;
  }
  const promise = generateSurfaceAssets(sourceBlob).catch((error) => {
    if (SURFACE_ASSET_CACHE.get(key) === promise) SURFACE_ASSET_CACHE.delete(key);
    throw error;
  });
  SURFACE_ASSET_CACHE.set(key, promise);
  while (SURFACE_ASSET_CACHE.size > 4) {
    const oldest = SURFACE_ASSET_CACHE.keys().next().value;
    SURFACE_ASSET_CACHE.delete(oldest);
  }
  return promise;
}

function selectedTextureLayer(editor) {
  return editor.layers.find((layer) => layer.id === editor._textureV2?.layerId) || null;
}

function initialTransform(editor, layer, source) {
  const left = Math.max(0, Math.min(1, layer.x / editor.width));
  const top = Math.max(0, Math.min(1, layer.y / editor.height));
  const right = Math.max(0, Math.min(1, (layer.x + layer.w) / editor.width));
  const bottom = Math.max(0, Math.min(1, (layer.y + layer.h) / editor.height));
  const scaleY = layer.h / Math.max(1, editor.width * (source.height / Math.max(1, source.width)));
  return JSON.stringify({
    currentLayer_1: {
      offset: [left, top],
      scale: [Math.max(0.001, layer.w / editor.width), Math.max(0.001, scaleY)],
      rotation: Number(layer.rotation) || 0,
      free_transform: true,
      corners: [[left, top], [right, top], [right, bottom], [left, bottom]],
    },
  });
}

function normalizedState(editor, layer, source, saved = null) {
  if (saved?.transformData) {
    const usesCurrentComposite = Number(saved.compositeSemanticsVersion) >= COMPOSITE_SEMANTICS_VERSION;
    return {
      ...saved,
      layerId: layer.id,
      compositeSemanticsVersion: COMPOSITE_SEMANTICS_VERSION,
      // Legacy builds defaulted to 67% + multiply. That made a UI value of
      // 100% look translucent because the source was still colour-blended
      // with the shirt. Migrate those saved defaults to real opaque compositing.
      opacity: usesCurrentComposite ? Number(saved.opacity ?? 1) : 1,
      blendMode: usesCurrentComposite ? String(saved.blendMode || "normal") : "normal",
      eraseSpace: "texture",
      // Older V2 builds stored erasing in fixed canvas coordinates. Reusing
      // those strokes would recreate the exact region-erasing bug being fixed.
      eraseStrokes: saved.eraseSpace === "texture" && Array.isArray(saved.eraseStrokes)
        ? saved.eraseStrokes
        : [],
    };
  }
  if (saved?.x !== undefined) {
    const x = Number(saved.x) / 100;
    const y = Number(saved.y) / 100;
    const w = Number(saved.width) / 100;
    const h = Number(saved.height) / 100;
    saved = {
      transformData: JSON.stringify({
        currentLayer_1: {
          offset: [x, y], scale: [w, h], rotation: Number(saved.rotation) || 0,
          free_transform: true,
          corners: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
        },
      }),
      deformation: (Number(saved.depthStrength) || 30) / 100,
      opacity: 1,
      blendMode: "normal",
      compositeSemanticsVersion: COMPOSITE_SEMANTICS_VERSION,
    };
  }
  return {
    layerId: layer.id,
    transformData: saved?.transformData || initialTransform(editor, layer, source),
    deformation: Number(saved?.deformation ?? 0.4),
    opacity: Number(saved?.opacity ?? 1),
    skewX: Number(saved?.skewX ?? 0),
    skewY: Number(saved?.skewY ?? 0),
    stretchX: Number(saved?.stretchX ?? 1),
    stretchY: Number(saved?.stretchY ?? 1),
    blendMode: String(saved?.blendMode || "normal"),
    compositeSemanticsVersion: COMPOSITE_SEMANTICS_VERSION,
    eraseSpace: "texture",
    eraseStrokes: saved?.eraseSpace === "texture" && Array.isArray(saved?.eraseStrokes)
      ? saved.eraseStrokes
      : [],
    depthReady: false,
  };
}

function texturePayloadTransform(state, controller) {
  let data = {};
  try { data = JSON.parse(controller?.getTransformData?.() || state.transformData || "{}"); } catch { data = {}; }
  return JSON.stringify({
    ...data,
    depth_strength: state.deformation,
    opacity: state.opacity,
    skew_x: state.skewX,
    skew_y: state.skewY,
    stretch_x: state.stretchX,
    stretch_y: state.stretchY,
    blend_mode: state.blendMode,
    composite_semantics_version: COMPOSITE_SEMANTICS_VERSION,
    erase_space: "texture",
    erase_strokes: Array.isArray(state.eraseStrokes) ? state.eraseStrokes : [],
  });
}

function installTexturePanel(editor) {
  const host = editor.root?.querySelector(".op-ie-layers");
  const tools = editor.root?.querySelector(".op-ie-layer-tools");
  const stageContainer = editor.root?.querySelector(".op-ie-stage");
  if (!host || !tools || !stageContainer || editor._textureV2Installed) return;
  editor._textureV2Installed = true;

  const tool = document.createElement("button");
  tool.type = "button";
  tool.className = "op-ie-icon-btn op-ie-layer-tool op-ie-texture-tool";
  tool.innerHTML = "◇<span>贴图</span>";
  tool.title = "把选中的素材图层转换为深度贴图";
  tools.appendChild(tool);

  const panel = document.createElement("section");
  panel.className = "op-ie-texture-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="op-ie-texture-head"><span>贴图 V2 · 深度实时预览</span><button type="button" class="op-ie-icon-btn" data-texture-close>×</button></div>
    <p class="op-ie-texture-help">直接拖动画面中的贴图移动；拖四个圆点做自由透视；拖上方圆点旋转。深度模型会自动运行，无需额外连接。</p>
    <div class="op-ie-texture-grid">
      <label><span>形变强度 <b class="op-ie-texture-value" data-depth-value></b></span><input type="range" min="0" max="100" step="1" data-texture-depth></label>
      <label><span>透明度 <b class="op-ie-texture-value" data-opacity-value></b></span><input type="range" min="0" max="100" step="1" data-texture-opacity></label>
      <label><span>混合模式</span><select data-texture-blend><option value="normal">正常（不透底）</option><option value="multiply">正片叠底</option><option value="overlay">叠加</option><option value="soft-light">柔光</option><option value="screen">滤色</option></select></label>
    </div>
    <div class="op-ie-texture-actions"><button type="button" class="op-ie-btn" data-texture-refresh>生成深度</button><button type="button" class="op-ie-btn" data-texture-clear>取消贴图</button></div>
    <div class="op-ie-texture-status">请选择一个素材图层后点击“贴图”</div>`;
  host.appendChild(panel);

  const status = panel.querySelector(".op-ie-texture-status");
  const setStatus = (text, tone = "normal") => {
    status.textContent = text;
    status.dataset.tone = tone;
  };
  const syncPanel = () => {
    const state = editor._textureV2;
    panel.querySelector("[data-texture-depth]").value = String(Math.round((state?.deformation ?? 0.4) * 100));
    panel.querySelector("[data-texture-opacity]").value = String(Math.round((state?.opacity ?? 1) * 100));
    panel.querySelector("[data-texture-blend]").value = state?.blendMode || "normal";
    panel.querySelector("[data-depth-value]").textContent = `${Math.round((state?.deformation ?? 0.4) * 100)}%`;
    panel.querySelector("[data-opacity-value]").textContent = `${Math.round((state?.opacity ?? 1) * 100)}%`;
    tool.classList.toggle("active", !!state);
  };

  const destroyController = () => {
    editor._textureV2CanvasDragCleanup?.();
    editor._textureV2CanvasDragCleanup = null;
    editor._textureV2Controller?.destroy?.();
    editor._textureV2Controller = null;
    for (const url of editor._textureV2Urls || []) URL.revokeObjectURL(url);
    editor._textureV2Urls = [];
  };

  const syncControllerZoom = () => {
    const stage = editor._textureV2Controller?.stage;
    if (stage) stage.style.setProperty("--texture-handle-scale", String(1 / Math.max(0.05, Number(editor.zoom) || 1)));
  };

  const syncTextureToolMode = () => {
    editor._textureV2Controller?.stage?.classList.toggle("texture-eraser-active", editor.tool === "eraser");
  };

  const originalApplyStageTransform = editor.applyStageTransform.bind(editor);
  editor.applyStageTransform = function(...args) {
    const result = originalApplyStageTransform(...args);
    syncControllerZoom();
    return result;
  };

  const originalSetTool = editor.setTool.bind(editor);
  editor.setTool = function(...args) {
    const result = originalSetTool(...args);
    syncTextureToolMode();
    return result;
  };

  const installCanvasInteractions = (state) => {
    const canvas = editor._textureV2Controller?.stage?.querySelector(".mytexture-canvas");
    if (!canvas) return;
    let pointerId = null;
    let mode = "move";
    let start = null;
    let startData = null;
    let activeEraseStroke = null;
    let pendingTransform = null;
    let renderFrame = 0;
    const parseData = () => {
      try { return JSON.parse(editor._textureV2Controller.getTransformData() || "{}"); } catch { return {}; }
    };
    const scheduleTransform = (value) => {
      pendingTransform = value;
      if (renderFrame) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        if (!pendingTransform) return;
        editor._textureV2Controller?.setTransformData?.(pendingTransform, true);
        pendingTransform = null;
      });
    };
    const scheduleEraseRender = () => {
      if (renderFrame) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        editor._textureV2Controller?.setEraseStrokes?.(state.eraseStrokes, true);
      });
    };
    const eraseSample = (event) => {
      const point = editor.canvasPointRaw?.(event);
      if (!point) return null;
      const x = Math.max(0, Math.min(1, point.x / Math.max(1, editor.width)));
      const y = Math.max(0, Math.min(1, point.y / Math.max(1, editor.height)));
      const local = editor._textureV2Controller?.mapBackgroundPointToTexture?.(x, y);
      if (!local || local[0] < 0 || local[0] > 1 || local[1] < 0 || local[1] > 1) return null;
      const radiusX = Math.max(0.5, Number(editor.size) || 1) / Math.max(1, editor.width) / 2;
      const radiusY = Math.max(0.5, Number(editor.size) || 1) / Math.max(1, editor.height) / 2;
      const localX = editor._textureV2Controller?.mapBackgroundPointToTexture?.(x + radiusX, y);
      const localY = editor._textureV2Controller?.mapBackgroundPointToTexture?.(x, y + radiusY);
      const radius = Math.max(
        localX ? Math.hypot(localX[0] - local[0], localX[1] - local[1]) : 0,
        localY ? Math.hypot(localY[0] - local[0], localY[1] - local[1]) : 0,
        0.0005,
      );
      return { point: local, size: radius * 2 };
    };
    const move = (event) => {
      if (event.pointerId !== pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      editor.updateBrushCursor?.(event);
      if (mode === "erase") {
        const sample = eraseSample(event);
        if (sample && activeEraseStroke) activeEraseStroke.points.push(sample.point);
        scheduleEraseRender();
        return;
      }
      if (!startData) return;
      const dx = (event.clientX - start.x) / Math.max(1, editor.width * editor.zoom);
      const dy = (event.clientY - start.y) / Math.max(1, editor.height * editor.zoom);
      const data = structuredClone(startData);
      const layer = data.currentLayer_1 || (data.currentLayer_1 = {});
      if (layer.free_transform && Array.isArray(layer.corners) && layer.corners.length === 4) {
        const xs = layer.corners.map((point) => Number(point[0]) || 0);
        const ys = layer.corners.map((point) => Number(point[1]) || 0);
        const safeX = Math.max(-Math.min(...xs), Math.min(1 - Math.max(...xs), dx));
        const safeY = Math.max(-Math.min(...ys), Math.min(1 - Math.max(...ys), dy));
        layer.corners = layer.corners.map(([x, y]) => [Number(x) + safeX, Number(y) + safeY]);
      } else {
        const offset = Array.isArray(layer.offset) ? layer.offset : [0, 0];
        layer.offset = [Number(offset[0]) + dx, Number(offset[1]) + dy];
      }
      state.transformData = JSON.stringify(data);
      scheduleTransform(state.transformData);
    };
    const end = (event) => {
      if (event.pointerId !== pointerId) return;
      const completedMode = mode;
      event.preventDefault();
      event.stopPropagation();
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      if (pendingTransform) {
        editor._textureV2Controller?.setTransformData?.(pendingTransform, true);
        pendingTransform = null;
      }
      pointerId = null;
      start = null;
      startData = null;
      activeEraseStroke = null;
      editor._textureV2Controller?.render?.(false);
      if (completedMode === "erase") {
        /* Legacy screen-space status:
        setStatus("橡皮擦已作用于贴图：擦除位置已按当前透视精确记录。", "ready");
        */
        setStatus("橡皮擦已修改贴图自身 Alpha；擦除内容会跟随贴图移动和变形。", "ready");
      }
    };
    const down = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pointerId = event.pointerId;
      mode = editor.tool === "eraser" ? "erase" : "move";
      if (mode === "erase") {
        editor.pushHistory?.();
        const sample = eraseSample(event);
        if (!sample) {
          pointerId = null;
          return;
        }
        activeEraseStroke = {
          size: sample.size,
          hardness: Math.max(0, Math.min(100, Number(editor.eraserHardness) || 0)),
          points: [sample.point],
        };
        state.eraseStrokes = Array.isArray(state.eraseStrokes) ? state.eraseStrokes : [];
        state.eraseStrokes.push(activeEraseStroke);
        canvas.dataset.textureEraseStrokes = String(state.eraseStrokes.length);
        scheduleEraseRender();
      }
      start = { x: event.clientX, y: event.clientY };
      startData = mode === "move" ? parseData() : null;
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", end, true);
      document.addEventListener("pointercancel", end, true);
    };
    canvas.addEventListener("pointerdown", down, true);
    editor._textureV2CanvasDragCleanup = () => {
      canvas.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      if (renderFrame) cancelAnimationFrame(renderFrame);
    };
  };

  const createController = async (layer, saved = null, forceDepth = false) => {
    destroyController();
    layer.visible = false;
    editor.layerListDirty = true;
    editor.updateUi?.(true);
    editor.render?.();

    const source = editor.renderLayerSourceCanvas(layer);
    const baseCanvas = editor.exportComposite(true);
    const [background, texture] = await Promise.all([imageFromCanvas(baseCanvas), imageFromCanvas(source)]);
    editor._textureV2Urls = [background.url, texture.url];
    editor._textureBaseBlob = background.blob;
    const state = normalizedState(editor, layer, source, saved);
    editor._textureV2 = state;

    const bridge = globalThis.MyTexturePreviewBridge;
    if (!bridge?.createEmbeddedController) throw new Error("MY贴图预览引擎未加载，请刷新 ComfyUI");
    editor._textureV2Controller = bridge.createEmbeddedController({
      container: stageContainer,
      backgroundImage: background.image,
      textureImage: texture.image,
      maskImage: editor._textureMaskImage || null,
      backgroundWidth: editor.width,
      backgroundHeight: editor.height,
      textureWidth: source.width,
      textureHeight: source.height,
      transformData: state.transformData,
      deformation: state.deformation,
      opacity: state.opacity,
      skewX: state.skewX,
      skewY: state.skewY,
      stretchX: state.stretchX,
      stretchY: state.stretchY,
      blendMode: state.blendMode,
      eraseStrokes: state.eraseStrokes,
      onTransform: (next) => { state.transformData = next; },
    });
    installCanvasInteractions(state);
    syncControllerZoom();
    syncTextureToolMode();
    panel.hidden = false;
    syncPanel();
    // Opening the texture editor must never enqueue a ComfyUI workflow.  The
    // costly depth/mask request is deliberately opt-in via the button below.
    if (!forceDepth && (!editor._textureDepthImage || !editor._textureMaskImage)) {
      state.depthReady = false;
      setStatus("贴图已加载。需要深度贴合时请点击“生成深度”。", "ready");
      return;
    }
    setStatus(editor._textureSurfacePromise
      ? "贴图已显示；正在复用预加载的深度与边界数据…"
      : "贴图已显示；深度与边界正在后台生成…");

    try {
      if (!editor._textureDepthImage || !editor._textureMaskImage || forceDepth) {
        const key = editor._textureSurfaceKey || surfaceCacheKey(baseCanvas);
        const assets = await (forceDepth
          ? cachedSurfaceAssets(key, background.blob, true)
          : (editor._textureSurfacePromise || cachedSurfaceAssets(key, background.blob)));
        editor._textureDepthImage = assets.depthImage;
        editor._textureMaskImage = assets.maskImage;
      }
      state.depthReady = true;
      editor._textureV2Controller.setDepthImage(editor._textureDepthImage);
      editor._textureV2Controller.setMaskImage(editor._textureMaskImage);
      setStatus("深度贴合已生效：可拖动贴图、调整四角透视和旋转。", "ready");
      setStatus("深度贴合与人物边界遮罩已生效：移动时保持实时透视，贴图不会越出主体。", "ready");
    } catch (error) {
      state.depthReady = false;
      setStatus(`深度生成失败：${error.message || error}`, "error");
      setStatus(`深度或人物遮罩生成失败：${error.message || error}`, "error");
      throw error;
    }
  };

  // Start the expensive model work as soon as the editor opens. In the usual
  // flow it finishes while the user imports/selects a material, so clicking
  // “贴图” can immediately use the final depth and silhouette instead of
  // showing a visibly different ten-second placeholder.
  // Do not prefetch depth or silhouette assets here. Opening the editor must
  // remain a display-only action until the user explicitly requests depth.

  tool.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (editor._textureV2Controller) {
      panel.hidden = !panel.hidden;
      return;
    }
    const layer = editor.activeLayer?.();
    if (!layer || layer.locked || layer.type === "base" || layer.type === "mask") {
      panel.hidden = false;
      setStatus("请先选择一个已上传、未锁定的素材图层（不能选择原图或遮罩）。", "error");
      return;
    }
    tool.disabled = true;
    try {
      await createController(layer);
    } catch (error) {
      console.error("[ImageMaskBrushV2] texture activation failed", error);
    } finally {
      tool.disabled = false;
    }
  });

  panel.addEventListener("input", (event) => {
    const state = editor._textureV2;
    if (!state || !editor._textureV2Controller) return;
    if (event.target.matches("[data-texture-depth]")) state.deformation = Number(event.target.value) / 100;
    if (event.target.matches("[data-texture-opacity]")) state.opacity = Number(event.target.value) / 100;
    if (event.target.matches("[data-texture-blend]")) state.blendMode = event.target.value;
    editor._textureV2Controller.setControls({
      deformation: state.deformation,
      opacity: state.opacity,
      blendMode: state.blendMode,
    }, true);
    syncPanel();
  });
  panel.addEventListener("change", () => editor._textureV2Controller?.render?.(false));
  panel.querySelector("[data-texture-refresh]").addEventListener("click", async () => {
    const layer = selectedTextureLayer(editor);
    if (!layer) return;
    const saved = { ...editor._textureV2, transformData: editor._textureV2Controller?.getTransformData?.() };
    try { await createController(layer, saved, true); } catch (error) { console.error(error); }
  });
  panel.querySelector("[data-texture-clear]").addEventListener("click", () => {
    const layer = selectedTextureLayer(editor);
    destroyController();
    if (layer) layer.visible = true;
    editor._textureV2 = null;
    editor._textureBaseBlob = null;
    editor.layerListDirty = true;
    editor.updateUi?.(true);
    editor.render?.();
    syncPanel();
    setStatus("贴图已取消，素材图层已恢复。", "ready");
  });
  panel.querySelector("[data-texture-close]").addEventListener("click", () => { panel.hidden = true; });

  const originalSerialize = editor.serializeProject.bind(editor);
  editor.serializeProject = function() {
    const state = editor._textureV2;
    return {
      ...originalSerialize(),
      textureV2: state ? {
        ...state,
        transformData: editor._textureV2Controller?.getTransformData?.() || state.transformData,
      } : null,
    };
  };
  const originalPayload = editor.buildTexturePayload;
  editor.buildTexturePayload = async function() {
    const state = editor._textureV2;
    const layer = selectedTextureLayer(editor);
    if (!state || !layer || !editor._textureV2Controller) return originalPayload?.();
    const textureBlob = await canvasToBlob(editor.renderLayerSourceCanvas(layer));
    const textureBaseBlob = editor._textureBaseBlob || await canvasToBlob(editor.exportComposite(true));
    return {
      textureBlob,
      textureBaseBlob,
      textureTransform: texturePayloadTransform(state, editor._textureV2Controller),
    };
  };

  syncPanel();
  if (editor.project?.textureV2) {
    const layer = editor.layers.find((item) => item.id === editor.project.textureV2.layerId);
    if (layer) requestAnimationFrame(() => createController(layer, editor.project.textureV2).catch((error) => console.error(error)));
  }
}

window.OkayPixelsComfyTextureEditor = {
  // Compatibility hook only. It must never submit a depth-generation prompt.
  preload() {
    return Promise.resolve(null);
  },
  async open(options) {
    injectStyle();
    let editor;
    const callerSave = options.onSave;
    editor = await window.OkayPixelsComfyImageEditor.open({
      ...options,
      onSave: async (payload) => callerSave?.({
        ...payload,
        ...(await editor.buildTexturePayload?.() || {}),
      }),
    });
    installTexturePanel(editor);
    return editor;
  },
};
