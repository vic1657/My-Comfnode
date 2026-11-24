// MY色度可视化抠图 —— 前端实时预览 (镜像 widget 方案, 兼容新旧 ComfyUI 前端)
// 原始 python widget 隐藏保底(存值/序列化/载入恢复), DOM 滑块/取色器作为镜像控制器
// 与后端 my_chroma_key_vis.py 同一套算法, 滑块拖动即时重算, 无需重新排队
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PARAMS = ["强度", "阴影", "边缘羽化", "边缘清除"];
const NODE_NAME = "MyChromaKeyVisual";
const MAX_PREVIEW = 1400;   // 拖动时实时计算的分辨率
const MAX_FULL = 2600;      // 停止拖动后精修的分辨率上限

function hexToRgb01(hex) {
  let s = (hex || "").trim().replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (s.length !== 6) return { r: 74 / 255, g: 223 / 255, b: 92 / 255 };
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return { r: 74 / 255, g: 223 / 255, b: 92 / 255 };
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function rgb01ToHex(c) {
  const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}
function ss(e0, e1, x) {
  let u = (x - e0) / Math.max(e1 - e0, 1e-6);
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return u * u * (3 - 2 * u);
}

function boxBlurAxis(src, dst, w, h, r, horizontal) {
  const n = 2 * r + 1;
  const clamp = (v, m) => (v < 0 ? 0 : v > m ? m : v);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[row + clamp(i, w - 1)];
      for (let x = 0; x < w; x++) {
        dst[row + x] = acc / n;
        acc += src[row + clamp(x + r + 1, w - 1)] - src[row + clamp(x - r, w - 1)];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[clamp(i, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc / n;
        acc += src[clamp(y + r + 1, h - 1) * w + x] - src[clamp(y - r, h - 1) * w + x];
      }
    }
  }
}

function erodeMin(a, w, h, r) {
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let i = -r; i <= r; i++) {
        const xc = Math.min(w - 1, Math.max(0, x + i));
        const v = a[row + xc];
        if (v < m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let i = -r; i <= r; i++) {
        const yc = Math.min(h - 1, Math.max(0, y + i));
        const v = tmp[yc * w + x];
        if (v < m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function computeKey(srcData, W, H, P) {
  const N = W * H;
  let kl = 0.299 * P.kr + 0.587 * P.kg + 0.114 * P.kb;
  kl = Math.max(kl, 0.02);
  let kcr = (P.kr - kl) / kl;
  let kcb = (P.kb - kl) / kl;
  if (kcr * kcr + kcb * kcb < 1e-6) { kcr = -0.548; kcb = -0.437; }
  const k2 = kcr * kcr + kcb * kcb;
  const kmag = Math.sqrt(k2);

  let alpha = new Float32Array(N);
  const aArr = new Float32Array(N);
  const sArr = new Float32Array(N);
  const cArr = new Float32Array(N);
  const vArr = new Float32Array(N);

  const t = P.strength / 100, st = P.shadow / 100, ft = P.feather / 100, ct = P.cleanup / 100;
  const aLo = 0.30 + (0.02 - 0.30) * t;
  const hueIn = 0.15 + 0.25 * t;
  const hueOut = 0.45 + 0.45 * t;
  const darkE1 = 0.45 - 0.30 * st;
  const gain = ss(0, 0.08, t);

  for (let i = 0; i < N; i++) {
    const r = srcData[i * 4] / 255, g = srcData[i * 4 + 1] / 255, b = srcData[i * 4 + 2] / 255;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const ls = Math.max(l, 0.02);
    const cr = (r - ls) / ls, cb = (b - ls) / ls;
    const a = (cr * kcr + cb * kcb) / k2;
    const s = Math.abs(cr * kcb - cb * kcr) / (Math.sqrt(cr * cr + cb * cb + 1e-10) * kmag + 1e-10);
    const dr = r - l, db = b - l;
    const cmag = Math.sqrt(dr * dr + db * db);
    const v = Math.max(r, g, b);
    aArr[i] = a; sArr[i] = s; cArr[i] = cmag; vArr[i] = v;

    // 阴影: 暗部权重
    const darkW = 1 - ss(0.06, darkE1, v);
    // 暗部保护: 阴影低时, 暗色主体(黑毛绿反光)需要更强的绿色关联才会被抠
    const aLoEff = aLo + (1 - st) * 0.22 * darkW;
    const alignW = ss(aLoEff, aLoEff + 0.08, a);
    const hueW = 1 - ss(hueIn, hueOut, s);
    // 绝对色度门槛: 保护黑毛反光
    const chromaW = ss(0.015, 0.05, cmag);
    let B = alignW * hueW * chromaW * gain;
    // 阴影项: 补抠暗部且绿色关联中等的像素(绿幕投影), 也受强度门控
    const Bd = st * gain * darkW * hueW * ss(0.25, 0.45, a) * chromaW;
    if (Bd > B) B = Bd;
    alpha[i] = 1 - Math.min(Math.max(B, 0), 1);
  }

  // 背景扩散净化
  const grow = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (alpha[i] < 0.15) grow[i] = 1;
  for (let k = 0; k < 5; k++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (!grow[i] && ((y > 0 && grow[i - W]) || (x > 0 && grow[i - 1]))) grow[i] = 1;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      const row = y * W;
      for (let x = W - 1; x >= 0; x--) {
        const i = row + x;
        if (!grow[i] && ((y < H - 1 && grow[i + W]) || (x < W - 1 && grow[i + 1]))) grow[i] = 1;
      }
    }
  }
  for (let i = 0; i < N; i++) if (grow[i] && alpha[i] >= 0.15 && alpha[i] < 0.92) alpha[i] *= 0.30;

  // 主体内部破洞自动填补: 被实心区包围的孤立破洞/半透明点补实
  {
    const solid = new Float32Array(N);
    for (let i = 0; i < N; i++) solid[i] = alpha[i] > 0.9 ? 1 : 0;
    const nb21 = new Float32Array(N);
    const nb15 = new Float32Array(N);
    const tmp2 = new Float32Array(N);
    boxBlurAxis(solid, tmp2, W, H, 10, true);
    boxBlurAxis(tmp2, nb21, W, H, 10, false);
    boxBlurAxis(solid, tmp2, W, H, 7, true);
    boxBlurAxis(tmp2, nb15, W, H, 7, false);
    for (let i = 0; i < N; i++) {
      if ((alpha[i] < 0.5 && nb21[i] > 0.8) || (alpha[i] < 0.92 && nb21[i] > 0.92) ||
          (alpha[i] < 0.5 && nb15[i] > 0.72)) alpha[i] = 0.99;
    }
  }

  // 羽化
  const sigma = ft * 8;
  if (sigma > 0.3) {
    const r = Math.max(1, Math.round(sigma));
    const tmp = new Float32Array(N);
    for (let p = 0; p < 3; p++) {
      boxBlurAxis(alpha, tmp, W, H, r, true);
      boxBlurAxis(tmp, alpha, W, H, r, false);
    }
  }
  // 收缩
  const rEr = Math.round(ct * 4);
  if (rEr > 0) alpha = erodeMin(alpha, W, H, rEr);

  // despill + 输出
  const out = new Uint8ClampedArray(N * 4);
  const spillW = Math.min(1, ct * 5);
  for (let i = 0; i < N; i++) {
    const al = alpha[i];
    let r = srcData[i * 4], g = srcData[i * 4 + 1], b = srcData[i * 4 + 2];
    if (spillW > 0 && al > 0.003) {
      const wgt = spillW * (1 - ss(0.30, 1.0, al));
      if (wgt > 0) {
        if (P.kg >= P.kr && P.kg >= P.kb) {
          const others = Math.max(r, b), d2 = Math.min(g, others);
          g = g * (1 - wgt) + d2 * wgt;
        } else if (P.kr >= P.kg && P.kr >= P.kb) {
          const others = Math.max(g, b), d2 = Math.min(r, others);
          r = r * (1 - wgt) + d2 * wgt;
        } else {
          const others = Math.max(r, g), d2 = Math.min(b, others);
          b = b * (1 - wgt) + d2 * wgt;
        }
      }
    }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = al * 255;
  }
  return out;
}

// ---------- 镜像 DOM widgets ----------

function setPyValue(node, py, v) {
  try {
    py.value = v;
    if (py.inputEl) py.inputEl.value = String(v);
    py.callback?.(v);
  } catch (e) {}
  if (node.__ck) {
    node.__ck.syncFns.forEach((f) => f()); // 同步所有镜像控件(滑块位置/色块)
    node.__ck.dirty = true;
    schedulePreview(node);
  }
}

function makeSliderMirror(node, py, name) {
  const min = py.options?.min ?? 0;
  const max = py.options?.max ?? 100;
  const step = py.options?.step ?? 1;

  const el = document.createElement("div");
  el.style.cssText =
    "display:flex;align-items:center;gap:8px;width:100%;padding:3px 10px;box-sizing:border-box;";

  const lbl = document.createElement("span");
  lbl.textContent = name;
  lbl.style.cssText = "flex:none;width:58px;font-size:12px;color:#ddd;overflow:hidden;";

  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min); range.max = String(max); range.step = String(step);
  range.style.cssText = "flex:1 1 auto;min-width:60px;height:16px;accent-color:#4ade5c;cursor:pointer;";

  const num = document.createElement("input");
  num.type = "number";
  num.min = String(min); num.max = String(max); num.step = String(step);
  num.style.cssText =
    "flex:none;width:54px;background:#1e1e1e;border:1px solid #3a3a3a;border-radius:4px;" +
    "color:#eee;font-size:12px;padding:2px 4px;box-sizing:border-box;text-align:right;";

  el.appendChild(lbl); el.appendChild(range); el.appendChild(num);

  const w = node.addDOMWidget(name + "_滑块", "myck_slider", el, { serialize: false });
  w.serialize = false;

  const syncUI = () => {
    const v = Number(py.value) || 0;
    range.value = String(v);
    num.value = String(Math.round(v * 100) / 100);
  };
  syncUI();

  range.addEventListener("input", () => setPyValue(node, py, Number(range.value)));
  num.addEventListener("change", () => setPyValue(node, py, Number(num.value)));
  node.__ck.syncFns.push(syncUI);
  return w;
}

function makeColorMirror(node, py) {
  const el = document.createElement("div");
  el.style.cssText =
    "display:flex;align-items:center;gap:8px;width:100%;padding:3px 10px;box-sizing:border-box;";

  const lbl = document.createElement("span");
  lbl.textContent = "取色器";
  lbl.style.cssText = "flex:none;width:58px;font-size:12px;color:#ddd;";

  const swatch = document.createElement("div");
  swatch.style.cssText =
    "flex:none;width:24px;height:24px;border-radius:5px;border:2px solid #666;cursor:pointer;";

  const hex = document.createElement("input");
  hex.type = "text";
  hex.placeholder = "#4ADF5C";
  hex.style.cssText =
    "flex:1 1 auto;min-width:70px;background:#1e1e1e;border:1px solid #3a3a3a;border-radius:4px;" +
    "color:#eee;font-size:12px;padding:2px 6px;box-sizing:border-box;";

  const pickBtn = document.createElement("button");
  pickBtn.textContent = "💧 吸管";
  pickBtn.title = "点击后, 在预览图上点一下即可取色";
  pickBtn.style.cssText =
    "flex:none;font-size:11px;padding:3px 8px;border-radius:5px;border:1px solid #555;" +
    "background:#333;color:#ddd;cursor:pointer;";

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none;left:-100px;";

  el.appendChild(lbl); el.appendChild(swatch); el.appendChild(hex);
  el.appendChild(pickBtn); el.appendChild(colorInput);

  const w = node.addDOMWidget("取色器_色块", "myck_color", el, { serialize: false });
  w.serialize = false;

  const applyHex = (h) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(h || "")) return;
    setPyValue(node, py, h);
  };
  swatch.addEventListener("click", () => {
    colorInput.value = /^#[0-9a-fA-F]{6}$/.test(String(py.value)) ? py.value : "#4ADF5C";
    colorInput.click();
  });
  colorInput.addEventListener("input", () => applyHex(colorInput.value));
  hex.addEventListener("change", () => applyHex(hex.value.trim()));
  pickBtn.addEventListener("click", () => {
    const ck = node.__ck;
    if (!ck) return;
    ck.pick = !ck.pick;
    pickBtn.style.background = ck.pick ? "#4ade5c" : "#333";
    pickBtn.style.color = ck.pick ? "#000" : "#ddd";
  });

  const syncUI = () => {
    const v = String(py.value || "#4ADF5C");
    const ok = /^#[0-9a-fA-F]{6}$/.test(v);
    swatch.style.background = ok ? v : "#4ADF5C";
    hex.value = ok ? v : "#4ADF5C";
  };
  syncUI();
  node.__ck.syncFns.push(syncUI);
  return w;
}

function makeCanvasWidget(node) {
  const container = document.createElement("div");
  container.style.cssText = "width:100%;position:relative;background:#181818;border-radius:6px;overflow:hidden;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;display:block;cursor:crosshair;";
  const hint = document.createElement("div");
  hint.textContent = "▶ 连接图像并运行一次后, 此处实时预览抠图结果";
  hint.style.cssText =
    "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
    "font-size:12px;color:#999;pointer-events:none;";
  container.appendChild(canvas);
  container.appendChild(hint);

  const w = node.addDOMWidget("实时预览", "myck_preview", container, { serialize: false });
  w.serialize = false;
  w.computeSize = function (width) {
    const src = node.__ck?.src;
    if (!src) return [width, 80];
    return [width, Math.max(80, Math.round((width - 12) * (src.H / src.W)))];
  };
  canvas.addEventListener("click", (ev) => {
    const ck = node.__ck;
    const src = ck?.src;
    if (!src || !ck.pick) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.min(src.W - 1, Math.max(0, Math.floor(((ev.clientX - rect.left) / rect.width) * src.W)));
    const py = Math.min(src.H - 1, Math.max(0, Math.floor(((ev.clientY - rect.top) / rect.height) * src.H)));
    const i = (py * src.W + px) * 4;
    const d = src.data;
    const hexc = rgb01ToHex({ r: d[i] / 255, g: d[i + 1] / 255, b: d[i + 2] / 255 });
    const cw = node.widgets?.find((x) => x.name === "取色器");
    if (cw) setPyValue(node, cw, hexc);
    ck.pick = false;
  });
  return { widget: w, canvas, hint, container };
}

// ---------- preview ----------

const checkerCache = new WeakMap();
function getChecker(ctx) {
  if (checkerCache.has(ctx)) return checkerCache.get(ctx);
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const cx = c.getContext("2d");
  cx.fillStyle = "#3a3a3a"; cx.fillRect(0, 0, 32, 32);
  cx.fillStyle = "#4c4c4c"; cx.fillRect(0, 0, 16, 16); cx.fillRect(16, 16, 16, 16);
  const pattern = ctx.createPattern(c, "repeat");
  checkerCache.set(ctx, pattern);
  return pattern;
}

function schedulePreview(node, force) {
  const ck = node.__ck;
  if (!ck) return;
  if (force) ck.dirty = true;
  // 参数变化: 取消挂起的全分辨率精修, 等拖动结束再精修
  if (ck.refineTimer) { clearTimeout(ck.refineTimer); ck.refineTimer = null; }
  if (ck.pending) return;
  ck.pending = true;
  requestAnimationFrame(() => {
    ck.pending = false;
    renderPreview(node, false);
    scheduleRefine(node);
  });
}

function scheduleRefine(node) {
  const ck = node.__ck;
  if (!ck || !ck.srcFull) return;
  if (ck.refineTimer) clearTimeout(ck.refineTimer);
  ck.refineTimer = setTimeout(() => {
    ck.refineTimer = null;
    renderPreview(node, true);
  }, 300);
}

function renderPreview(node, useFull) {
  const ck = node.__ck;
  if (!ck || !ck.canvas) return;
  const src = useFull ? (ck.srcFull || ck.src) : ck.src;
  if (!src) return;
  if (!ck.dirty && !useFull) return;
  ck.dirty = false;
  const { canvas } = ck;
  const W = src.W, H = src.H;

  const cw = node.widgets?.find((x) => x.name === "取色器");
  const kc = hexToRgb01(typeof cw?.value === "string" ? cw.value : "#4ADF5C");
  const gv = (n2, d) => {
    const w = node.widgets?.find((x) => x.name === n2);
    const v = Number(w?.value);
    return Number.isFinite(v) ? v : d;
  };
  const P = {
    strength: gv("强度", 22),
    shadow: gv("阴影", 33),
    feather: gv("边缘羽化", 14),
    cleanup: gv("边缘清除", 33),
    kr: kc.r, kg: kc.g, kb: kc.b,
  };

  let out;
  try {
    out = computeKey(src.data, W, H, P);
  } catch (e) {
    console.error("[MY色度抠图] 预览计算失败:", e);
    return;
  }

  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W; canvas.height = H;
  }
  const nodeW = node.size?.[0] ?? 320;
  const dispH = Math.max(40, Math.round((nodeW - 20) * (H / W)));
  canvas.style.height = dispH + "px";
  // 新前端会限制 DOM widget 行高, 必须显式撑起容器并更新 computedHeight
  if (ck.container) ck.container.style.height = dispH + 4 + "px";
  if (ck.widget) ck.widget.computedHeight = dispH + 6;
  // 节点高度不足时自动撑高, 保证预览完整可见
  const widgetsBottom = (ck.widget?.last_y ?? 300) + dispH + 30;
  if ((node.size?.[1] ?? 0) < widgetsBottom) {
    node.size[1] = widgetsBottom;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = getChecker(ctx);
  ctx.fillRect(0, 0, W, H);

  if (!ck.tmp || ck.tmp.width !== W || ck.tmp.height !== H) {
    ck.tmp = document.createElement("canvas");
    ck.tmp.width = W; ck.tmp.height = H;
    ck.tmpCtx = ck.tmp.getContext("2d");
  }
  ck.tmpCtx.putImageData(new ImageData(out, W, H), 0, 0);
  ctx.drawImage(ck.tmp, 0, 0);

  if (ck.widget) {
    ck.widget.computeSize = function (width) {
      return [width, Math.max(80, Math.round((width - 12) * (H / W)))];
    };
  }
  node.setDirtyCanvas?.(true, true);
}

// ---------- extension ----------

console.log("[MY色度抠图] 前端 v2 (暗部保护版) 已加载");
app.registerExtension({
  name: "MyComfnode.MyChromaKeyVis",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    nodeType.prototype.onNodeCreated = function () {
      const node = this;
      if (node.__ck) return; // 防止扩展重复注册时二次注入
      node.__ck = { src: null, srcFull: null, pick: false, dirty: true, pending: false, syncFns: [], refineTimer: null };

      // 隐藏原始 python widgets (保留存值/序列化/载入恢复), 添加镜像 DOM 控件
      const wanted = ["取色器", ...PARAMS];
      const pyByName = {};
      if (node.widgets) {
        for (const w of node.widgets) {
          if (wanted.includes(w.name)) {
            pyByName[w.name] = w;
            w.hidden = true; // 不渲染, 但仍参与序列化与载入恢复
          }
        }
        if (pyByName["取色器"]) makeColorMirror(node, pyByName["取色器"]);
        for (const name of PARAMS) {
          if (pyByName[name]) makeSliderMirror(node, pyByName[name], name);
        }
      }

      // 预览画布
      const cv = makeCanvasWidget(node);
      node.__ck.canvas = cv.canvas;
      node.__ck.hint = cv.hint;
      node.__ck.widget = cv.widget;
      node.__ck.container = cv.container;

      // 工作流载入恢复值后, 同步镜像控件 UI
      const origOnConfigure = node.onConfigure;
      node.onConfigure = function () {
        origOnConfigure?.apply(this, arguments);
        this.__ck?.syncFns.forEach((f) => f());
        schedulePreview(this, true);
      };

      const origOnResize = node.onResize;
      node.onResize = function () {
        origOnResize?.apply(this, arguments);
        schedulePreview(node, true);
      };
    };

    nodeType.prototype.onExecuted = function (payload) {
      const node = this;
      const entry = payload?.src_images?.[0];
      if (!entry || !node.__ck) return;
      const url = api.apiURL(
        `/view?filename=${encodeURIComponent(entry.filename)}&subfolder=${encodeURIComponent(entry.subfolder || "")}&type=${entry.type || "temp"}`
      );
      const im = new Image();
      im.onload = () => {
        // 全分辨率源图(供精修), 上限 2600 防止过大图卡顿
        const scaleF = Math.min(1, MAX_FULL / Math.max(im.width, im.height));
        const FW = Math.max(1, Math.round(im.width * scaleF));
        const FH = Math.max(1, Math.round(im.height * scaleF));
        const offF = document.createElement("canvas");
        offF.width = FW; offF.height = FH;
        const fctx = offF.getContext("2d", { willReadFrequently: true });
        fctx.drawImage(im, 0, 0, FW, FH);
        node.__ck.srcFull = { data: fctx.getImageData(0, 0, FW, FH).data, W: FW, H: FH };

        // 低分辨率源图(供拖动时实时计算)
        const scale = Math.min(1, MAX_PREVIEW / Math.max(im.width, im.height));
        const W = Math.max(1, Math.round(im.width * scale));
        const H = Math.max(1, Math.round(im.height * scale));
        const off = document.createElement("canvas");
        off.width = W; off.height = H;
        const octx = off.getContext("2d", { willReadFrequently: true });
        octx.drawImage(im, 0, 0, W, H);
        node.__ck.src = { data: octx.getImageData(0, 0, W, H).data, W, H };

        node.__ck.hint.style.display = "none";
        node.__ck.dirty = true;
        schedulePreview(node, true);
      };
      im.src = url;
    };
  },
});
