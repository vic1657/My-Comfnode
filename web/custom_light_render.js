import { app } from "../../scripts/app.js";
import "../../scripts/domWidget.js";
import * as THREE from "./vendor/three/three.module.js";


const NODE_CLASS = "MyCustomLightRender";
const FIELD = {
  rotation: "光源方向",
  elevation: "光源高度",
  intensity: "光照强度",
  color: "光源颜色",
  opacity: "颜色透明度",
  render: "渲染数据",
};
const HEX_COLOR = /^#[0-9A-F]{6}$/i;
const STYLE_ID = "my-custom-light-render-style";
const DOM_WIDGET_HEIGHT = 790;
const RENDER_SIZE = 1024;
const BACKGROUND_COLOR = 0xffffff;
const REFERENCE_INTENSITY_MIN = 0.2;
const REFERENCE_INTENSITY_MAX = 3;
const CONTROL_INTENSITY_MAX = 6;
const LEGACY_LIGHT_SCALE = Math.PI;


function referenceIntensityFor(intensity) {
  const normalized = Math.max(0, Math.min(1,
    (intensity - REFERENCE_INTENSITY_MIN) / (CONTROL_INTENSITY_MAX - REFERENCE_INTENSITY_MIN)
  ));
  return REFERENCE_INTENSITY_MIN
    + normalized * (REFERENCE_INTENSITY_MAX - REFERENCE_INTENSITY_MIN);
}


function legacyLinearColor(red, green = red, blue = red) {
  return new THREE.Color().setRGB(red / 255, green / 255, blue / 255, THREE.LinearSRGBColorSpace);
}


function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .my-light-root, .my-light-root * { box-sizing: border-box; }
    .my-light-root {
      width: 100%; min-width: 340px; padding: 8px 10px 12px;
      color: #e5e7eb; font: 12px/1.4 Arial, "Microsoft YaHei", sans-serif;
      user-select: none;
    }
    .my-light-preview {
      position: relative; width: 100%; aspect-ratio: 1; overflow: hidden;
      border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
      background: #fff;
    }
    .my-light-preview canvas { display: block; width: 100%; height: 100%; }
    .my-light-preview__label {
      position: absolute; left: 10px; top: 10px; padding: 4px 8px;
      border: 1px solid rgba(255,255,255,.14); border-radius: 5px;
      background: rgba(18,20,25,.72); color: rgba(255,255,255,.86);
      pointer-events: none;
    }
    .my-light-controls { display: flex; flex-direction: column; gap: 12px; padding-top: 14px; }
    .my-light-slider-row { display: grid; grid-template-columns: 76px minmax(0,1fr) 54px; align-items: center; gap: 10px; }
    .my-light-slider-row label { color: #d7dce5; white-space: nowrap; }
    .my-light-slider-row output { color: #f1f5f9; text-align: right; font-variant-numeric: tabular-nums; }
    .my-light-range {
      --fill: 50%; appearance: none; width: 100%; height: 18px; margin: 0;
      background: transparent; cursor: pointer; touch-action: none;
    }
    .my-light-range::-webkit-slider-runnable-track {
      height: 6px; border-radius: 999px;
      background: linear-gradient(90deg, #4f8cff 0 var(--fill), #ccd8f3 var(--fill) 100%);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
    }
    .my-light-range::-webkit-slider-thumb {
      appearance: none; width: 18px; height: 18px; margin-top: -6px;
      border: 2px solid #fff; border-radius: 50%; background: #3b82f6;
      box-shadow: 0 1px 5px rgba(0,0,0,.55); cursor: grab;
    }
    .my-light-range:active::-webkit-slider-thumb { cursor: grabbing; }
    .my-light-range:focus-visible { outline: 2px solid #60a5fa; outline-offset: 3px; border-radius: 999px; }
    .my-light-color-panel { padding-top: 2px; border-top: 1px solid rgba(255,255,255,.10); }
    .my-light-color-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 10px 0 8px; }
    .my-light-color-title { color: #f1f5f9; font-weight: 600; }
    .my-light-color-value { display: flex; align-items: center; gap: 8px; }
    .my-light-swatch { width: 28px; height: 28px; border: 1px solid rgba(255,255,255,.32); border-radius: 5px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.2); }
    .my-light-hex {
      width: 92px; height: 30px; border: 1px solid rgba(255,255,255,.14); border-radius: 5px;
      background: #20232b; color: #f8fafc; padding: 0 8px; text-align: center;
      font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase;
    }
    .my-light-hex:focus { outline: 2px solid #60a5fa; outline-offset: 1px; }
    .my-light-sv-wrap { position: relative; width: 100%; height: 138px; border-radius: 6px; overflow: hidden; cursor: crosshair; touch-action: none; }
    .my-light-sv { display: block; width: 100%; height: 100%; }
    .my-light-sv-handle { position: absolute; width: 15px; height: 15px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 1px 5px rgba(0,0,0,.8); transform: translate(-50%,-50%); pointer-events: none; }
    .my-light-color-row { display: grid; grid-template-columns: 46px minmax(0,1fr) 48px; align-items: center; gap: 10px; margin-top: 9px; }
    .my-light-color-row span:last-child { text-align: right; font-variant-numeric: tabular-nums; color: #f1f5f9; }
    .my-light-hue::-webkit-slider-runnable-track { background: linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00); }
    .my-light-alpha::-webkit-slider-runnable-track {
      background:
        linear-gradient(90deg, rgba(255,255,255,0), var(--alpha-color)),
        repeating-conic-gradient(#9ca3af 0 25%,#e5e7eb 0 50%) 0/10px 10px;
    }
  `;
  document.head.appendChild(style);
}


function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}


function hideWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget) return;
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  if (widget.options) widget.options.hidden = true;
}


function numberValue(node, name, fallback) {
  const value = Number(findWidget(node, name)?.value);
  return Number.isFinite(value) ? value : fallback;
}


function colorValue(node) {
  const value = String(findWidget(node, FIELD.color)?.value || "").toUpperCase();
  return HEX_COLOR.test(value) ? value : "#FFFFFF";
}


function setWidgetValue(node, name, value) {
  const widget = findWidget(node, name);
  if (widget) widget.value = value;
  if (node.graph) node.graph._version = (node.graph._version || 0) + 1;
}


function hexToRgb(hex) {
  const value = HEX_COLOR.test(hex) ? hex : "#FFFFFF";
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}


function rgbToHex({ r, g, b }) {
  const part = (value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}


function rgbToHsv({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === red) h = 60 * (((green - blue) / delta) % 6);
    else if (max === green) h = 60 * ((blue - red) / delta + 2);
    else h = 60 * ((red - green) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}


function hsvToRgb({ h, s, v }) {
  const chroma = v * s;
  const sector = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((sector % 2) - 1));
  let rgb = [0, 0, 0];
  if (sector < 1) rgb = [chroma, x, 0];
  else if (sector < 2) rgb = [x, chroma, 0];
  else if (sector < 3) rgb = [0, chroma, x];
  else if (sector < 4) rgb = [0, x, chroma];
  else if (sector < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  const match = v - chroma;
  return { r: (rgb[0] + match) * 255, g: (rgb[1] + match) * 255, b: (rgb[2] + match) * 255 };
}


function buildScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(BACKGROUND_COLOR, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOR);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
  camera.position.set(0, 6, 8);
  camera.lookAt(0, -0.5, 0);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshStandardMaterial({ color: legacyLinearColor(138), roughness: 1, metalness: 0 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -1;
  plane.receiveShadow = true;
  scene.add(plane);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 64),
    new THREE.MeshStandardMaterial({ color: legacyLinearColor(204), roughness: 0.8, metalness: 0 })
  );
  sphere.castShadow = true;
  sphere.receiveShadow = true;
  scene.add(sphere);
  scene.add(new THREE.AmbientLight(0xffffff, 0.2 * LEGACY_LIGHT_SCALE));

  const light = new THREE.DirectionalLight(0xffffff, 1.5);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = 50;
  light.shadow.camera.left = -8;
  light.shadow.camera.right = 8;
  light.shadow.camera.top = 8;
  light.shadow.camera.bottom = -8;
  light.shadow.bias = -0.0005;
  light.shadow.radius = 2;
  scene.add(light);
  return { renderer, scene, camera, light, plane, sphere };
}


function sliderRow({ label, min, max, step, value, digits = 0, suffix = "", onInput }) {
  const row = document.createElement("div");
  row.className = "my-light-slider-row";
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  const range = document.createElement("input");
  range.className = "my-light-range";
  range.type = "range";
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(value);
  range.setAttribute("aria-label", label);
  const output = document.createElement("output");
  const update = (notify = true) => {
    const numeric = Number(range.value);
    range.style.setProperty("--fill", `${((numeric - min) / (max - min)) * 100}%`);
    output.textContent = `${numeric.toFixed(digits)}${suffix}`;
    if (notify) onInput(numeric);
  };
  const updateFromPointer = (event) => {
    const rect = range.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const stepDigits = String(step).split(".")[1]?.length || 0;
    const stepped = min + Math.round(((min + ratio * (max - min)) - min) / step) * step;
    range.value = String(Number(Math.max(min, Math.min(max, stepped)).toFixed(stepDigits)));
    update(true);
  };
  range.addEventListener("input", () => update(true));
  range.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    range.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  });
  range.addEventListener("pointermove", (event) => {
    if (range.hasPointerCapture(event.pointerId)) updateFromPointer(event);
  });
  const releasePointer = (event) => {
    if (range.hasPointerCapture(event.pointerId)) range.releasePointerCapture(event.pointerId);
  };
  range.addEventListener("pointerup", releasePointer);
  range.addEventListener("pointercancel", releasePointer);
  row.append(labelEl, range, output);
  update(false);
  return { row, range, output, refresh: update };
}


function initNode(node) {
  if (!node || node._myCustomLightReady) return;
  node._myCustomLightReady = true;
  injectStyle();
  Object.values(FIELD).forEach((name) => hideWidget(node, name));
  node.title = "My自定义光源渲染";

  const root = document.createElement("div");
  root.className = "my-light-root";
  const preview = document.createElement("div");
  preview.className = "my-light-preview";
  const canvas = document.createElement("canvas");
  const previewLabel = document.createElement("div");
  previewLabel.className = "my-light-preview__label";
  previewLabel.textContent = "实时光源预览";
  preview.append(canvas, previewLabel);

  const controls = document.createElement("div");
  controls.className = "my-light-controls";
  root.append(preview, controls);
  const scene = buildScene(canvas);
  node._myCustomLightScene = scene;

  let frameId = 0;
  let captureTimer = 0;
  let currentHsv = rgbToHsv(hexToRgb(colorValue(node)));

  const resizeRenderer = () => {
    scene.renderer.setPixelRatio(1);
    scene.renderer.setSize(RENDER_SIZE, RENDER_SIZE, false);
    scene.camera.aspect = 1;
    scene.camera.updateProjectionMatrix();
  };

  const capture = () => {
    try {
      setWidgetValue(node, FIELD.render, canvas.toDataURL("image/png"));
    } catch (error) {
      console.warn("[MyCustomLightRender] 捕获渲染图失败", error);
    }
  };

  const renderNow = () => {
    frameId = 0;
    resizeRenderer();
    const azimuth = numberValue(node, FIELD.rotation, 0) * Math.PI / 180;
    const elevation = numberValue(node, FIELD.elevation, 45) * Math.PI / 180;
    const radius = 10;
    scene.light.position.set(
      radius * Math.cos(elevation) * Math.sin(azimuth),
      radius * Math.sin(elevation),
      radius * Math.cos(elevation) * Math.cos(azimuth)
    );
    const selectedColor = hexToRgb(colorValue(node));
    scene.light.color.copy(legacyLinearColor(selectedColor.r, selectedColor.g, selectedColor.b));
    const controlIntensity = numberValue(node, FIELD.intensity, 1.5);
    const opacity = numberValue(node, FIELD.opacity, 1);
    scene.light.intensity = referenceIntensityFor(controlIntensity) * opacity * LEGACY_LIGHT_SCALE;
    scene.renderer.shadowMap.needsUpdate = true;
    scene.renderer.render(scene.scene, scene.camera);
    clearTimeout(captureTimer);
    captureTimer = window.setTimeout(capture, 80);
    node.setDirtyCanvas?.(true, false);
  };

  const requestRender = () => {
    if (frameId) return;
    frameId = requestAnimationFrame(renderNow);
  };

  const rotation = sliderRow({
    label: "光源方向", min: -180, max: 180, step: 1,
    value: numberValue(node, FIELD.rotation, 0), suffix: "°",
    onInput: (value) => { setWidgetValue(node, FIELD.rotation, value); requestRender(); },
  });
  const elevation = sliderRow({
    label: "光源高度", min: 5, max: 85, step: 1,
    value: numberValue(node, FIELD.elevation, 45), suffix: "°",
    onInput: (value) => { setWidgetValue(node, FIELD.elevation, value); requestRender(); },
  });
  const intensity = sliderRow({
    label: "光照强度", min: 0.2, max: 6, step: 0.1,
    value: numberValue(node, FIELD.intensity, 1.5), digits: 1,
    onInput: (value) => { setWidgetValue(node, FIELD.intensity, value); requestRender(); },
  });
  controls.append(rotation.row, elevation.row, intensity.row);

  const colorPanel = document.createElement("div");
  colorPanel.className = "my-light-color-panel";
  const colorHead = document.createElement("div");
  colorHead.className = "my-light-color-head";
  const colorTitle = document.createElement("span");
  colorTitle.className = "my-light-color-title";
  colorTitle.textContent = "光源颜色";
  const colorValueWrap = document.createElement("div");
  colorValueWrap.className = "my-light-color-value";
  const swatch = document.createElement("span");
  swatch.className = "my-light-swatch";
  const hexInput = document.createElement("input");
  hexInput.className = "my-light-hex";
  hexInput.maxLength = 7;
  hexInput.setAttribute("aria-label", "光源颜色十六进制值");
  colorValueWrap.append(swatch, hexInput);
  colorHead.append(colorTitle, colorValueWrap);

  const svWrap = document.createElement("div");
  svWrap.className = "my-light-sv-wrap";
  const svCanvas = document.createElement("canvas");
  svCanvas.className = "my-light-sv";
  svCanvas.width = 512;
  svCanvas.height = 276;
  svCanvas.setAttribute("aria-label", "颜色饱和度与明度");
  const svHandle = document.createElement("span");
  svHandle.className = "my-light-sv-handle";
  svWrap.append(svCanvas, svHandle);

  const drawSv = () => {
    const context = svCanvas.getContext("2d");
    const hueColor = rgbToHex(hsvToRgb({ h: currentHsv.h, s: 1, v: 1 }));
    context.clearRect(0, 0, svCanvas.width, svCanvas.height);
    context.fillStyle = hueColor;
    context.fillRect(0, 0, svCanvas.width, svCanvas.height);
    const white = context.createLinearGradient(0, 0, svCanvas.width, 0);
    white.addColorStop(0, "#ffffff");
    white.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = white;
    context.fillRect(0, 0, svCanvas.width, svCanvas.height);
    const black = context.createLinearGradient(0, 0, 0, svCanvas.height);
    black.addColorStop(0, "rgba(0,0,0,0)");
    black.addColorStop(1, "#000000");
    context.fillStyle = black;
    context.fillRect(0, 0, svCanvas.width, svCanvas.height);
  };

  const updateColor = (writeWidget = true) => {
    const hex = rgbToHex(hsvToRgb(currentHsv));
    if (writeWidget) setWidgetValue(node, FIELD.color, hex);
    hexInput.value = hex;
    swatch.style.background = hex;
    svHandle.style.left = `${currentHsv.s * 100}%`;
    svHandle.style.top = `${(1 - currentHsv.v) * 100}%`;
    hue.range.value = String(Math.round(currentHsv.h));
    hue.range.style.setProperty("--fill", "100%");
    opacity.range.style.setProperty("--alpha-color", hex);
    drawSv();
    requestRender();
  };

  const hue = sliderRow({
    label: "色相", min: 0, max: 360, step: 1, value: currentHsv.h, suffix: "°",
    onInput: (value) => { currentHsv.h = value; updateColor(); },
  });
  hue.range.classList.add("my-light-hue");
  const opacity = sliderRow({
    label: "透明度", min: 0, max: 1, step: 0.01,
    value: numberValue(node, FIELD.opacity, 1), digits: 0,
    onInput: (value) => {
      setWidgetValue(node, FIELD.opacity, value);
      opacity.output.textContent = `${Math.round(value * 100)}%`;
      requestRender();
    },
  });
  opacity.range.classList.add("my-light-alpha");
  opacity.output.textContent = `${Math.round(numberValue(node, FIELD.opacity, 1) * 100)}%`;
  colorPanel.append(colorHead, svWrap, hue.row, opacity.row);
  controls.append(colorPanel);

  const setSvFromPointer = (event) => {
    const rect = svWrap.getBoundingClientRect();
    currentHsv.s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    currentHsv.v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    updateColor();
  };
  svWrap.addEventListener("pointerdown", (event) => {
    svWrap.setPointerCapture(event.pointerId);
    setSvFromPointer(event);
  });
  svWrap.addEventListener("pointermove", (event) => {
    if (svWrap.hasPointerCapture(event.pointerId)) setSvFromPointer(event);
  });
  svWrap.addEventListener("pointerup", (event) => {
    if (svWrap.hasPointerCapture(event.pointerId)) svWrap.releasePointerCapture(event.pointerId);
  });
  hexInput.addEventListener("input", () => {
    const value = hexInput.value.trim().toUpperCase();
    if (!HEX_COLOR.test(value)) return;
    currentHsv = rgbToHsv(hexToRgb(value));
    updateColor();
  });

  const widget = node.addDOMWidget("光源控制", "MY_CUSTOM_LIGHT_RENDER", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => DOM_WIDGET_HEIGHT,
    getMaxHeight: () => DOM_WIDGET_HEIGHT,
    getHeight: () => DOM_WIDGET_HEIGHT,
    getValue: () => "",
    setValue() {},
  });
  widget.serialize = false;
  widget.computeSize = (width) => {
    const resolvedWidth = Math.max(360, width || 440);
    return [resolvedWidth, Math.max(DOM_WIDGET_HEIGHT, resolvedWidth + 330)];
  };
  widget.computedHeight = DOM_WIDGET_HEIGHT;

  const resizeObserver = new ResizeObserver(requestRender);
  resizeObserver.observe(preview);
  node.setSize?.([Math.max(node.size?.[0] || 440, 440), Math.max(node.size?.[1] || 820, 850)]);
  node.graph?.setDirtyCanvas?.(true, true);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function() {
    cancelAnimationFrame(frameId);
    clearTimeout(captureTimer);
    resizeObserver.disconnect();
    scene.sphere.geometry.dispose();
    scene.sphere.material.dispose();
    scene.plane.geometry.dispose();
    scene.plane.material.dispose();
    scene.renderer.dispose();
    originalRemoved?.apply?.(this, arguments);
  };

  updateColor(false);
  opacity.output.textContent = `${Math.round(numberValue(node, FIELD.opacity, 1) * 100)}%`;
  requestRender();
}


app.registerExtension({
  name: "MyComfnode.CustomLightRender",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
      const result = originalCreated?.apply?.(this, arguments);
      window.setTimeout(() => initNode(this), 0);
      return result;
    };
    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function() {
      const result = originalConfigured?.apply?.(this, arguments);
      window.setTimeout(() => initNode(this), 0);
      return result;
    };
  },
});
