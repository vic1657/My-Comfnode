import { app } from "../../scripts/app.js";

const TITLE_PREFIX = "启停组";
const GREEN = "#2E7D32";
const YELLOW = "#9A7B1E";
const HEADER_H = 30;
// 新建组时自动补的数字源节点类型（按顺序尝试）
const CREATE_TYPES = ["DF_Integer", "Derfuw__Derfuw_ComfyUI_Mc", "INTConstant"];

// 这些输出说明它不是「纯数值节点」，不能当数字源
const NON_VALUE_OUTPUT =
  /^(IMAGE|LATENT|MASK|VAE|MODEL|CLIP|CONDITIONING|CONTROL_NET|SEGS|BBOX|BBOX_DETECTOR|SEGM_DETECTOR|SAM_MODEL|SAM3_MODEL|SAMPLER|SIGMAS|NOISE|GUIDER|UPSCALE_MODEL|AUDIO|VIDEO|CLIP_VISION|STYLE_MODEL|GLIGEN)$/;

function alwaysMode() { return globalThis.LiteGraph?.ALWAYS ?? 0; }
function neverMode() { return globalThis.LiteGraph?.NEVER ?? 2; }

function groups() { return app.graph?._groups || []; }
function allNodes() { return app.graph?._nodes || []; }
function isToggleGroup(group) { return String(group?.title || "").startsWith(TITLE_PREFIX); }

/* ---------- 数字源识别（兼容多种「整数」节点） ---------- */

function pickIntWidget(node) {
  const ws = (node?.widgets || []).filter((w) => w && w.value !== undefined);
  if (!ws.length) return null;
  const byName = ws.find((w) =>
    /^(value|val|int|integer|num|number|整数|值|数值|数量)$/i.test(String(w.name || "").trim())
  );
  if (byName && Number.isFinite(Number(byName.value))) return byName;
  const nums = ws.filter((w) => typeof w.value === "number");
  if (nums.length === 1) return nums[0];
  return null;
}

function readSourceValue(node) {
  const w = pickIntWidget(node);
  if (!w) return null;
  const v = Number(w.value);
  return Number.isFinite(v) ? v : null;
}

function isIntSourceNode(node) {
  if (!node) return false;
  const outs = node.outputs || [];
  if (outs.some((o) => NON_VALUE_OUTPUT.test(String(o.type || "").toUpperCase()))) return false;
  return pickIntWidget(node) !== null;
}

function intSourceNodes() {
  return allNodes().filter(isIntSourceNode);
}

/* 只联动「真实、可运行」的节点：
   - 虚拟节点（Note / MarkdownNote / Reroute / PrimitiveNode 等 isVirtualNode）
   - 缺失的红节点（类型未注册，碰了会在队列序列化时出各种怪错）
   这些一律不碰，保持用户自己设置的状态。 */
function isToggleable(node) {
  if (!node || node.isVirtualNode) return false;
  const t = String(node.type || "");
  if (/^(Note|MarkdownNote|Reroute)$/i.test(t)) return false;
  const reg = globalThis.LiteGraph?.registered_node_types;
  if (reg && !reg[t]) return false; // 红节点/缺失类型
  return true;
}

/* ---------- 框标题里持久化：启用码 / 停用码 / 数字源 id ---------- */

function parseTitle(title) {
  const t = String(title || "");
  const e = /启[:：]\s*(-?\d+)/.exec(t);
  const d = /停[:：]\s*(-?\d+)/.exec(t);
  const s = /源[:：]\s*#?(\d+)/.exec(t);
  return { enable: e ? +e[1] : 1, disable: d ? +d[1] : 0, sourceId: s ? +s[1] : null };
}

function writeTitle(group, patch) {
  const cur = parseTitle(group.title);
  const next = { ...cur, ...patch };
  const nextTitle =
    `${TITLE_PREFIX} 启:${next.enable} 停:${next.disable}` +
    (next.sourceId != null ? ` 源:${next.sourceId}` : "");
  if (group.title === nextTitle) return false;
  group.title = nextTitle;
  return true;
}

function pointInRect(px, py, rect) {
  if (!rect) return false;
  return px >= rect[0] && py >= rect[1] && px <= rect[0] + rect[2] && py <= rect[1] + rect[3];
}

/* 分组框几何：新版前端存在 pos/size（Float64Array），序列化写的是这两个；
   旧版前端只有 bounding。统一走 getRect/setRect，保证存进工作流的尺寸正确。 */
function getRect(group) {
  if (!group) return null;
  const p = group.pos, s = group.size;
  if (p && s && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])) &&
      Number.isFinite(Number(s[0])) && Number.isFinite(Number(s[1])) && Number(s[0]) > 0) {
    return [Number(p[0]), Number(p[1]), Number(s[0]), Number(s[1])];
  }
  const b = group.bounding;
  if (b && b.length === 4 && Number.isFinite(Number(b[2]))) {
    return [Number(b[0]), Number(b[1]), Number(b[2]), Number(b[3])];
  }
  return null;
}

function setRect(group, x, y, w, h) {
  try { group.pos = [x, y]; group.size = [w, h]; } catch {}
  try { group.bounding = [x, y, w, h]; } catch {}
  try { group.commitBounds?.(); } catch {}
}

const DEFAULT_RECT = [10, 10, 140, 80];
function isDefaultRect(r) {
  return !!r && Math.abs(r[0] - DEFAULT_RECT[0]) < 0.6 && Math.abs(r[1] - DEFAULT_RECT[1]) < 0.6 &&
         Math.abs(r[2] - DEFAULT_RECT[2]) < 0.6 && Math.abs(r[3] - DEFAULT_RECT[3]) < 0.6;
}

// 旧版本保存的工作流里框范围会丢成默认 10,10,140,80 —— 用「数字源 + 停用中的节点」重算范围
function repairRect(group) {
  if (!isDefaultRect(getRect(group))) return false;
  const src = resolveSource(group);
  const targets = new Set(allNodes().filter((n) => n.mode === neverMode()));
  if (src) targets.add(src);
  if (!targets.size) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of targets) {
    minX = Math.min(minX, n.pos[0]);
    minY = Math.min(minY, n.pos[1]);
    maxX = Math.max(maxX, n.pos[0] + (n.size?.[0] || 200));
    maxY = Math.max(maxY, n.pos[1] + (n.size?.[1] || 100));
  }
  if (!Number.isFinite(minX)) return false;
  const pad = 36;
  setRect(group, minX - pad, minY - pad - HEADER_H, maxX - minX + pad * 2, maxY - minY + pad * 2 + HEADER_H);
  console.warn("[MyToggleGroup] 已修复丢失的分组框范围:", group.title);
  return true;
}

function containedNodes(group, exclude) {
  const r = getRect(group);
  return allNodes().filter((n) => n !== exclude && pointInRect(n.pos[0], n.pos[1], r));
}

function markDirty() {
  try { app.graph.change?.(); } catch {}
  try { app.canvas?.setDirty?.(true, true); } catch {}
}

/* ---------- 解析数字源 ---------- */

function resolveSource(group) {
  const { sourceId } = parseTitle(group.title);
  const nodes = allNodes();

  // 1) 已绑定的 id（节点 id 是字符串，统一转字符串比较）
  if (sourceId != null) {
    const bound = nodes.find((n) => String(n.id) === String(sourceId));
    if (bound && isIntSourceNode(bound)) return bound;
  }
  // 2) 框内的整数节点自动认领
  const rect = getRect(group);
  const inside = nodes.find(
    (n) => isIntSourceNode(n) && pointInRect(n.pos[0], n.pos[1], rect)
  );
  if (inside) {
    writeTitle(group, { sourceId: inside.id });
    return inside;
  }
  // 3) 整张画布只有一个整数节点时自动绑定（只有一个总开关的常见情形）
  const all = intSourceNodes();
  if (all.length === 1) {
    writeTitle(group, { sourceId: all[0].id });
    return all[0];
  }
  return null;
}

/* ---------- 求值 ---------- */

function evaluateGroup(group) {
  if (!isToggleGroup(group)) return;
  try { repairRect(group); } catch {}
  const codes = parseTitle(group.title);
  const src = resolveSource(group);
  if (!src) {
    if (group._myToggleLastState !== "unbound") {
      group._myToggleLastState = "unbound";
      markDirty();
    }
    return;
  }
  const value = readSourceValue(src);
  if (value == null) return;

  let state = null;
  if (value === Number(codes.enable)) state = "on";
  else if (value === Number(codes.disable)) state = "off";
  if (!state) return; // 其他数字：维持现状

  const enable = state === "on";
  // 强制语义（用户预期）：绿 = 组内全部真实节点启用；黄 = 全部停用。
  // 只跳过不该碰的：虚拟节点（Note/Reroute 等）和缺失的红节点。
  for (const node of containedNodes(group, src)) {
    if (!isToggleable(node)) continue;
    node.mode = enable ? alwaysMode() : neverMode();
  }
  if (group._myToggleLastState !== state) {
    group._myToggleLastState = state;
    console.log(
      `[MyToggleGroup] ${group.title} → ${enable ? "启用(绿)" : "停用(黄)"}（数字源 #${src.id} 值=${value}）`
    );
    markDirty();
  }
}

function evaluateAll() {
  for (const g of groups()) evaluateGroup(g);
}

/* ---------- 画框 + 标题栏 ---------- */

const hitBoxes = new Map(); // group → {enable:[x,y,w,h], disable:[...], source:[...]}

function drawGroupFrames(ctx) {
  for (const group of groups()) {
    if (!isToggleGroup(group)) continue;
    const b = getRect(group);
    if (!b) continue;
    const state = group._myToggleLastState;
    const color = state === "on" ? GREEN : state === "off" ? YELLOW : "#4b5260";

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(b[0], b[1], b[2], b[3], 10);
    ctx.fillStyle = color + "20";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(b[0], b[1], b[2], HEADER_H, 10);
    ctx.fillStyle = color + "3a";
    ctx.fill();
    ctx.restore();

    const boxes = {};
    try {
      ctx.save();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const cy = b[1] + HEADER_H / 2;
      let x = b[0] + 10;

      // 删除按钮（左上角红色 ✕）：删除分组并把被本组停用的节点恢复
      {
        const bw = 22, bh = 22, top = b[1] + (HEADER_H - bh) / 2;
        ctx.beginPath();
        ctx.roundRect(x, top, bw, bh, 5);
        ctx.fillStyle = "rgba(120,20,20,.9)";
        ctx.fill();
        ctx.strokeStyle = "#ff5f5f";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.font = "700 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("✕", x + bw / 2, cy + 1);
        ctx.textAlign = "left";
        boxes.delete = [x, top, bw, bh];
        x += bw + 12;
      }

      ctx.font = "700 16px sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("启停组", x, cy);
      x += ctx.measureText("启停组").width + 14;

      // 数字源 chip
      const src = resolveSource(group);
      const srcText = src ? `源:#${src.id}` : "选数字源";
      ctx.font = "600 13px sans-serif";
      const sw = ctx.measureText(srcText).width + 18;
      const sh = 22;
      const stop = b[1] + (HEADER_H - sh) / 2;
      ctx.beginPath();
      ctx.roundRect(x, stop, sw, sh, 5);
      ctx.fillStyle = src ? "rgba(20,26,34,.95)" : "rgba(90,50,10,.95)";
      ctx.fill();
      ctx.strokeStyle = src ? "#8ab4f8" : "#ff9f43";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = src ? "#a9c8ff" : "#ffb457";
      ctx.textAlign = "center";
      ctx.fillText(srcText, x + sw / 2, cy);
      ctx.textAlign = "left";
      boxes.source = [x, stop, sw, sh];
      x += sw + 14;

      const codes = parseTitle(group.title);
      const items = [
        ["启用码", codes.enable, "enable"],
        ["停用码", codes.disable, "disable"],
      ];
      for (const [label, value, key] of items) {
        ctx.fillStyle = "#dfe8f3";
        ctx.font = "600 13px sans-serif";
        ctx.fillText(label, x, cy);
        x += ctx.measureText(label).width + 6;
        const w = 48, h = 22;
        const top = b[1] + (HEADER_H - h) / 2;
        ctx.beginPath();
        ctx.roundRect(x, top, w, h, 5);
        ctx.fillStyle = "#111820";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#ffe066";
        ctx.font = "700 14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(String(value), x + w / 2, cy);
        ctx.textAlign = "left";
        boxes[key] = [x, top, w, h];
        x += w + 14;
      }

      if (!src) {
        ctx.fillStyle = "#ffb457";
        ctx.font = "600 12px sans-serif";
        ctx.fillText("← 点这里选择要监视的数字节点", x + 4, cy);
      }
      ctx.restore();
    } catch (e) {
      console.error("[MyToggleGroup] 标题绘制失败:", e);
    }
    hitBoxes.set(group, boxes);
  }
}

function installGroupDrawPatch() {
  let LGraphGroup;
  try { LGraphGroup = globalThis.LGraphGroup || globalThis.LiteGraph?.LGraphGroup; } catch {}
  if (!LGraphGroup) LGraphGroup = groups()[0]?.constructor;
  if (!LGraphGroup?.prototype) { setTimeout(installGroupDrawPatch, 300); return; }
  const proto = LGraphGroup.prototype;
  if (proto._myToggleDrawPatched) return;
  proto._myToggleDrawPatched = true;
  const orig = proto.draw;
  // 启停组由扩展自己绘制（否则原生会再画一遍框和标题，造成文字重影）
  proto.draw = function (ctx, canvas) {
    if (String(this.title || "").startsWith(TITLE_PREFIX)) return;
    return orig?.apply(this, arguments);
  };
}

function installCanvasDrawHook() {
  const canvas = app.canvas;
  // 新前端 setup() 时 canvas 可能尚未创建 —— 必须重试，否则绘制钩子永久失效
  if (!canvas) { setTimeout(installCanvasDrawHook, 300); return; }
  if (canvas._myToggleDrawHook) return;
  canvas._myToggleDrawHook = true;
  const prev = canvas.onDrawBackground;
  canvas.onDrawBackground = function (ctx, ...rest) {
    prev?.apply(this, arguments);
    try { drawGroupFrames(ctx); } catch (e) {
      console.error("[MyToggleGroup] 绘制失败:", e);
    }
  };
}

/* ---------- 数字编辑弹层 ---------- */

function closeFloaters() {
  document.querySelectorAll(".mytg-editor,.mytg-picker").forEach((el) => el.remove());
}

function openNumberEditor(group, key, screenX, screenY) {
  closeFloaters();
  const codes = parseTitle(group.title);
  const el = document.createElement("input");
  el.type = "number";
  el.className = "mytg-editor";
  el.value = key === "enable" ? codes.enable : codes.disable;
  el.style.left = `${Math.min(window.innerWidth - 90, screenX - 30)}px`;
  el.style.top = `${Math.min(window.innerHeight - 40, screenY - 12)}px`;
  document.body.append(el);
  el.focus();
  el.select();
  const commit = () => {
    const v = Math.trunc(Number(el.value));
    if (!Number.isNaN(v)) {
      writeTitle(group, key === "enable" ? { enable: v } : { disable: v });
      evaluateGroup(group);
      markDirty();
    }
    el.remove();
  };
  el.addEventListener("blur", commit);
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); el.blur(); }
    if (ev.key === "Escape") { el.remove(); }
  });
}

/* ---------- 数字源选择器 ---------- */

function openSourcePicker(group, screenX, screenY) {
  closeFloaters();
  const wrap = document.createElement("div");
  wrap.className = "mytg-picker";
  wrap.style.left = `${Math.min(window.innerWidth - 280, screenX)}px`;
  wrap.style.top = `${Math.min(window.innerHeight - 60, screenY + 6)}px`;

  const head = document.createElement("div");
  head.className = "mytg-picker-head";
  head.textContent = "选择要监视的数字节点";
  wrap.append(head);

  const cur = parseTitle(group.title).sourceId;
  const list = intSourceNodes();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "mytg-picker-item";
    empty.textContent = "画布上没有找到整数类节点";
    wrap.append(empty);
  }
  for (const n of list) {
    const item = document.createElement("div");
    item.className = "mytg-picker-item" + (String(n.id) === String(cur) ? " active" : "");
    item.textContent = `#${n.id}  ${n.type}  ·  当前 ${readSourceValue(n)}`;
    item.onclick = () => {
      writeTitle(group, { sourceId: n.id });
      group._myToggleLastState = undefined;
      evaluateGroup(group);
      markDirty();
      closeFloaters();
    };
    wrap.append(item);
  }
  const unbind = document.createElement("div");
  unbind.className = "mytg-picker-item danger";
  unbind.textContent = "解除绑定";
  unbind.onclick = () => {
    writeTitle(group, { sourceId: null });
    group._myToggleLastState = undefined;
    markDirty();
    closeFloaters();
  };
  wrap.append(unbind);

  document.body.append(wrap);
  setTimeout(() => {
    const off = (ev) => {
      if (!wrap.contains(ev.target)) {
        closeFloaters();
        document.removeEventListener("pointerdown", off, true);
      }
    };
    document.addEventListener("pointerdown", off, true);
  }, 0);
}

/* ---------- 拖拽 ---------- */

let drag = null;

function toGraphCoords(ev) {
  const canvas = app.canvas;
  // 优先用视图变换换算（与渲染完全一致）。
  // 注意：前端 1.55 的 convertEventToCanvasOffset(ev) 传事件对象会返回错误坐标，不能再用它做主路径。
  try {
    const ds = canvas.ds;
    const rect = canvas.canvas.getBoundingClientRect();
    if (ds && Number.isFinite(ds.scale) && ds.scale > 0 && ds.offset) {
      return [
        (ev.clientX - rect.left - ds.offset[0]) / ds.scale,
        (ev.clientY - rect.top - ds.offset[1]) / ds.scale,
      ];
    }
  } catch {}
  try {
    const p = canvas.convertEventToCanvasOffset(ev.clientX, ev.clientY);
    if (p) return [p[0], p[1]];
  } catch {}
  const ds = canvas.ds;
  const rect = canvas.canvas.getBoundingClientRect();
  return [
    (ev.clientX - rect.left - ds.offset[0]) / ds.scale,
    (ev.clientY - rect.top - ds.offset[1]) / ds.scale,
  ];
}

function nodeHitAt(x, y) {
  for (const n of allNodes()) {
    const w = n.size?.[0] || 0, h = n.size?.[1] || 0;
    if (x >= n.pos[0] - 6 && x <= n.pos[0] + w + 6 && y >= n.pos[1] - 6 && y <= n.pos[1] + h + 6) return n;
  }
  return null;
}

function toggleGroupAt(x, y) {
  const list = groups().filter(isToggleGroup);
  for (let i = list.length - 1; i >= 0; i--) {
    if (pointInRect(x, y, getRect(list[i]))) return list[i];
  }
  return null;
}

function deleteToggleGroup(group) {
  if (!group) return;
  // 恢复组内全部真实节点为启用（删掉开关后节点应可用）
  for (const node of containedNodes(group)) {
    if (isToggleable(node)) node.mode = alwaysMode();
    node._myToggleDisabledByToggle = false;
  }
  hitBoxes.delete(group);
  closeFloaters();
  // 多重删除兜底：不同前端版本 groups 的存储/接口不一样
  let removed = false;
  try { app.graph.remove(group); removed = true; } catch {}
  if (!removed) {
    try { group.remove?.(); removed = true; } catch {}
  }
  const arr = app.graph._groups;
  const i = arr ? arr.indexOf(group) : -1;
  if (i >= 0) { arr.splice(i, 1); removed = true; }
  try { if (app.graph._groups_by_id && group.id != null) delete app.graph._groups_by_id[group.id]; } catch {}
  markDirty();
  try { app.canvas.setDirty(true, true); } catch {}
  console.log("[MyToggleGroup] 删除分组:", group.title, "| 移除成功:", removed,
    "| 剩余启停组:", groups().filter(isToggleGroup).length);
}

function installPointerHandlers() {
  if (document._myTogglePointerHook) return;
  document._myTogglePointerHook = true;

  document.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const canvasEl = app.canvas?.canvas;
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    if (ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom) return;
    const [gx, gy] = toGraphCoords(ev);
    const group = toggleGroupAt(gx, gy);
    if (!group) return;

    const boxes = hitBoxes.get(group);
    if (boxes) {
      // 0) 删除按钮（左上角 ✕）
      if (boxes.delete && pointInRect(gx, gy, boxes.delete)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        deleteToggleGroup(group);
        return;
      }
      // 1) 数字源 chip
      if (boxes.source && pointInRect(gx, gy, boxes.source)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        openSourcePicker(group, ev.clientX, ev.clientY);
        return;
      }
      // 2) 启用码/停用码
      for (const key of ["enable", "disable"]) {
        if (boxes[key] && pointInRect(gx, gy, boxes[key])) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          openNumberEditor(group, key, ev.clientX, ev.clientY);
          return;
        }
      }
    }

    // 3) 点在节点上 → 交给原生拖拽
    if (nodeHitAt(gx, gy)) return;

    // 4) 空白/标题栏 → 拖动整组
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const src = resolveSource(group);
    drag = {
      group,
      startX: gx,
      startY: gy,
      rect: getRect(group),
      nodes: containedNodes(group, src).map((n) => ({ n, pos: [n.pos[0], n.pos[1]] })),
    };
    try { app.canvas.canvas.style.cursor = "grabbing"; } catch {}
  }, true);

  window.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const [gx, gy] = toGraphCoords(ev);
    const dx = gx - drag.startX;
    const dy = gy - drag.startY;
    setRect(drag.group, drag.rect[0] + dx, drag.rect[1] + dy, drag.rect[2], drag.rect[3]);
    for (const item of drag.nodes) {
      item.n.pos[0] = item.pos[0] + dx;
      item.n.pos[1] = item.pos[1] + dy;
    }
    app.canvas.setDirty(true, true);
  }, true);

  window.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    try { app.canvas.canvas.style.cursor = ""; } catch {}
    markDirty();
  }, true);
}

/* ---------- 样式 ---------- */

function injectStyles() {
  if (document.getElementById("my-toggle-group-style")) return;
  const style = document.createElement("style");
  style.id = "my-toggle-group-style";
  style.textContent = `
    .mytg-editor{position:fixed;z-index:100000;width:70px;background:#20262e;color:#fff;
      border:2px solid #4b9cff;border-radius:5px;padding:3px 5px;font:600 13px sans-serif;text-align:center}
    .mytg-picker{position:fixed;z-index:100001;min-width:250px;max-height:320px;overflow:auto;
      background:#1b2028;border:1px solid #3a4553;border-radius:8px;padding:5px;
      box-shadow:0 10px 28px rgba(0,0,0,.55);font:13px sans-serif}
    .mytg-picker-head{padding:5px 10px 7px;color:#8fa3bb;font-size:12px}
    .mytg-picker-item{padding:6px 10px;border-radius:5px;color:#dfe8f3;cursor:pointer;white-space:nowrap}
    .mytg-picker-item:hover{background:#2a3441}
    .mytg-picker-item.active{background:#243752;color:#a9c8ff}
    .mytg-picker-item.danger{color:#ff9f43;margin-top:2px;border-top:1px solid #2c3644;border-radius:0 0 5px 5px}
  `;
  document.head.append(style);
}

/* ---------- 新建启停组 ---------- */

function createToggleGroupFromSelection(selectedNodes) {
  const graph = app.graph;
  if (!graph || !selectedNodes?.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of selectedNodes) {
    minX = Math.min(minX, n.pos[0]);
    minY = Math.min(minY, n.pos[1]);
    maxX = Math.max(maxX, n.pos[0] + (n.size?.[0] || 200));
    maxY = Math.max(maxY, n.pos[1] + (n.size?.[1] || 100));
  }
  const pad = 36;
  let LGraphGroup;
  try { LGraphGroup = globalThis.LGraphGroup || globalThis.LiteGraph?.LGraphGroup; } catch {}
  if (!LGraphGroup && groups().length) LGraphGroup = groups()[0].constructor;
  if (!LGraphGroup) { alert("当前前端版本不支持创建分组"); return null; }

  const group = new LGraphGroup();
  graph.add(group);
  setRect(group, minX - pad, minY - pad - HEADER_H, maxX - minX + pad * 2, maxY - minY + pad * 2 + HEADER_H);
  const rect = getRect(group);

  // 数字源优先级：选中的整数节点 > 框内已有的 > 画布唯一的 > 新建一个
  let src = selectedNodes.find(isIntSourceNode) || null;
  if (!src) src = allNodes().find((n) => isIntSourceNode(n) && pointInRect(n.pos[0], n.pos[1], rect)) || null;
  if (!src && intSourceNodes().length === 1) src = intSourceNodes()[0];
  if (!src) {
    for (const t of CREATE_TYPES) {
      const created = globalThis.LiteGraph?.createNode ? globalThis.LiteGraph.createNode(t) : null;
      if (!created) continue;
      created.pos = [rect[0] + 14, rect[1] + HEADER_H + 52];
      const w = pickIntWidget(created);
      if (w) w.value = 1;
      graph.add(created);
      src = created;
      break;
    }
  }

  writeTitle(group, { enable: 1, disable: 0, sourceId: src ? src.id : null });
  installGroupDrawPatch();
  markDirty();
  evaluateGroup(group);
  return group;
}

function installNodeMenu() {
  let CanvasClass;
  try { CanvasClass = globalThis.LGraphCanvas || app.canvas?.constructor; } catch {}
  if (!CanvasClass?.prototype) { setTimeout(installNodeMenu, 250); return; }
  if (CanvasClass.prototype._myToggleGroupMenuInstalled) return;
  CanvasClass.prototype._myToggleGroupMenuInstalled = true;

  const original = CanvasClass.prototype.getNodeMenuOptions;
  CanvasClass.prototype.getNodeMenuOptions = function (node) {
    const options = original?.apply(this, arguments) || [];
    if (!node) return options;
    const selectedList = Object.values(this.selected_nodes || {}).filter(Boolean);
    const isSelected = !!this.selected_nodes?.[node.id] || !!node.selected || selectedList.length > 0;
    // 右键的是「整数节点」且它是唯一选中项时不显示（避免把数字源自己圈进去）
    if (isIntSourceNode(node) && selectedList.length <= 1) return options;
    if (!isSelected) return options;
    const doCreate = () => {
      const selected = Object.values(this.selected_nodes || {});
      if (!selected.length && node) selected.push(node);
      createToggleGroupFromSelection(selected);
    };
    // 平铺菜单项：不依赖前端的二级菜单能力，任何版本都能直接点
    options.unshift({
      content: "My-Comfnode · 新建启停组",
      callback: doCreate,
    });
    return options;
  };
}

/* ---------- 注册 ---------- */

function registerOnce() {
  if (globalThis.__myToggleExtensionRegistered) return;
  globalThis.__myToggleExtensionRegistered = true;

  app.registerExtension({
  name: "MyComfnode.ToggleGroup",
  setup() {
    injectStyles();
    installNodeMenu();
    installCanvasDrawHook();
    installGroupDrawPatch();
    installPointerHandlers();
    installQueueGuard();
    installQueuePromptGuard();
    setInterval(() => {
      // 自愈：画布实例若被前端重建，重新挂绘制钩子
      try { if (app.canvas && !app.canvas._myToggleDrawHook) installCanvasDrawHook(); } catch {}
      evaluateAll();
    }, 400);
    setTimeout(evaluateAll, 1200);
  },
  });
}

/* ---------- 队列序列化守卫 ----------
   现象：某些扩展会包装 app.graphToPrompt 并在内部出错时返回 undefined，
   导致队列报 "Cannot read properties of undefined (reading 'output'/'workflow')"
   这种把真实错误吞掉的谜语报错。这里做两件事：
   1) 真实错误原样打进控制台（带 [My-Comfnode] 前缀，方便定位）；
   2) 若返回结果被破坏（undefined / 缺 output），回退到 ComfyUI 原生实现，让队列继续走通。 */
function installQueueGuard() {
  // 延迟安装，保证我们是链路最外层；只在第一次生效
  const tryInstall = () => {
    if (globalThis.__myQueueGuardInstalled) return;
    if (!globalThis.app?.graphToPrompt) { setTimeout(tryInstall, 500); return; }
    globalThis.__myQueueGuardInstalled = true;
    const prev = globalThis.app.graphToPrompt;
    const wrapped = async function (...args) {
      let res;
      try {
        res = await prev.apply(this, args);
      } catch (e) {
        console.error("[My-Comfnode] 工作流序列化失败（真实错误如下）:", e && (e.stack || e));
        throw e;
      }
      if (!res || !res.output) {
        console.warn("[My-Comfnode] graphToPrompt 返回了空结果（被其它扩展吞错），回退到原生实现重试");
        res = await Object.getPrototypeOf(globalThis.app).graphToPrompt.call(globalThis.app, ...args);
      }
      return res;
    };
    globalThis.app.graphToPrompt = wrapped;
  };
  setTimeout(tryInstall, 2000);
}

/* ---------- 运行(queuePrompt)守卫 ----------
   与 graphToPrompt 守卫同理：不管哪个扩展在运行链路里抛错，
   都把完整堆栈原样打进控制台（带 [My-Comfnode] 前缀），再原样抛出让 ComfyUI 正常显示。 */
function installQueuePromptGuard() {
  const tryInstall = () => {
    if (globalThis.__myQueuePromptGuardInstalled) return;
    if (!globalThis.app?.queuePrompt) { setTimeout(tryInstall, 500); return; }
    globalThis.__myQueuePromptGuardInstalled = true;
    const prev = globalThis.app.queuePrompt;
    const wrapped = async function (...args) {
      try {
        return await prev.apply(this, args);
      } catch (e) {
        console.error("[My-Comfnode] 运行失败·完整堆栈（请把这段截图）:", e && (e.stack || e));
        throw e;
      }
    };
    globalThis.app.queuePrompt = wrapped;
  };
  setTimeout(tryInstall, 2500);
}

registerOnce();

globalThis.__myToggle = {
  evaluateAll,
  evaluateGroup,
  createToggleGroupFromSelection,
  deleteToggleGroup,
  drawGroupFrames,
  parseTitle,
  writeTitle,
  resolveSource,
  intSourceNodes,
  isIntSourceNode,
  readSourceValue,
  getRect,
  setRect,
  repairRect,
  isDefaultRect,
  getDrag: () => drag,
  toggleGroupAt,
  nodeHitAt,
  toGraphCoords,
  openSourcePicker,
  getHitBoxes: () => hitBoxes,
};
