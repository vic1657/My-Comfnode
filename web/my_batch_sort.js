// MY图片批量排序 - 前端界面
// 横向卡片条：[批量载入(红框)] + 每张图一个卡片（缩略图+文件名），卡片下方对应一个图片输出口
// 拖入/点击批量载入，多选；按文件名自然排序（E001、E002…E010 从左到右）
// 输出口数量 = 图片数量，输出原图原尺寸
import { app } from "../../scripts/app.js";

const NODE_CLASS = "MYBatchSort";
const DATA_WIDGET = "sort_data";
const SUBFOLDER = "my_batch_sort";
const MAX_OUTPUTS = 100;

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
  // name=原始文件名（显示与排序用）；filename=唯一存储名（防止同名不同图互相覆盖）
  return { filename: data.name, subfolder: data.subfolder || SUBFOLDER,
    type: data.type || "input", name: file.name };
}

function thumbUrl(ref) {
  if (!ref?.filename) return "";
  const params = new URLSearchParams({
    filename: ref.filename, subfolder: ref.subfolder || "", type: ref.type || "input",
  });
  return `/my-comfnode/rh-banana-concurrent/thumb?${params.toString()}`;
}

function naturalLess(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }) < 0;
}

function injectStyles() {
  if (document.getElementById("mbs-style")) return;
  const style = document.createElement("style");
  style.id = "mbs-style";
  style.textContent = `
.mbs-wrap { display:flex; flex-direction:column; gap:6px; width:100%; font-size:12px; color:#d8dce3; }
.mbs-bar { display:flex; gap:8px; align-items:center; }
.mbs-title { color:#a9d8a9; font-weight:600; font-size:12px; }
.mbs-hint { margin-left:auto; color:#8d99ab; font-size:11px; }
.mbs-strip { display:flex; gap:10px; align-items:stretch; overflow-x:auto;
  padding:8px; background:#1d2026; border:1px solid #3d4450; border-radius:8px; min-height:180px; }
.mbs-load { flex-shrink:0; width:130px; border:2px dashed #c76a6a; border-radius:8px;
  background:#2b2124; color:#d8a0a0; display:flex; align-items:center; justify-content:center;
  text-align:center; cursor:pointer; font-size:12px; padding:6px; }
.mbs-load:hover { border-color:#e57373; color:#ffb3b3; }
.mbs-card { position:relative; flex-shrink:0; width:126px; background:#22262e;
  border:1px solid #3d4450; border-radius:8px; padding:5px; }
.mbs-card img { width:100%; height:114px; object-fit:contain; background:#0d0f13;
  border-radius:5px; display:block; }
.mbs-name { margin-top:4px; font-size:10px; color:#c3cad4; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; text-align:center; }
.mbs-idx { position:absolute; top:8px; left:8px; min-width:18px; height:18px; padding:0 4px;
  border-radius:9px; background:rgba(15,18,24,.85); color:#ffd479; font-size:10px;
  display:flex; align-items:center; justify-content:center; z-index:2; }
.mbs-x { position:absolute; top:8px; right:8px; width:17px; height:17px; border:none;
  border-radius:50%; background:rgba(15,18,24,.85); color:#aab2bf; font-size:10px;
  cursor:pointer; display:none; align-items:center; justify-content:center; padding:0; z-index:2; }
.mbs-card:hover .mbs-x { display:flex; }
.mbs-x:hover { color:#ff8a80; }
.mbs-up { color:#8d99ab; font-size:10px; text-align:center; margin-top:4px; }
`;
  document.head.appendChild(style);
}

function normalizeRefs(raw) {
  let payload = raw;
  try {
    payload = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
  } catch { payload = []; }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    payload = payload.items || [];
  }
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((it) => it && it.filename)
    .map((it) => ({
      filename: String(it.filename || "").replace(/\\/g, "/"),
      subfolder: String(it.subfolder || SUBFOLDER).replace(/\\/g, "/"),
      type: String(it.type || "input"),
      name: String(it.name || it.filename || ""),
    }))
    .slice(0, MAX_OUTPUTS);
}

app.registerExtension({
  name: "MyComfnode.MYBatchSort.V1",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      const node = this;
      node.properties ||= {};
      node.properties.mbsRefs = normalizeRefs(node.properties.mbsRefs);
      node._mbsRefs = node.properties.mbsRefs.slice();

      injectStyles();

      const root = document.createElement("div");
      root.className = "mbs-wrap";

      const bar = document.createElement("div");
      bar.className = "mbs-bar";
      const title = document.createElement("span");
      title.className = "mbs-title";
      title.textContent = "MY图片批量排序";
      const hint = document.createElement("span");
      hint.className = "mbs-hint";
      hint.textContent = "按文件名排序 · 每张图一个输出口（原图原尺寸）";
      const clearBtn = document.createElement("button");
      clearBtn.className = "rhbc-btn";
      clearBtn.textContent = "清空";
      clearBtn.title = "清空所有已载入的图片";
      clearBtn.addEventListener("click", () => {
        if (!(node._mbsRefs || []).length) return;
        node._mbsRefs = [];
        syncData(); syncOutputs(); render(); refreshSummary();
      });
      bar.append(title, clearBtn, hint);

      const strip = document.createElement("div");
      strip.className = "mbs-strip";
      root.append(bar, strip);

      const widget = node.addDOMWidget("my_batch_sort_ui", "MY_BATCH_SORT", root, {
        serialize: false, getValue: () => "", setValue: () => {},
      });
      widget.computeSize = () => [900, 232];
      hideWidget(node, DATA_WIDGET);

      // 输出口固定 10 个（图1~图10）：不随图片数量/清除/更换变化
      const FIXED_OUTPUTS = 10;
      function syncOutputs() {
        while (node.outputs.length > FIXED_OUTPUTS) {
          node.removeOutput(node.outputs.length - 1);
        }
        while (node.outputs.length < FIXED_OUTPUTS) {
          node.addOutput(`图${node.outputs.length + 1}`, "IMAGE");
        }
        node.outputs.forEach((o, idx) => {
          o.name = `图${idx + 1}`;
          o.type = "IMAGE";
        });
      }

      function syncData() {
        const dataWidget = findWidget(node, DATA_WIDGET);
        const payload = (node._mbsRefs || []).map((r) => ({
          filename: r.filename, subfolder: r.subfolder || SUBFOLDER,
          type: r.type || "input", name: r.name || r.filename,
        }));
        if (dataWidget) dataWidget.value = JSON.stringify(payload);
        node.properties ||= {};
        node.properties.mbsRefs = payload;
        node.graph?.setDirtyCanvas?.(true, true);
      }

      function refreshSummary() {
        const n = (node._mbsRefs || []).length;
        hint.textContent = n
          ? `已载入 ${n} 张 · 按文件名排序 · 输出口固定10个（排序前10张对应图1~图10）`
          : "拖入或点击红框批量载入（可多选）";
      }

      function render() {
        strip.innerHTML = "";
        const loadBox = document.createElement("div");
        loadBox.className = "mbs-load";
        loadBox.textContent = "批量载入";
        loadBox.title = "点击选择或直接拖入图片（可多选）";
        const startUpload = async (files) => {
          const imageFiles = Array.from(files).filter(isImageFile);
          if (!imageFiles.length) return;
          loadBox.textContent = `上传中 0/${imageFiles.length}…`;
          const uploaded = [];
          for (let i = 0; i < imageFiles.length; i++) {
            loadBox.textContent = `上传中 ${i}/${imageFiles.length}…`;
            try {
              uploaded.push(await uploadImage(imageFiles[i]));
            } catch (err) {
              console.error("[MY图片批量排序]", err);
            }
          }
          // 合并后按文件名自然排序（E001、E002…E010 从左到右）
          const items = (node._mbsRefs || []).concat(uploaded);
          items.sort((a, b) => {
            const an = (a.name || a.filename).toLowerCase();
            const bn = (b.name || b.filename).toLowerCase();
            return naturalLess(an, bn) ? -1 : naturalLess(bn, an) ? 1 : 0;
          });
          node._mbsRefs = items.slice(0, MAX_OUTPUTS);
          syncData(); syncOutputs(); render(); refreshSummary();
        };
        loadBox.addEventListener("click", () => {
          const input = document.createElement("input");
          input.type = "file"; input.accept = "image/*"; input.multiple = true;
          input.addEventListener("change", () => startUpload(input.files));
          input.click();
        });
        loadBox.addEventListener("dragover", (e) => {
          e.preventDefault(); e.stopPropagation();
          loadBox.style.borderColor = "#e57373";
        });
        loadBox.addEventListener("dragleave", () => { loadBox.style.borderColor = ""; });
        loadBox.addEventListener("drop", (e) => {
          e.preventDefault(); e.stopPropagation();
          loadBox.style.borderColor = "";
          startUpload(e.dataTransfer?.files);
        });
        strip.appendChild(loadBox);

        (node._mbsRefs || []).forEach((ref, index) => {
          const card = document.createElement("div");
          card.className = "mbs-card";
          const idx = document.createElement("span");
          idx.className = "mbs-idx";
          idx.textContent = String(index + 1);
          card.appendChild(idx);
          const img = document.createElement("img");
          img.src = thumbUrl(ref);
          img.title = ref.filename;
          card.appendChild(img);
          const name = document.createElement("div");
          name.className = "mbs-name";
          name.textContent = ref.name || ref.filename;
          card.appendChild(name);
          const del = document.createElement("button");
          del.className = "mbs-x";
          del.textContent = "✕";
          del.title = "移除";
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            node._mbsRefs.splice(index, 1);
            syncData(); syncOutputs(); render(); refreshSummary();
          });
          card.appendChild(del);
          strip.appendChild(card);
        });
        app.graph?.setDirtyCanvas?.(true, true);
      }

      const originalSerialize = node.onSerialize;
      node.onSerialize = function (info) {
        syncData();
        return originalSerialize?.apply?.(this, arguments);
      };

      node._mbsSyncOutputs = syncOutputs;
      node._mbsRender = () => { render(); refreshSummary(); };
      syncOutputs();
      node._mbsRender();
      syncData();

      // 新建节点默认宽度（容纳批量载入框+若干卡片）
      if (!node.size || (node.size[0] || 0) < 900) {
        node.size = [900, 280];
      }

      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = originalOnConfigure?.apply?.(this, arguments);
      this.properties ||= {};
      this.properties.mbsRefs = normalizeRefs(this.properties.mbsRefs);
      this._mbsRefs = this.properties.mbsRefs.slice();
      if (this._mbsSyncOutputs) this._mbsSyncOutputs();
      if (this._mbsRender) this._mbsRender();
      const dataWidget = findWidget(this, DATA_WIDGET);
      if (dataWidget) dataWidget.value = JSON.stringify(this._mbsRefs);
      return result;
    };
  },
});
