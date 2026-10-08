// My实时预览色度抠图 - 浏览器端实时预览 v2
// 滑块变化时在节点内画布即时重算抠图结果（与 Python 引擎同一算法的 JS 移植）
// v2: 每张源图只计算一次昂贵中间量（缓存），滑块变化只做轻量组合，拖动不卡
import { app } from "../../scripts/app.js";

const NODE_CLASS = "MyChromaKeyPreview";
const GUARD = "__myComfnodeChromaKeyPreviewV2";
const MAX_SIDE = 460;

function findWidget(node, name) {
  return node.widgets?.find((w) => w?.name === name);
}

function smoothstep(x, e0, e1) {
  if (e1 <= e0) e1 = e0 + 1e-6;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function boxBlur(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function erodeMask(matte, w, h, r) {
  if (r <= 0) return matte;
  const tmp = new Float32Array(matte.length);
  const out = new Float32Array(matte.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let k = -r; k <= r; k++) m = Math.min(m, matte[y * w + Math.min(w - 1, Math.max(0, x + k))]);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 1;
      for (let k = -r; k <= r; k++) m = Math.min(m, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

function dilateMask(matte, w, h, r) {
  if (r <= 0) return matte;
  const tmp = new Float32Array(matte.length);
  const out = new Float32Array(matte.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) m = Math.max(m, matte[y * w + Math.min(w - 1, Math.max(0, x + k))]);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) m = Math.max(m, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

// ---------- 每张源图只算一次的昂贵中间量 ----------
function computeStatic(data, w, h) {
  const n = w * h;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  const Y = new Float32Array(n), CB = new Float32Array(n), CR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    R[i] = r; G[i] = g; B[i] = b;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    Y[i] = y;
    CB[i] = (b - y) * 0.564 + 0.5;
    CR[i] = (r - y) * 0.713 + 0.5;
  }

  // 自动取色：四边 4% 环带中值
  const f = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const rs = [], gs = [], bs = [];
  const push = (x, y) => { const i = y * w + x; rs.push(R[i]); gs.push(G[i]); bs.push(B[i]); };
  for (let y = 0; y < h; y += 2) { for (let x = 0; x < f; x += 2) push(x, y); for (let x = w - f; x < w; x += 2) push(x, y); }
  for (let x = 0; x < w; x += 2) { for (let y = 0; y < f; y += 2) push(x, y); for (let y = h - f; y < h; y += 2) push(x, y); }
  const kr = median(rs), kg = median(gs), kb = median(bs);
  const ky = 0.299 * kr + 0.587 * kg + 0.114 * kb;
  const kcb = (kb - ky) * 0.564 + 0.5, kcr = (kr - ky) * 0.713 + 0.5;
  const kvc = kcb - 0.5, kvr = kcr - 0.5;
  const kk = Math.max(kvc * kvc + kvr * kvr, 1e-6);
  const klen = Math.sqrt(kk);

  const cbS = boxBlur(CB, w, h, 2);
  const crS = boxBlur(CR, w, h, 2);
  const yS = boxBlur(Y, w, h, 2);

  // 与滑块无关的逐像素中间量（缓存复用）
  const bgProjA = new Float32Array(n);   // clamp(proj)*alignF
  const bgRatio = new Float32Array(n);   // 通道占比
  const perp = new Float32Array(n);
  const distC = new Float32Array(n);     // 色度距离
  const mag = new Float32Array(n);
  const domArr = new Uint8Array(n);

  const d = kg >= kr && kg >= kb ? 1 : (kb >= kr && kb >= kg ? 2 : 0);
  const others = [0, 1, 2].filter((i) => i !== d);
  const kd = [kr, kg, kb][d];
  const kOther = Math.max(kr, kg, kb) === kd ? Math.min(...[kr, kg, kb].filter((v, i) => i !== d)) : Math.max(...[kr, kg, kb].filter((v, i) => i !== d));
  const ratioK = (kd - kOther) / (kd + kOther + 1e-6);

  for (let i = 0; i < n; i++) {
    const pcb = cbS[i] - 0.5, pcr = crS[i] - 0.5;
    const plen2 = pcb * pcb + pcr * pcr;
    const proj = (pcb * kvc + pcr * kvr) / kk;
    const projC = Math.max(proj, 0);
    perp[i] = Math.sqrt(Math.max(plen2 - projC * projC * kk, 0)) / klen;
    const plen = Math.sqrt(plen2);
    const align = (pcb * kvc + pcr * kvr) / (plen * klen + 1e-6);
    bgProjA[i] = Math.min(Math.max(proj, 0), 1) * smoothstep(align, 0.70, 0.85);

    const chans = [R[i], G[i], B[i]];
    domArr[i] = d;
    const cdom = chans[d];
    const cother = Math.max(chans[others[0]], chans[others[1]]);
    bgRatio[i] = Math.min(Math.max((cdom - cother) / (cdom + cother + 1e-6) / (ratioK + 1e-6), 0), 1);

    distC[i] = Math.hypot(cbS[i] - kcb, crS[i] - kcr);
    mag[i] = plen / klen;
  }

  return { w, h, n, R, G, B, Y: yS, kr, kg, kb, kk, klen,
           bgProjA, bgRatio, perp, distC, mag, kcb, kcr };
}

// ---------- 滑块变化时的轻量组合（毫秒级） ----------
function computeMatte(c, p) {
  const { w, h, n } = c;
  const t1 = p.tolerance * 0.45;
  const t2 = t1 + Math.max(p.softness * 0.3, 1e-4);
  const gate0 = 0.30, gate1 = 0.30 + p.tolerance * 0.6 + p.softness * 0.2;
  const matte = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    let b = Math.max(c.bgProjA[i], c.bgRatio[i]) * (1 - smoothstep(c.perp[i], gate0, gate1));
    const gateD = 1 - smoothstep(c.perp[i], 0.12, 0.30);
    const bgDist = (1 - smoothstep(c.distC[i], t1, t2)) * smoothstep(c.mag[i], 0.4, 0.6) * gateD;
    b = Math.max(b, bgDist * (1 - smoothstep(b, 0.2, 0.5)));
    if (p.rgbKey > 0) {
      const dr = Math.hypot(c.R[i] - c.kr, c.G[i] - c.kg, c.B[i] - c.kb);
      const r2 = p.rgbKey * 1.15 + 0.05, r1 = r2 * 0.7;
      const bRGB = 1 - smoothstep(dr, r1, r2);
      if (bRGB > b) b = bRGB;
    }
    const keyAllowed = smoothstep(c.Y[i], 0.04, 0.04 + p.shadow * 0.6);
    matte[i] = 1 - Math.min(b * keyAllowed * p.keyGate, 1);
  }
  return matte;   // 原始软遮膜（未做任何形状处理）
}

// 形状处理：闭运算填洞 → 羽化 → 收缩 → 边缘实化（必须在修色之后执行）
function applyCleanup(matte, p, w, h) {
  if (p.holeFill > 0) {
    const cr = Math.round(p.holeFill * 70 * (p.scale || 1));
    if (cr >= 2) {
      const dil = dilateMask(matte, w, h, cr);
      const closed = erodeMask(dil, w, h, cr);
      for (let i = 0; i < matte.length; i++) if (closed[i] > matte[i]) matte[i] = closed[i];
    }
  }
  const blurred = boxBlur(matte, w, h, p.maskBlur);
  matte.set(blurred);
  if (p.maskShrink > 0) {
    matte.set(erodeMask(matte, w, h, p.maskShrink));
    matte.set(boxBlur(matte, w, h, 1));   // 侵蚀后轻模糊，消除块状锯齿
  }
  if (p.edgeSolid > 0) {
    const lo = 0.05 * p.edgeSolid, hi = 1 - 0.6 * p.edgeSolid;
    for (let i = 0; i < matte.length; i++)
      matte[i] = Math.min(1, Math.max(0, (matte[i] - lo) / (hi - lo)));
  }
  return matte;
}

// ---------- 节点扩展 ----------
if (!globalThis[GUARD]) {
  globalThis[GUARD] = true;

  app.registerExtension({
    name: "MyComfnode.ChromaKeyPreview.V2",
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData?.name !== NODE_CLASS) return;

      const originalCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply?.(this, arguments);
        const node = this;
        node._procCache = null;

        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:4px;";
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:11px;opacity:.65;line-height:1.4;";
        hint.textContent = "先执行一次加载图像，之后拖动滑块实时预览（浏览器端运算）";
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "width:100%;background:#141414;border-radius:6px;";
        wrap.append(hint, canvas);

        const widget = node.addDOMWidget("预览画布", "MY_CHROMA_PREVIEW", wrap, {
          serialize: false, hideOnZoom: false,
          getValue: () => "", setValue() {},
        });
        widget.computeSize = (width) => [width, 400];
        node._previewCanvas = canvas;
        node._previewRaf = 0;
        node._lastRender = 0;
        node._srcImg = null;
        node._srcFailed = false;

        const schedule = () => {
          if (node._previewRaf) return;
          const now = performance.now();
          const wait = Math.max(0, 120 - (now - node._lastRender));
          node._previewRaf = setTimeout(() => {
            node._previewRaf = 0;
            node._lastRender = performance.now();
            try {
              drawPreview(node);
            } catch (err) {
              console.error("[MyChromaKeyPreview]", err);
              showCanvasError(node, err);
            }
          }, wait);
        };

        // 主动加载 temp 缓存源图（固定文件名，不依赖 onExecuted）
        node._loadSrc = function () {
          const img = new Image();
          img.onload = () => {
            node._srcImg = img;
            node._procCache = null;   // 新源图 → 重建缓存
            node._srcFailed = false;
            schedule();
          };
          img.onerror = () => {
            if (!node._srcImg) node._srcFailed = true;
          };
          img.src = `/view?filename=my_chroma_preview_src.png&type=temp&r=${Date.now()}`;
        };

        for (const name of ["强度", "阴影", "边缘羽化", "边缘清除"]) {
          const w = findWidget(node, name);
          if (!w) continue;
          const orig = w.callback;
          w.callback = function () {
            const r = orig?.apply?.(this, arguments);
            if (!node._srcImg && !node._srcFailed) node._loadSrc();
            schedule();
            return r;
          };
        }

        node.onExecuted = function () { node._loadSrc(); };

        const originalRemoved = node.onRemoved;
        node.onRemoved = function () {
          if (node._previewRaf) clearTimeout(node._previewRaf);
          node._procCache = null;
          originalRemoved?.apply?.(this, arguments);
        };

        setTimeout(() => node._loadSrc(), 80);
        return result;
      };
    },
  });
}

function showCanvasError(node, err) {
  const canvas = node?._previewCanvas;
  if (!canvas) return;
  canvas.width = Math.max(320, canvas.width || 320);
  canvas.height = 220;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#401010"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffb0b0"; ctx.font = "14px monospace";
  const lines = String(err && err.stack || err).split("\n").slice(0, 6);
  lines.forEach((line, i) => ctx.fillText(line.slice(0, 110), 10, 30 + i * 20));
}

function readParams(node) {
  const num = (name, dflt) => {
    const v = Number(findWidget(node, name)?.value);
    return Number.isFinite(v) ? v : dflt;
  };
  const strength = num("强度", 17) / 100;
  const clean = num("边缘清除", 33) / 100;
  return {
    tolerance: 0.05 + strength * 1.6,
    shadow: (num("阴影", 31) / 100) * (1.0 - 0.55 * strength),
    maskBlur: Math.max(0, Math.round(2 * (node._previewScale || 1))),
    maskShrink: Math.round((num("边缘羽化", 18) / 100) * 20 * (node._previewScale || 1)
      + clean * 10 * (node._previewScale || 1)),
    edgeSolid: Math.min(1, 0.45 + clean * 0.55),
    softness: 0.25,
    strength,
    rgbKey: Math.pow(strength, 1.2),
    despillAmt: Math.min(1, clean * 3.0),
    holeFill: 0.5,
    scale: node._previewScale || 1,
    keyGate: (() => {
      const t = Math.min(1, strength / 0.12);
      return t * t * (3 - 2 * t);
    })(),
  };
}

function drawPreview(node) {
  const canvas = node._previewCanvas;
  if (!canvas) return;
  const rectW = Math.max(320, node.size?.[0] || 420);
  canvas.style.height = "auto";

  if (!node._srcImg) {
    canvas.width = rectW; canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1b1b1b"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,.5)";
    ctx.font = "13px sans-serif";
    ctx.fillText(node._srcFailed ? "未找到缓存图，请先执行一次" : "执行一次后此处显示实时预览", 16, 100);
    return;
  }

  const src = node._srcImg;
  const scale = Math.min(1, MAX_SIDE / Math.max(src.width, src.height));
  node._previewScale = scale;
  const params = readParams(node);
  const w = Math.max(2, Math.round(src.width * scale));
  const h = Math.max(2, Math.round(src.height * scale));
  canvas.width = w; canvas.height = h;

  // 缓存昂贵中间量（每张源图一次）
  if (!node._procCache || node._procCache.w !== w || node._procCache.h !== h) {
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d", { willReadFrequently: true });
    octx.drawImage(src, 0, 0, w, h);
    const srcData = octx.getImageData(0, 0, w, h);
    node._procCache = computeStatic(srcData.data, w, h);
    node._procCache.srcData = srcData;
  }
  const c = node._procCache;

  const matteRaw = computeMatte(c, params);

  // ★ 反混合修色必须用原始软 α（形状处理之前），否则 α 失真修不动绿边
  const out = new ImageData(w, h);
  const kd = [c.kr, c.kg, c.kb];
  const ws = params.despillAmt;
  const data = c.srcData.data;
  for (let i = 0; i < w * h; i++) {
    const a = matteRaw[i];
    let r = data[i*4]/255, g = data[i*4+1]/255, b = data[i*4+2]/255;
    if (ws > 0) {
      const as = Math.max(a, 0.25);
      const frRaw = (r - (1 - a) * kd[0]) / as;
      const fgRaw = (g - (1 - a) * kd[1]) / as;
      const fbRaw = (b - (1 - a) * kd[2]) / as;
      // 无解或色相不合理（G 远低于 R/B 较高者会变品红）→ 回退绿限模式
      const negOk = Math.min(frRaw, fgRaw, fbRaw) >= -0.05;
      const cl = (v) => Math.min(1, Math.max(0, v));
      let fr = Math.min(cl(frRaw), r + 0.2);
      let fg = Math.min(cl(fgRaw), g + 0.2);
      let fb = Math.min(cl(fbRaw), b + 0.2);
      const hueOk = negOk && fg >= 0.7 * Math.max(fr, fb) - 0.02;
      if (!hueOk) { fr = r; fg = Math.min(g, Math.max(r, b)); fb = b; }
      r = r * (1 - ws) + fr * ws;
      g = g * (1 - ws) + fg * ws;
      b = b * (1 - ws) + fb * ws;
    }
    out.data[i*4]   = r * 255;
    out.data[i*4+1] = g * 255;
    out.data[i*4+2] = b * 255;
    out.data[i*4+3] = 255;
  }
  // 修色完成后再做形状处理（填洞/闭运算/羽化/收缩/实化）
  const finalMatte = applyCleanup(Float32Array.from(matteRaw), params, w, h);
  // 用最终遮罩重新合成；跳过"原本是背景、被填充成实心"的像素（保留原色）
  const out2 = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = finalMatte[i];
    const skip = matteRaw[i] < 0.25 && a > 0.75;
    const k = skip ? 1 : a;
    out2.data[i*4]   = out.data[i*4]   * k + 0.13 * 255 * (1 - k);
    out2.data[i*4+1] = out.data[i*4+1] * k + 0.13 * 255 * (1 - k);
    out2.data[i*4+2] = out.data[i*4+2] * k + 0.13 * 255 * (1 - k);
    out2.data[i*4+3] = 255;
  }
  canvas.getContext("2d").putImageData(out2, 0, 0);
}
