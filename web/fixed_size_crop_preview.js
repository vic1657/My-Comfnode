import { app } from "../../scripts/app.js";

const PREVIEW_NODE_NAMES = new Set(["MyFixedSizeImageCrop", "MyFixedSizeImagePad"]);
const LOCALIZED_NODE_NAMES = new Set(["MyFixedSizeImageCrop", "MyFixedSizeImagePad", "MyCropBackgroundBorder"]);
const PREVIEW_DISPLAY_NAMES = new Set([
  "Fixed Size Image Crop",
  "Fixed Size Image Pad",
  "固定尺寸图像裁剪",
  "固定尺寸图像填充",
]);
const PRESETS = [
  { name: "1:1", width: 1024, height: 1024 },
  { name: "3:2", width: 768, height: 512 },
  { name: "4:3", width: 768, height: 576 },
  { name: "16:9", width: 768, height: 432 },
  { name: "2:3", width: 688, height: 1027 },
  { name: "3:4", width: 576, height: 768 },
  { name: "9:16", width: 576, height: 1024 },
];
const PRESET_NAMES = new Set(PRESETS.map((preset) => preset.name));
const AUTO_LABELS = new Set(["auto", "自动"]);
const WIDGET_LABELS = {
  size_preset: "尺寸预设",
  resolution_preset: "分辨率预设",
  crop_anchor: "裁剪锚点",
  upscale_method: "缩放方法",
  placement: "放置位置",
  fill_color: "填充颜色",
  background_color: "背景颜色",
  tolerance: "容差",
  padding: "保留边缘",
  custom_red: "自定义红",
  custom_green: "自定义绿",
  custom_blue: "自定义蓝",
  crop_x: "裁剪X",
  crop_y: "裁剪Y",
  crop_width: "裁剪宽度",
  crop_height: "裁剪高度",
};
const NODE_TITLE_LABELS = {
  MyFixedSizeImageCrop: "固定尺寸图像裁剪",
  MyFixedSizeImagePad: "固定尺寸图像填充",
};
const OLD_NODE_TITLES = new Set(["Fixed Size Image Crop", "Fixed Size Image Pad"]);
const SLOT_LABELS = {
  image: "图像",
  width: "宽度",
  height: "高度",
  selected_preset: "已选预设",
  crop_info: "裁剪信息",
  content_x: "内容X",
  content_y: "内容Y",
  content_width: "内容宽度",
  content_height: "内容高度",
  crop_x: "裁剪X",
  crop_y: "裁剪Y",
  crop_width: "裁剪宽度",
  crop_height: "裁剪高度",
};
const SLOT_NAMES_BY_LABEL = Object.fromEntries(Object.entries(SLOT_LABELS).map(([name, label]) => [label, name]));

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function selectedPreset(node) {
  const value = findWidget(node, "size_preset")?.value ?? "自动";
  if (AUTO_LABELS.has(value)) return "auto";
  return PRESETS.some((preset) => preset.name === value) ? value : "auto";
}

function localizeWidgets(node) {
  for (const widget of node.widgets ?? []) {
    const label = WIDGET_LABELS[widget.name];
    if (label) widget.label = label;
  }
}

function localizeNodeShell(node) {
  const title = NODE_TITLE_LABELS[node.comfyClass];
  if (title && (OLD_NODE_TITLES.has(node.title) || node.title === node.comfyClass)) node.title = title;
  for (const slot of [...(node.inputs ?? []), ...(node.outputs ?? [])]) {
    if (SLOT_NAMES_BY_LABEL[slot.name]) slot.name = SLOT_NAMES_BY_LABEL[slot.name];
    const label = SLOT_LABELS[slot.name];
    if (label) slot.label = label;
  }
}

function isPreviewNode(node) {
  return PREVIEW_NODE_NAMES.has(node.comfyClass) || PREVIEW_DISPLAY_NAMES.has(node.title);
}

function drawAspectRect(ctx, preset, x, y, width, height) {
  const maxW = width * 0.7;
  const maxH = height * 0.58;
  const ratio = preset.width / preset.height;
  let rectW = maxW;
  let rectH = rectW / ratio;
  if (rectH > maxH) {
    rectH = maxH;
    rectW = rectH * ratio;
  }

  const rectX = x + (width - rectW) / 2;
  const rectY = y + 26 + (maxH - rectH) / 2;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rectX, rectY, rectW, rectH);
}

function drawPreviewStrip(ctx, node) {
  const margin = 16;
  const stripWidth = Math.max(360, node.size[0] - margin * 2);
  const stripHeight = 86;
  const x = margin;
  const y = Math.max(150, node.size[1] - stripHeight - 14);
  const segmentWidth = stripWidth / PRESETS.length;
  const selected = selectedPreset(node);
  const nodeBackground = node.bgcolor || node.color || "#303030";

  ctx.save();
  ctx.fillStyle = nodeBackground;
  ctx.fillRect(x, y, stripWidth, stripHeight);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 12px Arial";

  for (let i = 0; i < PRESETS.length; i++) {
    const preset = PRESETS[i];
    const sx = x + i * segmentWidth;
    const isSelected = selected === preset.name;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, y, segmentWidth, stripHeight);

    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.fillText(preset.name, sx + segmentWidth / 2, y + 13);
    drawAspectRect(ctx, preset, sx, y, segmentWidth, stripHeight);

    if (isSelected) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx + 2, y + 2, segmentWidth - 4, stripHeight - 4);
    }
  }

  ctx.fillStyle = selected === "auto" ? "#e8e8e8" : "#ffffff";
  ctx.font = "12px Arial";
  ctx.textAlign = "left";
  ctx.fillText(selected === "auto" ? "自动：按输入比例选择预设" : `已选择：${selected}`, x, y + stripHeight + 10);
  ctx.restore();
}

function ensurePreviewSize(node) {
  const minWidth = 430;
  const minHeight = 300;
  let changed = false;

  if (node.size[0] >= 500 && node.size[0] <= 540) {
    node.size[0] = minWidth;
    changed = true;
  }
  if (node.size[0] < minWidth) {
    node.size[0] = minWidth;
    changed = true;
  }
  if (node.size[1] < minHeight) {
    node.size[1] = minHeight;
    changed = true;
  }

  if (changed) {
    node.setDirtyCanvas?.(true, true);
  }
}

function presetForName(name) {
  return PRESETS.find((preset) => preset.name === name);
}

function buildAspectIcon(preset) {
  const icon = document.createElement("span");
  icon.className = "mycomfnode-aspect-icon";
  icon.setAttribute("aria-hidden", "true");

  if (!preset) {
    icon.classList.add("mycomfnode-aspect-icon-auto");
    icon.innerHTML = "<i></i><i></i><i></i>";
    return icon;
  }

  const maxW = 28;
  const maxH = 18;
  const ratio = preset.width / preset.height;
  let width = maxW;
  let height = width / ratio;
  if (height > maxH) {
    height = maxH;
    width = height * ratio;
  }

  const frame = document.createElement("span");
  frame.className = "mycomfnode-aspect-frame";
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  icon.appendChild(frame);
  return icon;
}

function injectDropdownPreviewStyles() {
  if (document.getElementById("mycomfnode-aspect-menu-style")) return;

  const style = document.createElement("style");
  style.id = "mycomfnode-aspect-menu-style";
  style.textContent = `
    .litemenu-entry.mycomfnode-aspect-menu-item {
      min-width: 176px;
      padding-right: 54px !important;
      box-sizing: border-box;
      position: relative;
    }

    .mycomfnode-aspect-icon {
      align-items: center;
      bottom: 1px;
      display: flex;
      justify-content: center;
      pointer-events: none;
      position: absolute;
      right: 44px;
      top: 1px;
      width: 34px;
    }

    .mycomfnode-aspect-frame {
      border: 3px solid rgba(255, 255, 255, 0.95);
      border-radius: 1px;
      box-sizing: border-box;
      display: block;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45));
    }

    .mycomfnode-aspect-icon-auto {
      gap: 3px;
      right: 38px;
    }

    .mycomfnode-aspect-icon-auto i {
      border: 2px solid rgba(255, 255, 255, 0.9);
      border-radius: 1px;
      box-sizing: border-box;
      display: block;
      height: 13px;
      width: 9px;
    }
  `;
  document.head.appendChild(style);
}

function decorateAspectMenus() {
  const items = Array.from(document.querySelectorAll('[role="menuitem"].litemenu-entry'));
  if (items.length === 0) return;

  const menuItems = items.filter((item) => AUTO_LABELS.has(item.textContent?.trim()) || PRESET_NAMES.has(item.textContent?.trim()));
  const hasAllPresets = PRESETS.every((preset) => menuItems.some((item) => item.textContent?.trim() === preset.name));
  if (!hasAllPresets) return;

  for (const item of menuItems) {
    if (item.dataset.mycomfnodeAspectIcon === "1") continue;

    const label = item.textContent.trim();
    item.dataset.mycomfnodeAspectIcon = "1";
    item.classList.add("mycomfnode-aspect-menu-item");
    item.appendChild(buildAspectIcon(presetForName(label)));
  }
}

function watchAspectDropdowns() {
  injectDropdownPreviewStyles();
  decorateAspectMenus();

  const observer = new MutationObserver(() => decorateAspectMenus());
  observer.observe(document.body, { childList: true, subtree: true });
}

if (!window.__mycomfnodeFixedSizeCropPreviewRegistered) {
  window.__mycomfnodeFixedSizeCropPreviewRegistered = true;

  app.registerExtension({
    name: "MyComfnode.FixedSizeCropPreview",

    async setup() {
      watchAspectDropdowns();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
      const matchesNode =
        PREVIEW_NODE_NAMES.has(nodeData.name) ||
        LOCALIZED_NODE_NAMES.has(nodeData.name) ||
        PREVIEW_DISPLAY_NAMES.has(nodeData.display_name) ||
        PREVIEW_NODE_NAMES.has(nodeType.comfyClass) ||
        PREVIEW_DISPLAY_NAMES.has(nodeType.title);

      if (!matchesNode) return;

      const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        originalOnNodeCreated?.apply?.(this, arguments);
        localizeNodeShell(this);
        localizeWidgets(this);
        if (isPreviewNode(this)) ensurePreviewSize(this);

        for (const widget of this.widgets ?? []) {
          const originalCallback = widget.callback;
          widget.callback = (...args) => {
            const result = originalCallback?.apply?.(widget, args);
            localizeWidgets(this);
            if (isPreviewNode(this)) ensurePreviewSize(this);
            app.graph?.setDirtyCanvas(true, true);
            return result;
          };
        }
      };

      const originalOnConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function () {
        originalOnConfigure?.apply?.(this, arguments);
        localizeNodeShell(this);
        localizeWidgets(this);
        if (isPreviewNode(this)) ensurePreviewSize(this);
      };

      const originalOnDrawForeground = nodeType.prototype.onDrawForeground;
      nodeType.prototype.onDrawForeground = function (ctx) {
        originalOnDrawForeground?.apply?.(this, arguments);
        if (!isPreviewNode(this)) return;
        ensurePreviewSize(this);
        drawPreviewStrip(ctx, this);
      };
    },
  });
}
