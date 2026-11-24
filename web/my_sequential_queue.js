// MY逐张队列 - 前端界面 v2
// 并排瓦片布局：缩略图方块 + 序号角标 + 勾选角标，横向排列自动换行
// 拖动瓦片重排序；勾选后点 ComfyUI 原生运行按钮，勾选图片按顺序逐张输出
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "MYSequentialQueue";
const DATA_WIDGET = "queue_data";
const SUBFOLDER = "my_queue";

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
  if (!response.ok) throw new Error(`上传失败(${response.status}): ${file.name}`);
  const data = await response.json();
  return {
    filename: data.name,
    subfolder: data.subfolder || SUBFOLDER,
    type: data.type || "input",
  };
}

function viewUrl(item) {
  // 用服务端生成的 256px 缩略图，几十张大图也不卡（执行时才解码原尺寸）
  const params = new URLSearchParams({
    filename: item.filename,
    subfolder: item.subfolder || "",
    type: item.type || "input",
  });
  return `/my_queue_thumb?${params.toString()}`;
}

function injectStyles() {
  if (document.getElementById("myq2-style")) return;
  const style = document.createElement("style");
  style.id = "myq2-style";
  style.textContent = `
.myq2-wrap { display:flex; flex-direction:column; gap:6px; width:100%; font-size:12px; color:#d8dce3; }
.myq2-bar { display:flex; gap:6px; align-items:center; }
.myq2-btn { background:#333945; color:#e6e9ee; border:1px solid #4c5462; border-radius:6px;
  padding:3px 12px; cursor:pointer; font-size:12px; }
.myq2-btn:hover { background:#3f4756; }
.myq2-btn.myq2-danger { background:#4b2f36; border-color:#6e4550; }
.myq2-btn.myq2-danger:hover { background:#5c3941; }
.myq2-hint { margin-left:auto; color:#8d99ab; font-size:11px; }
.myq2-drop { border:1.5px dashed #4d5766; border-radius:8px; padding:9px 6px; text-align:center;
  color:#7f8b9d; background:#22262e; cursor:pointer; font-size:12px; }
.myq2-drop.myq2-over { border-color:#6fbf8f; color:#a5dcb8; background:#263129; }
.myq2-grid { display:flex; flex-wrap:wrap; gap:8px; align-content:flex-start;
  max-height:356px; overflow-y:auto; overflow-x:hidden; }
.myq2-tile { position:relative; width:92px; border-radius:8px; background:#262b34;
  border:2px solid #3a4150; padding:4px; cursor:grab; user-select:none; }
.myq2-tile.myq2-on { border-color:#4f9d6e; background:#233129; }
.myq2-tile.myq2-off { opacity:.55; }
.myq2-tile.myq2-drag { opacity:.35; }
.myq2-tile.myq2-ins { box-shadow:0 0 0 2px #6fbf8f; }
.myq2-tile img { width:100%; height:74px; object-fit:cover; border-radius:5px; display:block; background:#171a20; }
.myq2-badge { position:absolute; top:7px; left:7px; min-width:18px; height:18px; padding:0 4px;
  border-radius:9px; background:rgba(15,18,24,.85); color:#ffd479; font-size:11px; font-weight:600;
  display:flex; align-items:center; justify-content:center; }
.myq2-tile.myq2-off .myq2-badge { color:#8d99ab; }
.myq2-check { position:absolute; top:7px; right:7px; width:15px; height:15px;
  accent-color:#4f9d6e; cursor:pointer; }
.myq2-cap { margin-top:3px; font-size:10px; color:#c3cad4; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; text-align:center; }
.myq2-x { position:absolute; bottom:22px; right:6px; width:18px; height:18px; border:none; border-radius:50%;
  background:rgba(15,18,24,.8); color:#aab2bf; font-size:10px; cursor:pointer; display:none;
  align-items:center; justify-content:center; padding:0; }
.myq2-tile:hover .myq2-x { display:flex; }
.myq2-x:hover { color:#ff8a80; }
.myq2-uploading { width:100%; height:74px; display:flex; align-items:center; justify-content:center;
  color:#8d99ab; font-size:11px; background:#171a20; border-radius:5px; }
`;
  document.head.appendChild(style);
}

function normalizeItems(raw) {
  let payload = raw;
  try {
    payload = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
  } catch { payload = []; }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    payload = payload.items || [];
  }
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((it) => it && (it.filename || it.name))
    .map((it) => ({
      filename: String(it.filename || "").replace(/\\/g, "/"),
      subfolder: String(it.subfolder || SUBFOLDER).replace(/\\/g, "/"),
      type: String(it.type || "input"),
      name: String(it.name || it.filename || ""),
      checked: it.checked === true,
    }))
    .filter((it) => it.filename);
}

app.registerExtension({
  name: "MyComfnode.MYSequentialQueue.V2",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      const node = this;
      node.properties ||= {};
      node.properties.myQueueItems = normalizeItems(node.properties.myQueueItems);
      node._myqItems = node.properties.myQueueItems.slice();
      node._myqDragFrom = null;

      injectStyles();

      const root = document.createElement("div");
      root.className = "myq2-wrap";

      const bar = document.createElement("div");
      bar.className = "myq2-bar";
      const selectAllBtn = document.createElement("button");
      selectAllBtn.className = "myq2-btn";
      selectAllBtn.textContent = "全选";
      const clearBtn = document.createElement("button");
      clearBtn.className = "myq2-btn myq2-danger";
      clearBtn.textContent = "清除";
      const hint = document.createElement("span");
      hint.className = "myq2-hint";
      hint.textContent = "点一次运行，勾选图片逐张输出";
      bar.append(selectAllBtn, clearBtn, hint);

      const dropZone = document.createElement("div");
      dropZone.className = "myq2-drop";
      dropZone.textContent = "拖拽图片到这里（可多张），点击可选择文件";

      const grid = document.createElement("div");
      grid.className = "myq2-grid";
      root.append(bar, dropZone, grid);

      const widget = node.addDOMWidget("my_sequential_queue_ui", "MY_SEQUENTIAL_QUEUE", root, {
        serialize: false,
        getValue: () => "",
        setValue: () => {},
      });
      hideWidget(node, DATA_WIDGET);
      hideWidget(node, "run_index");

      const checkedItems = () => (node._myqItems || []).filter((it) => it.checked && it.filename && !it.uploading && !it.error);

      function syncData() {
        const widgetData = findWidget(node, DATA_WIDGET);
        const payload = (node._myqItems || [])
          .filter((it) => it.filename)
          .map((it) => ({
            filename: it.filename,
            subfolder: it.subfolder || SUBFOLDER,
            type: it.type || "input",
            name: it.name || it.filename,
            checked: it.checked === true,
          }));
        if (widgetData) widgetData.value = JSON.stringify(payload);
        node.properties ||= {};
        node.properties.myQueueItems = payload;
        node.graph?.setDirtyCanvas?.(true, true);
      }

      function refreshSummary() {
        const items = node._myqItems || [];
        const checked = checkedItems().length;
        if (!items.length) {
          hint.textContent = "点一次运行，勾选图片逐张输出";
        } else {
          hint.textContent = `共 ${items.length} 张 · 勾选 ${checked} 张 · 逐张输出`;
        }
        selectAllBtn.textContent = items.length && checked === items.length ? "取消全选" : "全选";
      }

      function layoutHeight() {
        const items = node._myqItems || [];
        if (!items.length) return 120;
        // 高度封顶：超出的瓦片在网格内滚动（.myq2-grid overflow-y:auto）
        return Math.min(Math.ceil(items.length / 5) * 128 + 92, 480);
      }

      function render() {
        grid.innerHTML = "";
        const items = node._myqItems || [];
        items.forEach((item, index) => {
          const tile = document.createElement("div");
          tile.className = "myq2-tile " + (item.checked ? "myq2-on" : "myq2-off");
          tile.draggable = !item.uploading;
          tile.title = item.filename;

          if (item.uploading) {
            const ph = document.createElement("div");
            ph.className = "myq2-uploading";
            ph.textContent = "上传中…";
            tile.appendChild(ph);
          } else {
            const img = document.createElement("img");
            img.src = viewUrl(item);
            tile.appendChild(img);
          }

          const badge = document.createElement("span");
          badge.className = "myq2-badge";
          badge.textContent = String(index + 1);
          tile.appendChild(badge);

          const check = document.createElement("input");
          check.type = "checkbox";
          check.className = "myq2-check";
          check.checked = item.checked === true;
          check.title = "勾选后加入处理队列";
          check.addEventListener("change", () => {
            item.checked = check.checked;
            syncData();
            render();
            refreshSummary();
          });
          tile.appendChild(check);

          const caption = document.createElement("div");
          caption.className = "myq2-cap";
          caption.textContent = item.uploading ? "上传中…" : (item.name || item.filename);
          tile.appendChild(caption);

          const del = document.createElement("button");
          del.className = "myq2-x";
          del.textContent = "✕";
          del.title = "移除";
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            node._myqItems.splice(index, 1);
            syncData();
            render();
            refreshSummary();
          });
          tile.appendChild(del);

          // 拖动重排序（并排瓦片之间）
          tile.addEventListener("dragstart", (e) => {
            node._myqDragFrom = index;
            tile.classList.add("myq2-drag");
            e.dataTransfer.effectAllowed = "move";
            try { e.dataTransfer.setData("text/plain", String(index)); } catch {}
          });
          tile.addEventListener("dragend", () => {
            node._myqDragFrom = null;
            render();
          });
          tile.addEventListener("dragover", (e) => {
            if (node._myqDragFrom == null || node._myqDragFrom === index) return;
            e.preventDefault();
            e.stopPropagation();
            tile.classList.add("myq2-ins");
          });
          tile.addEventListener("dragleave", () => tile.classList.remove("myq2-ins"));
          tile.addEventListener("drop", (e) => {
            if (node._myqDragFrom == null) return; // 外部文件拖放交给节点级处理
            e.preventDefault();
            e.stopPropagation();
            const from = node._myqDragFrom;
            const to = index;
            if (from !== to) {
              const moved = node._myqItems.splice(from, 1)[0];
              node._myqItems.splice(to, 0, moved);
              syncData();
            }
            render();
            refreshSummary();
          });

          grid.appendChild(tile);
        });
        widget.computeSize = () => [0, layoutHeight()];
        app.graph?.setDirtyCanvas?.(true, true);
      }

      async function addFiles(files) {
        const imageFiles = Array.from(files).filter(isImageFile);
        if (!imageFiles.length) return;
        node._myqItems ||= [];
        const newItems = imageFiles.map((file) => ({
          filename: "",
          subfolder: SUBFOLDER,
          type: "input",
          name: file.name,
          checked: true,
          uploading: true,
          _file: file,
        }));
        node._myqItems.push(...newItems);
        syncData();
        render();
        refreshSummary();
        for (const item of newItems) {
          try {
            const uploaded = await uploadImage(item._file);
            item.filename = uploaded.filename;
            item.subfolder = uploaded.subfolder;
            item.type = uploaded.type;
            item.uploading = false;
          } catch (err) {
            item.uploading = false;
            item.error = String(err?.message || err);
            item.checked = false;
            console.error("[MY逐张队列]", err);
          }
          delete item._file;
          syncData();
          render();
          refreshSummary();
        }
      }

      dropZone.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "image/*";
        input.addEventListener("change", () => addFiles(input.files || []));
        input.click();
      });
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add("myq2-over");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("myq2-over"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        node._myqDragFrom = null;
        dropZone.classList.remove("myq2-over");
        if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
      });

      selectAllBtn.addEventListener("click", () => {
        const items = node._myqItems || [];
        if (!items.length) return;
        const allChecked = items.every((it) => it.checked);
        items.forEach((it) => { if (!it.uploading && !it.error) it.checked = !allChecked; });
        syncData();
        render();
        refreshSummary();
      });

      clearBtn.addEventListener("click", () => {
        node._myqItems = [];
        syncData();
        render();
        refreshSummary();
      });

      // ---- 进度提示 ----
      // 逐张续队由服务端完成（处理完一张自动把下一张塞回执行队列），
      // 前端只负责显示状态。
      api.addEventListener("executing", (event) => {
        if (String(event?.detail?.node) !== String(node.id)) return;
        const total = checkedItems().length;
        if (total) hint.textContent = `逐张处理中…（共勾选 ${total} 张，处理完一张自动接下一张）`;
      });
      api.addEventListener("execution_error", (event) => {
        const nid = String(event?.detail?.node_id ?? event?.detail?.node ?? "");
        if (nid === String(node.id)) {
          hint.textContent = "执行出错，请查看控制台";
          hint.style.color = "#e57373";
        }
      });

      // 节点整体也接受文件拖入
      const originalDragOver = node.onDragOver;
      node.onDragOver = function (event) {
        if (event?.dataTransfer?.types && Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault?.();
          return true;
        }
        return originalDragOver?.apply?.(this, arguments) ?? false;
      };
      const originalDragDrop = node.onDragDrop;
      node.onDragDrop = function (event) {
        const files = event?.dataTransfer?.files;
        if (files?.length && Array.from(files).some(isImageFile)) {
          event.preventDefault?.();
          addFiles(files);
          return true;
        }
        return originalDragDrop?.apply?.(this, arguments) ?? false;
      };

      const originalSerialize = node.onSerialize;
      node.onSerialize = function (info) {
        syncData();
        return originalSerialize?.apply?.(this, arguments);
      };

      node._myqRender = () => { render(); refreshSummary(); };
      node._myqRender();
      syncData();

      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = originalOnConfigure?.apply?.(this, arguments);
      this.properties ||= {};
      this.properties.myQueueItems = normalizeItems(this.properties.myQueueItems);
      this._myqItems = this.properties.myQueueItems.slice();
      if (this._myqRender) this._myqRender();
      const widgetData = findWidget(this, DATA_WIDGET);
      if (widgetData) widgetData.value = JSON.stringify(this.properties.myQueueItems);
      return result;
    };
  },
});
