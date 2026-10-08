// RH大香蕉并发 - 前端界面 v3
// 分组布局：竖排列（每列10组），满列后横向加列
// - 悬停分组：放大 1.15 倍便于查看
// - 分组卡片可拖拽移动（点卡片任意位置，含提示词区域；图片框除外——那里拖的是图片配对）
// - 图片槽支持跨组拖拽配对（交换）、外部文件拖入上传
// - 节点右下角可拉伸，预览区跟随高度
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "RHBananaConcurrent";
const DATA_WIDGET = "group_data";
const SUBFOLDER = "rh_concurrent";
const MAX_GROUPS = 100;
const ROWS_PER_COLUMN = 10;

function findWidget(node, name) {
  return node.widgets?.find((item) => item?.name === name);
}

function hideWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget || widget._myqHidden) return widget;
  widget._myqHidden = true;
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

function isImageFile(file) {
  return file?.type?.startsWith("image/") || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file?.name || "");
}

async function uploadImage(file) {
  const form = new FormData();
  const uniqueName = Date.now().toString(36) + "_"
    + Math.random().toString(36).slice(2, 6) + "_" + file.name;
  form.append("image", file, uniqueName);
  form.append("subfolder", SUBFOLDER);
  form.append("type", "input");
  form.append("overwrite", "true");
  const response = await fetch("/upload/image", { method: "POST", body: form });
  if (!response.ok) throw new Error(`上传失败(${response.status})`);
  const data = await response.json();
  return { filename: data.name, subfolder: data.subfolder || SUBFOLDER, type: data.type || "input" };
}

function thumbUrl(ref) {
  if (!ref?.filename) return "";
  const params = new URLSearchParams({
    filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input",
  });
  return `/my-comfnode/rh-banana-concurrent/thumb?${params.toString()}`;
}

function outputViewUrl(descriptor) {
  const params = new URLSearchParams({
    filename: descriptor.filename, subfolder: descriptor.subfolder || "",
    type: descriptor.type || "output",
  });
  return `/view?${params.toString()}`;
}

function injectStyles() {
  if (document.getElementById("rhbc-style")) return;
  const style = document.createElement("style");
  style.id = "rhbc-style";
  style.textContent = `
.rhbc-wrap { display:flex; flex-direction:column; gap:8px; width:100%; height:100%;
  font-size:12px; color:#d8dce3; pointer-events:none; }
/* 默认鼠标穿透（滚轮缩放/拖动=操作画布和节点），仅交互控件开启 */
.rhbc-box, .rhbc-btn, .rhbc-count input, .rhbc-results img,
.rhbc-batch-prompt { pointer-events:auto; }
.rhbc-batch-prompt { min-height:240px; resize:vertical; }
.rhbc-section { border:1px solid #3d4450; border-radius:8px; padding:8px; background:#22262e;
  flex-shrink:0; }
.rhbc-section.rhbc-batch { border-color:#5b8a5f; background:#232b25; }
.rhbc-title { font-weight:600; color:#a9d8a9; margin-bottom:6px; font-size:12px; }
.rhbc-slots { display:flex; gap:14px; align-items:flex-start; }
.rhbc-slot { flex-shrink:0; }
.rhbc-box { position:relative; width:100%; aspect-ratio:1/1; border:1.5px dashed #4d5766;
  border-radius:8px; background:#12141a; display:flex; align-items:center; justify-content:center;
  color:#7f8b9d; font-size:12px; cursor:pointer; overflow:hidden; }
.rhbc-box:hover { border-color:#7ab87a; color:#a9d8a9; }
.rhbc-box img { width:100%; height:100%; object-fit:contain; background:#0d0f13; }
.rhbc-box.rhbc-dragover { border-color:#e5c073; box-shadow:0 0 0 2px #e5c073 inset; }
.rhbc-box .rhbc-x { position:absolute; top:4px; right:4px; width:20px; height:20px; border:none;
  border-radius:50%; background:rgba(15,18,24,.85); color:#c9d1dc; font-size:11px; cursor:pointer;
  display:none; align-items:center; justify-content:center; padding:0; z-index:3; }
.rhbc-box:hover .rhbc-x { display:flex; }
.rhbc-x:hover { color:#ff8a80; }
.rhbc-slot-label { text-align:center; color:#8d99ab; font-size:11px; margin-top:4px; }
.rhbc-prompt { flex:1; min-width:140px; }
.rhbc-prompt textarea { width:100%; min-height:80px; background:#171a20; color:#d8dce3;
  border:1px solid #3d4450; border-radius:6px; padding:6px; font-size:12px; resize:vertical;
  box-sizing:border-box; }
.rhbc-btn { background:#333945; color:#e6e9ee; border:1px solid #4c5462; border-radius:6px;
  padding:4px 12px; cursor:pointer; font-size:12px; }
.rhbc-btn:hover { background:#3f4756; }
.rhbc-btn.rhbc-danger { background:#5a3038; border-color:#7d434e; }
.rhbc-btn.rhbc-danger:hover { background:#6d3a44; }
.rhbc-btn.myq2-run { background:#2d5f9e; border-color:#3f7fc0; }
.rhbc-btn.myq2-run:hover { background:#3570b5; }
.rhbc-btn:disabled { opacity:.5; cursor:default; }
.rhbc-hint { margin-left:auto; color:#8d99ab; font-size:11px; }
.rhbc-count { display:flex; align-items:center; gap:6px; color:#a9b4c2; font-size:12px; }
.rhbc-count input { width:56px; background:#171a20; color:#e6e9ee; border:1px solid #3d4450;
  border-radius:5px; padding:3px 6px; font-size:12px; }
/* 分组区：竖排列，每列10组，满列横向加列 */
.rhbc-groups { position:relative; display:grid; grid-template-rows:repeat(10, auto);
  grid-auto-flow:column; gap:10px; align-content:start; justify-content:start;
  flex:1; min-height:160px; overflow:auto; padding:6px; }
.rhbc-group { width:330px; background:#22262e; border:1px solid #3d4450; border-radius:10px;
  padding:8px; position:relative; cursor:grab; transition:box-shadow .15s; }
.rhbc-group:hover { box-shadow:0 8px 22px rgba(0,0,0,.55); }
.rhbc-group.rhbc-dragging { cursor:grabbing; box-shadow:0 10px 26px rgba(0,0,0,.65);
  border-color:#e5c073; }
.rhbc-slots-in { display:flex; gap:10px; }
.rhbc-group .rhbc-box { width:146px; }
.rhbc-group .rhbc-prompt textarea { min-height:64px; pointer-events:auto; }
.rhbc-num { position:absolute; top:-9px; left:-9px; min-width:24px; height:24px; border-radius:12px;
  background:#4a5160; color:#fff; display:flex; align-items:center; justify-content:center;
  font-size:12px; z-index:2; border:1px solid #22262e; }
.rhbc-status-ok { color:#7ab87a; }
.rhbc-status-err { color:#e57373; }
.rhbc-progress { height:6px; background:#171a20; border-radius:3px; overflow:hidden; }
.rhbc-progress > div { height:100%; background:#4f9d6e; width:0%; transition:width .4s; }
.rhbc-results { display:flex; flex-wrap:wrap; gap:8px; max-height:220px; overflow-y:auto; }
.rhbc-badge { position:absolute; bottom:5px; left:5px; background:rgba(15,18,24,.88); color:#ffd479; padding:1px 7px; border-radius:4px; font-size:11px; z-index:2; }
.rhbc-results img { width:120px; height:120px; object-fit:contain; background:#0d0f13;
  border-radius:6px; cursor:pointer; border:1px solid #3d4450; }
`;
  document.head.appendChild(style);
}

function emptyGroups() {
  return Array.from({ length: MAX_GROUPS }, () => ({
    image1: null, image2: null, prompt: "",
  }));
}

app.registerExtension({
  name: "MyComfnode.RHBananaConcurrent.V3",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      const node = this;
      node.properties ||= {};
      node.properties.rhcGroups = Array.isArray(node.properties.rhcGroups)
        && node.properties.rhcGroups.length
        ? node.properties.rhcGroups : emptyGroups();
      node.properties.rhcCount = Math.max(1, Math.min(MAX_GROUPS,
        Number(node.properties.rhcCount) || 1));
      node.properties.rhcOffsets = node.properties.rhcOffsets || {};
      // 关键：初始化运行时分组数组（缺失会导致分组列表渲染为空）
      node._rhcGroups = node.properties.rhcGroups.slice();
      while (node._rhcGroups.length < MAX_GROUPS) {
        node._rhcGroups.push({ image1: null, image2: null, prompt: "" });
      }

      injectStyles();

      const root = document.createElement("div");
      root.className = "rhbc-wrap";

      // ===== 顶部：批量填入组 =====
      const batchSection = document.createElement("div");
      batchSection.className = "rhbc-section rhbc-batch";
      batchSection.innerHTML = `<div class="rhbc-title">批量填入组（拖图片到图一/图二：一张或一百张都行，按顺序自动填入各组；提示词填好后点"同步批量填入"）</div>`;
      const batchSlots = document.createElement("div");
      batchSlots.className = "rhbc-slots";
      const batchPromptWrap = document.createElement("div");
      batchPromptWrap.className = "rhbc-prompt";
      const batchPrompt = document.createElement("textarea");
      batchPrompt.className = "rhbc-batch-prompt";
      batchPrompt.placeholder = "批量提示词：填好后点同步，会覆盖下方全部分组的提示词";
      batchPromptWrap.appendChild(batchPrompt);
      const batchBtns = document.createElement("div");
      batchBtns.style.cssText = "display:flex;gap:6px;margin-top:6px;";
      const syncBtn = document.createElement("button");
      syncBtn.className = "rhbc-btn";
      syncBtn.textContent = "同步批量填入";
      batchBtns.append(syncBtn);
      batchPromptWrap.appendChild(batchBtns);
      batchSection.append(batchSlots, batchPromptWrap);

      // ===== 中部：开始按钮 + 进度 =====
      const runSection = document.createElement("div");
      runSection.className = "rhbc-section";
      const runBar = document.createElement("div");
      runBar.style.cssText = "display:flex;gap:8px;align-items:center;";
      const runBtn = document.createElement("button");
      runBtn.className = "rhbc-btn myq2-run";
      runBtn.textContent = "▶ 开始并发提交";
      runBtn.style.flex = "1";
      const hint = document.createElement("span");
      hint.className = "rhbc-hint";
      hint.textContent = "独立运行，不占用 ComfyUI 队列";
      runBar.append(runBtn, hint);
      const progress = document.createElement("div");
      progress.className = "rhbc-progress";
      progress.style.marginTop = "6px";
      const progressBar = document.createElement("div");
      progress.appendChild(progressBar);
      const statusEl = document.createElement("div");
      statusEl.style.cssText = "margin-top:4px;color:#8d99ab;font-size:11px;";
      statusEl.textContent = "等待开始";
      runSection.append(runBar, progress, statusEl);

      // ===== 下方：分组区（竖列布局 + 自由拖拽）=====
      const groupsSection = document.createElement("div");
      groupsSection.className = "rhbc-section";
      groupsSection.style.cssText = "flex:1;min-height:180px;display:flex;flex-direction:column;";
      const titleBar = document.createElement("div");
      titleBar.style.cssText = "display:flex;align-items:center;margin-bottom:6px;";
      const groupsTitle = document.createElement("div");
      groupsTitle.className = "rhbc-title";
      groupsTitle.style.marginBottom = "0";
      titleBar.appendChild(groupsTitle);
      const clearAllBtn = document.createElement("button");
      clearAllBtn.className = "rhbc-btn rhbc-danger";
      clearAllBtn.textContent = "清空全部";
      clearAllBtn.title = "一键清空所有分组的图片和提示词（含隐藏组），清空后不会再恢复历史数据";
      titleBar.appendChild(clearAllBtn);
      const countWrap = document.createElement("div");
      countWrap.className = "rhbc-count";
      countWrap.style.marginLeft = "auto";
      countWrap.appendChild(document.createTextNode("分组数："));
      const countInput = document.createElement("input");
      countInput.type = "number";
      countInput.min = "1"; countInput.max = String(MAX_GROUPS);
      countInput.value = String(node.properties.rhcCount);
      countInput.title = "要用多少组就填多少，只有填了内容和图片的分组会被提交";
      countWrap.appendChild(countInput);
      titleBar.appendChild(countWrap);
      groupsSection.append(titleBar);
      const groupsList = document.createElement("div");
      groupsList.className = "rhbc-groups";
      groupsSection.appendChild(groupsList);

      const resultsSection = document.createElement("div");
      resultsSection.className = "rhbc-section";
      resultsSection.style.display = "none";
      resultsSection.innerHTML = `<div class="rhbc-title" style="color:#a9d8a9">结果图（已保存到 output 目录，点击放大）</div>`;
      const resultsGrid = document.createElement("div");
      resultsGrid.className = "rhbc-results";
      resultsSection.appendChild(resultsGrid);

      root.append(batchSection, runSection, groupsSection, resultsSection);

      const widget = node.addDOMWidget("rh_banana_concurrent_ui", "RH_BANANA_CONCURRENT", root, {
        serialize: false, getValue: () => "", setValue: () => {},
      });
      hideWidget(node, DATA_WIDGET);

      // 高度策略（防反馈循环）：computeSize 返回常量，不读 node.size；
      // 节点右下角拖拽拉伸时由 onResize 直接设置 DOM 高度。
      const RHC_MIN_VIEW = 320;
      const RHC_SHELL = 205;
      // 界面高度持久化：保存到 properties，任何重渲染都强制拉回，杜绝内容撑爆
      node.properties.rhcUiH = Math.max(RHC_MIN_VIEW,
        Number(node.properties.rhcUiH) || 640);
      const updateRhcHeight = (n) => {
        const h = Math.max(RHC_MIN_VIEW, Number(n.properties?.rhcUiH) || 640);
        n.properties.rhcUiH = h;
        root.style.height = `${h}px`;
        root.style.minHeight = `${RHC_MIN_VIEW}px`;
      };
      widget.computeSize = () => [680, RHC_MIN_VIEW];
      node.min_size = [Math.max(node.min_size?.[0] || 0, 680), RHC_MIN_VIEW + RHC_SHELL];
      node.onResize = function () {
        this.properties.rhcUiH = Math.max(RHC_MIN_VIEW,
          Math.round((this.size?.[1] || 0) - RHC_SHELL));
        updateRhcHeight(this);
        this.graph?.setDirtyCanvas?.(true, true);
      };
      node._rhcUpdateHeight = () => updateRhcHeight(node);
      updateRhcHeight(node);
      // 新建节点默认尺寸：宽度必须容纳两个300px批量槽，避免内容横向溢出
      if (!node.size || (node.size[0] || 0) < 680) {
        node.size = [680, (node.properties.rhcUiH || 640) + 205];
      }
      // 防膨胀哨兵：界面切换/重渲染导致 DOM 高度漂移时立即强制拉回
      const rhcRo = new ResizeObserver(() => {
        const cur = root.getBoundingClientRect().height;
        const target = Number(node.properties.rhcUiH) || 640;
        if (Math.abs(cur - target) > 2) root.style.height = `${target}px`;
      });
      rhcRo.observe(root);
      app.graph?.setDirtyCanvas?.(true, true);

      // 文件拖放接管：在窗口捕获阶段处理节点区域内的拖放，
      // 优先级高于 ComfyUI 全局的文件拖放拦截
      const boxAt = (x, y) => {
        for (const b of root.querySelectorAll(".rhbc-box")) {
          const r = b.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return b;
        }
        return null;
      };
      const insideRoot = (e) => {
        const r = root.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right
          && e.clientY >= r.top && e.clientY <= r.bottom;
      };
      window.addEventListener("dragover", (e) => {
        if (!insideRoot(e) || !Array.from(e.dataTransfer?.types || []).includes("Files")) return;
        e.preventDefault(); e.stopPropagation();
        const box = boxAt(e.clientX, e.clientY);
        root.querySelectorAll(".rhbc-box").forEach((b) =>
          b.classList.toggle("rhbc-dragover", b === box));
      }, true);
      window.addEventListener("drop", (e) => {
        if (!insideRoot(e) || !Array.from(e.dataTransfer?.types || []).includes("Files")) return;
        e.preventDefault(); e.stopPropagation();
        const box = boxAt(e.clientX, e.clientY);
        root.querySelectorAll(".rhbc-box").forEach((b) => b.classList.remove("rhbc-dragover"));
        box?._rhcUpload?.(e.dataTransfer.files);
      }, true);

      const count = () => node.properties.rhcCount || 1;
      const activeGroups = () => (node._rhcGroups || []).slice(0, count());
      const validGroups = () => activeGroups().filter(
        (g) => (g.image1 || g.image2) && (g.prompt || "").trim());

      function syncData() {
        const dataWidget = findWidget(node, DATA_WIDGET);
        const payload = activeGroups().map((g) => ({
          image1: g.image1, image2: g.image2, prompt: g.prompt || "",
        }));
        if (dataWidget) dataWidget.value = JSON.stringify(payload);
        node.properties ||= {};
        node.properties.rhcGroups = (node._rhcGroups || []).map((g) => ({
          image1: g.image1, image2: g.image2, prompt: g.prompt || "",
        }));
        node.properties.rhcCount = count();
        node.graph?.setDirtyCanvas?.(true, true);
      }

      function refreshSummary() {
        const items = activeGroups();
        const valid = validGroups().length;
        groupsTitle.textContent =
          `分组列表（使用 ${items.length} 组 · 已填好 ${valid} 组 · 只提交已填好的组 · 拖动卡片可自由摆放）`;
      }

      // ---- 图片槽：上传 / 跨组拖拽配对（交换）/ 删除 ----
      // 点击=聚焦打字；按住拖动超过阈值=切换为移动整个节点
      function editableWithNodeDrag(textarea) {
        textarea.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          const startX = e.clientX, startY = e.clientY;
          let dragging = false, lastX = 0, lastY = 0;
          const onMove = (ev) => {
            if (!dragging) {
              if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= 5) return;
              dragging = true;
              lastX = ev.clientX; lastY = ev.clientY;
              textarea.blur();
            }
            ev.preventDefault();
            const scale = app.canvas?.ds?.scale || 1;
            node.pos[0] += (ev.clientX - lastX) / scale;
            node.pos[1] += (ev.clientY - lastY) / scale;
            lastX = ev.clientX; lastY = ev.clientY;
            app.canvas.setDirty(true, true);
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        });
      }

      function makeSlot(group, key, label, groupIndex, compact) {
        const slot = document.createElement("div");
        slot.className = "rhbc-slot";
        if (compact) slot.style.width = "146px";
        const box = document.createElement("div");
        box.className = "rhbc-box";
        const render = () => {
          box.innerHTML = "";
          if (group[key]) {
            const img = document.createElement("img");
            img.src = thumbUrl(group[key]);
            img.title = "按住拖到其他槽位可交换配对";
            box.appendChild(img);
            const del = document.createElement("button");
            del.className = "rhbc-x";
            del.textContent = "✕";
            del.title = "移除";
            del.addEventListener("click", (e) => {
              e.stopPropagation();
              group[key] = null;
              syncData(); render();
            });
            box.appendChild(del);
          } else {
            box.appendChild(document.createTextNode(`上传${label}`));
          }
        };
        render();
        const uploadFromFile = async (file) => {
          if (!file || !isImageFile(file)) return;
          box.textContent = "上传中…";
          try {
            group[key] = await uploadImage(file);
            syncData(); render();
          } catch (err) {
            box.textContent = "失败";
            console.error("[RH大香蕉并发]", err);
          }
        };
        box._rhcUpload = (files) => uploadFromFile(files?.[0]);
        box.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.addEventListener("change", () => uploadFromFile(input.files?.[0]));
          input.click();
        });
        // 图片配对拖拽：已上传的图可拖到其他槽位（交换）；外部文件拖入=上传
        box.addEventListener("dragstart", (e) => {
          if (!group[key]) { e.preventDefault(); return; }
          e.stopPropagation();
          const payload = JSON.stringify(groupIndex == null
            ? { batch: true, key }
            : { index: groupIndex, key });
          e.dataTransfer.setData("application/x-rhc-pair", payload);
          e.dataTransfer.effectAllowed = "copyMove";
        });
        box.addEventListener("dragover", (e) => {
          e.preventDefault(); e.stopPropagation();
          box.classList.add("rhbc-dragover");
        });
        box.addEventListener("dragleave", () => box.classList.remove("rhbc-dragover"));
        box.addEventListener("drop", (e) => {
          e.preventDefault(); e.stopPropagation();
          box.classList.remove("rhbc-dragover");
          const internal = e.dataTransfer?.getData("application/x-rhc-pair");
          if (internal) {
            try {
              const src = JSON.parse(internal);
              const srcGroup = src.batch ? node._rhcBatch
                : (node._rhcGroups || [])[src.index];
              if (!srcGroup) return;
              const tmp = group[key];
              group[key] = srcGroup[src.key];
              srcGroup[src.key] = tmp;
              syncData();
              node._rhcRender?.();
            } catch { /* ignore */ }
            return;
          }
          uploadFromFile(e.dataTransfer?.files?.[0]);
        });
        const labelEl = document.createElement("div");
        labelEl.className = "rhbc-slot-label";
        labelEl.textContent = label;
        slot.append(box);
        if (!compact) slot.appendChild(labelEl);
        return slot;
      }

      // ---- 批量填入组 ----
      const batchGroup = { image1: null, image2: null, prompt: "" };
      node._rhcBatch = batchGroup;
      function createBatchSlot(key, label) {
        const slot = document.createElement("div");
        slot.className = "rhbc-slot";
        slot.style.width = "300px";
        const box = document.createElement("div");
        box.className = "rhbc-box";
        const render = () => {
          box.innerHTML = "";
          const list = batchGroup[key + "List"] || [];
          if (list.length) {
            const img = document.createElement("img");
            img.src = thumbUrl(list[0]);
            box.appendChild(img);
            const badge = document.createElement("div");
            badge.className = "rhbc-badge";
            badge.textContent = `${list.length} 张·已自动填入`;
            badge.title = list.map((r) => r.filename).join("\n");
            box.appendChild(badge);
            const del = document.createElement("button");
            del.className = "rhbc-x";
            del.textContent = "✕";
            del.title = "清空（不影响已填入的分组）";
            del.addEventListener("click", (e) => {
              e.stopPropagation();
              batchGroup[key] = null;
              batchGroup[key + "List"] = [];
              syncData(); render();
            });
            box.appendChild(del);
          } else {
            box.appendChild(document.createTextNode(`拖入或点击上传${label}`));
          }
        };
        node._rhcBatchRenders = node._rhcBatchRenders || {};
        node._rhcBatchRenders[key] = render;
        render();
        const uploadFiles = async (files) => {
          const imageFiles = Array.from(files).filter(isImageFile);
          if (!imageFiles.length) return;
          const refs = [];
          for (let i = 0; i < imageFiles.length; i++) {
            box.textContent = `上传中 ${i}/${imageFiles.length}…`;
            try { refs.push(await uploadImage(imageFiles[i])); }
            catch (err) { console.error("[RH大香蕉并发]", err); }
          }
          if (!refs.length) { render(); return; }
          batchGroup[key + "List"] = refs;
          batchGroup[key] = refs[0];
          // 按顺序自动同步批量填入到下方分组（拖多少张填多少组）
          const items = node._rhcGroups || [];
          refs.forEach((ref, i) => {
            if (i >= MAX_GROUPS) return;
            while (items.length < i + 1) items.push({ image1: null, image2: null, prompt: "" });
            items[i][key] = { ...ref };
          });
          node.properties.rhcCount = Math.min(MAX_GROUPS,
            Math.max(count(), refs.length));
          if (node._rhcCountInput) node._rhcCountInput.value = String(node.properties.rhcCount);
          syncData(); render(); renderGroups(); refreshSummary();
        };
        box._rhcUpload = (files) => uploadFiles(files);
        box.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "file"; input.accept = "image/*"; input.multiple = true;
          input.addEventListener("change", () => uploadFiles(input.files));
          input.click();
        });
        box.addEventListener("dragover", (e) => {
          e.preventDefault(); e.stopPropagation(); box.classList.add("rhbc-dragover");
        });
        box.addEventListener("dragleave", () => box.classList.remove("rhbc-dragover"));
        box.addEventListener("drop", (e) => {
          e.preventDefault(); e.stopPropagation();
          box.classList.remove("rhbc-dragover");
          uploadFiles(e.dataTransfer?.files);
        });
        const labelEl = document.createElement("div");
        labelEl.className = "rhbc-slot-label";
        labelEl.textContent = label + "（可一次拖入多张，按顺序自动填入各组）";
        slot.append(box);
        slot.appendChild(labelEl);
        return slot;
      }
      batchSlots.append(createBatchSlot("image1", "图一"), createBatchSlot("image2", "图二"));
      batchPrompt.addEventListener("input", () => { batchGroup.prompt = batchPrompt.value; });
      editableWithNodeDrag(batchPrompt);

      // 图片拖入时已自动按顺序填入；此按钮只负责同步提示词
      syncBtn.addEventListener("click", () => {
        const p = (batchGroup.prompt || "").trim();
        if (!p) {
          hint.textContent = "批量提示词为空";
          return;
        }
        activeGroups().forEach((g) => { g.prompt = p; });
        syncData(); renderGroups(); refreshSummary();
        hint.textContent = "提示词已同步到全部分组";
      });

      // 一键清空所有组：全部100组+批量槽位列表，清掉的数据不会回来
      clearAllBtn.addEventListener("click", () => {
        const filled = validGroups().length;
        if (!confirm(`确定清空全部 ${MAX_GROUPS} 组的图片和提示词吗？\n（包括当前未显示的隐藏组，共 ${filled} 组已填好内容将被清除）`)) return;
        node._rhcGroups = emptyGroups();
        node._rhcBatch.image1 = null;
        node._rhcBatch.image2 = null;
        node._rhcBatch.image1List = [];
        node._rhcBatch.image2List = [];
        Object.values(node._rhcBatchRenders || {}).forEach((r) => r());
        syncData(); renderGroups(); refreshSummary();
        hint.textContent = "已清空全部组";
      });

      // ---- 分组卡片：竖列网格（每列10组）；鼠标穿透，画布操作不受影响 ----
      // 分组区的滚轮转发给画布：悬停在图片框/提示词框上滚轮也能缩放画布
      function forwardWheel(el) {
        el.addEventListener("wheel", (e) => {
          e.preventDefault(); e.stopPropagation();
          const canvas = app.canvas?.canvas;
          if (!canvas) return;
          canvas.dispatchEvent(new WheelEvent("wheel", {
            deltaY: e.deltaY, deltaMode: e.deltaMode,
            clientX: e.clientX, clientY: e.clientY,
            screenX: e.screenX, screenY: e.screenY,
            bubbles: true, cancelable: true,
          }));
        }, { passive: false });
      }

      function renderGroups() {
        groupsList.innerHTML = "";
        const items = activeGroups();
        items.forEach((group, index) => {
          const card = document.createElement("div");
          card.className = "rhbc-group";

          const num = document.createElement("div");
          num.className = "rhbc-num";
          num.textContent = String(index + 1);
          card.appendChild(num);

          const slots = document.createElement("div");
          slots.className = "rhbc-slots-in";
          slots.append(
            makeSlot(group, "image1", "图一", index, true),
            makeSlot(group, "image2", "图二", index, true));
          card.appendChild(slots);

          const promptWrap = document.createElement("div");
          promptWrap.className = "rhbc-prompt";
          const promptInput = document.createElement("textarea");
          promptInput.value = group.prompt || "";
          promptInput.placeholder = `第 ${index + 1} 组提示词（提示词在上方批量组填入后同步）`;
          promptInput.addEventListener("input", () => { group.prompt = promptInput.value; });
          editableWithNodeDrag(promptInput);
          promptWrap.appendChild(promptInput);
          forwardWheel(promptInput);
          card.appendChild(promptWrap);
          card.querySelectorAll(".rhbc-box").forEach((b) => forwardWheel(b));

          groupsList.appendChild(card);
        });
      }

      countInput.addEventListener("change", () => {
        let v = Math.max(1, Math.min(MAX_GROUPS, Number(countInput.value) || 1));
        countInput.value = String(v);
        node.properties.rhcCount = v;
        while ((node._rhcGroups || []).length < v) {
          node._rhcGroups.push({ image1: null, image2: null, prompt: "" });
        }
        syncData(); renderGroups(); refreshSummary();
      });

      // ---- 开始并发提交 ----
      runBtn.addEventListener("click", async () => {
        const groups = validGroups();
        if (!groups.length) {
          statusEl.textContent = "没有可提交的分组（每组至少1张图+提示词）";
          statusEl.style.color = "#e57373";
          return;
        }
        const apiKey = String(findWidget(node, "API_KEY")?.value ?? "").trim();
        if (!apiKey) {
          statusEl.textContent = "请先填写 API_KEY";
          statusEl.style.color = "#e57373";
          return;
        }
        const readWidget = (name) => findWidget(node, name)?.value;
        runBtn.disabled = true;
        progressBar.style.width = "0%";
        statusEl.style.color = "#8d99ab";
        statusEl.textContent = "提交中…";
        resultsSection.style.display = "none";
        resultsGrid.innerHTML = "";

        try {
          const payload = {
            API_KEY: apiKey,
            channel: readWidget("channel") || "官方稳定版",
            aspectRatio: readWidget("aspectRatio") || "auto",
            resolution: readWidget("resolution") || "4k",
            skip_error: readWidget("skip_error") === true,
            concurrency: Number(readWidget("concurrency") || 5),
            max_long_edge: 2048,
            groups,
          };
          const response = await fetch("/my-comfnode/rh-banana-concurrent/start", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await response.json();
          if (!data.ok) throw new Error(data.error || "提交失败");
          const total = data.total;
          const jobId = data.job_id;
          statusEl.textContent = `已排队：${total} 组并发处理中`;

          await new Promise((resolve, reject) => {
            const timer = setInterval(async () => {
              try {
                const s = await (await fetch(`/my-comfnode/rh-banana-concurrent/status/${jobId}`)).json();
                const done = s.done || 0;
                progressBar.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
                statusEl.textContent = `并发处理中：${done} / ${total}`;
                if (s.status === "SUCCESS" || s.status === "ERROR") {
                  clearInterval(timer);
                  resolve(s);
                }
              } catch (err) { clearInterval(timer); reject(err); }
            }, 1500);
          });

          const s = await (await fetch(`/my-comfnode/rh-banana-concurrent/status/${jobId}`)).json();
          const results = Object.values(s.results || {});
          const ok = results.filter((r) => r.status === "SUCCESS");
          const bad = results.filter((r) => r.status === "ERROR");
          progressBar.style.width = "100%";
          statusEl.style.color = bad.length ? "#e5c073" : "#7ab87a";
          statusEl.textContent = `完成：成功 ${ok.length} 张 / 失败 ${bad.length} 张`
            + (s.error ? ` · ${s.error}` : "");
          if (ok.length) {
            resultsSection.style.display = "block";
            resultsGrid.innerHTML = "";
            ok.sort((a, b) => a.index - b.index).forEach((r) => {
              const img = document.createElement("img");
              img.src = outputViewUrl(r.image);
              img.title = `第 ${r.index + 1} 组结果`;
              img.addEventListener("click", () => window.open(outputViewUrl(r.image), "_blank"));
              resultsGrid.appendChild(img);
            });
          }
        } catch (err) {
          statusEl.textContent = String(err?.message || err);
          statusEl.style.color = "#e57373";
        } finally {
          runBtn.disabled = false;
        }
      });

      const originalSerialize = node.onSerialize;
      node.onSerialize = function (info) {
        syncData();
        return originalSerialize?.apply?.(this, arguments);
      };

      node._rhcRender = () => { renderGroups(); refreshSummary(); };
      node._rhcRender();
      syncData();

      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = originalOnConfigure?.apply?.(this, arguments);
      this.properties ||= {};
      const items = this.properties.rhcGroups;
      this._rhcGroups = Array.isArray(items) && items.length
        ? items : emptyGroups();
      while (this._rhcGroups.length < MAX_GROUPS) {
        this._rhcGroups.push({ image1: null, image2: null, prompt: "" });
      }
      // 界面高度持久化恢复：无论保存时节点多大，载入一律回到设定高度
      this.properties.rhcUiH = Math.max(320, Number(this.properties.rhcUiH) || 640);
      this.size[0] = Math.max(this.size?.[0] || 0, 680);
      this.size[1] = this.properties.rhcUiH + 205;
      if (this._rhcUpdateHeight) this._rhcUpdateHeight();
      this.properties.rhcCount = Math.max(1, Math.min(100,
        Number(this.properties.rhcCount) || 1));
      if (this._rhcCountInput) {
        this._rhcCountInput.value = String(this.properties.rhcCount);
      }
      if (this._rhcRender) this._rhcRender();
      const dataWidget = findWidget(this, DATA_WIDGET);
      if (dataWidget) dataWidget.value = JSON.stringify(this._rhcGroups.map((g) => ({
        image1: g.image1, image2: g.image2, prompt: g.prompt || "",
      })));
      return result;
    };
  },
});
