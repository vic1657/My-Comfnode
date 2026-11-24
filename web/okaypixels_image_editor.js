// OkayPixels-style full-screen image editor for the ComfyUI CanvasPaint node.
// Native DOM/canvas implementation to avoid adding a Vue build step inside ComfyUI.

const OP_EDITOR_STYLE_ID = "okaypixels-comfy-image-editor-style";
const OP_EDITOR_ROOT_ID = "okaypixels-comfy-image-editor";
const OP_COLORS = ["#ffffff", "#f0a030", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#000000"];
const OP_OUTPAINT_MIN_SIZE = 64;
const OP_CROP_PRESET_DEFS = [
    { key: "free", label: "自由裁剪", ratio: null },
    { key: "original", label: "原图比例", ratio: "original" },
    { key: "1-1", label: "正方形 1:1", ratio: 1 },
    { key: "16-9", label: "横版 16:9", ratio: 16 / 9 },
    { key: "9-16", label: "竖版 9:16", ratio: 9 / 16 },
    { key: "4-3", label: "照片 4:3", ratio: 4 / 3 },
    { key: "3-4", label: "竖版 3:4", ratio: 3 / 4 },
];
const OP_OUTPAINT_RATIOS = [
    { key: "original", label: "原始", ratio: null, icon: { w: 18, h: 13 } },
    { key: "1:1", label: "1:1", ratio: 1, icon: { w: 14, h: 14 } },
    { key: "16:9", label: "16:9", ratio: 16 / 9, icon: { w: 18, h: 10 } },
    { key: "9:16", label: "9:16", ratio: 9 / 16, icon: { w: 10, h: 18 } },
    { key: "4:3", label: "4:3", ratio: 4 / 3, icon: { w: 17, h: 13 } },
];

function injectEditorStyle() {
    if (document.getElementById(OP_EDITOR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = OP_EDITOR_STYLE_ID;
    style.textContent = `
#${OP_EDITOR_ROOT_ID}{position:fixed;inset:0;z-index:100000;background:#0a0d15;color:#e5e7eb;font-family:Inter,Arial,"Microsoft YaHei",sans-serif;display:flex;flex-direction:column;user-select:none}
#${OP_EDITOR_ROOT_ID} *{box-sizing:border-box}
.op-ie-topbar{height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border-bottom:1px solid rgba(255,255,255,.08);background:#11141d}
.op-ie-topbar__side,.op-ie-topbar__center{display:flex;align-items:center;gap:8px}
.op-ie-btn,.op-ie-icon-btn,.op-ie-tool-btn,.op-ie-sub-btn,.op-ie-layer-row,.op-ie-ratio-btn{border:1px solid rgba(255,255,255,.1);background:#1b1f2a;color:#e5e7eb;border-radius:6px;min-height:28px;padding:0 10px;cursor:pointer;font:12px inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.op-ie-btn:hover,.op-ie-icon-btn:hover,.op-ie-tool-btn:hover,.op-ie-sub-btn:hover,.op-ie-layer-row:hover,.op-ie-ratio-btn:hover{background:#252b38;border-color:rgba(255,255,255,.18)}
.op-ie-btn--save{background:#f59e0b;border-color:#f59e0b;color:#fff}
.op-ie-btn--save:hover{background:#f6a821}
.op-ie-btn.saving,.op-ie-btn:disabled{opacity:.72;cursor:wait;pointer-events:none}.op-ie-spinner{width:13px;height:13px;border:2px solid rgba(255,255,255,.42);border-top-color:#fff;border-radius:50%;display:inline-block;animation:op-ie-spin .75s linear infinite}@keyframes op-ie-spin{to{transform:rotate(360deg)}}
.op-ie-title{font-weight:700;font-size:13px}.op-ie-meta,.op-ie-zoom{font-size:11px;color:#9ca3af;background:#1d2230;border-radius:5px;padding:4px 8px}
.op-ie-subbar{height:38px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid rgba(255,255,255,.08);background:#0e1119}
.op-ie-btn.active,.op-ie-sub-btn.active,.op-ie-tool-btn.active,.op-ie-layer-row.active,.op-ie-ratio-btn.active{background:#f59e0b1f;border-color:#f59e0b;color:#fbbf24}
.op-ie-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:#cbd5e1}.op-ie-toggle input{accent-color:#f59e0b}
.op-ie-sep{width:1px;height:22px;background:rgba(255,255,255,.1)}
.op-ie-swatches{display:flex;gap:5px}.op-ie-swatch{width:22px;height:22px;border-radius:5px;border:2px solid transparent;cursor:pointer}.op-ie-swatch.active{border-color:#fff;box-shadow:0 0 0 1px #fff}
.op-ie-color{width:24px;height:24px;border:0;background:transparent;padding:0}
.op-ie-slider{display:flex;align-items:center;gap:6px;font-size:11px;color:#aeb6c2}.op-ie-slider input{width:110px;accent-color:#3b82f6}.op-ie-slider b{min-width:38px;text-align:right;color:#e5e7eb}
.op-ie-body{flex:1;min-height:0;display:grid;grid-template-columns:72px minmax(0,1fr) 280px}
.op-ie-toolbar{border-right:1px solid rgba(255,255,255,.08);background:#0d1018;padding:12px 8px;display:flex;flex-direction:column;gap:8px;overflow:auto}
.op-ie-tool-btn{min-height:54px;flex-direction:column;padding:7px 4px;font-size:11px;line-height:1.15;border-radius:8px}.op-ie-tool-btn i{font-size:18px}.op-ie-toolbar-sep{height:1px;background:rgba(255,255,255,.08);margin:4px 4px}
.op-ie-stage-wrap{position:relative;overflow:hidden;background:#070a10;background-image:linear-gradient(45deg,#0c0f17 25%,transparent 25%),linear-gradient(-45deg,#0c0f17 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#0c0f17 75%),linear-gradient(-45deg,transparent 75%,#0c0f17 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}
.op-ie-stage{position:absolute;left:0;top:0;transform-origin:0 0;box-shadow:0 16px 70px rgba(0,0,0,.6);will-change:transform}
.op-ie-stage canvas{position:absolute;left:0;top:0}.op-ie-canvas{background:transparent}.op-ie-preview{pointer-events:auto}.op-ie-frame{--op-frame-scale:1;position:absolute;border:1.5px solid #f59e0b;box-shadow:0 0 0 9999px rgba(0,0,0,.25);cursor:move;will-change:left,top,width,height}.op-ie-frame__handle{position:absolute;background:#f59e0b;border:2px solid #0b0f17;box-shadow:0 2px 8px rgba(0,0,0,.35);transform:scale(var(--op-frame-scale));transform-origin:center}.op-ie-frame__handle.nw,.op-ie-frame__handle.ne,.op-ie-frame__handle.sw,.op-ie-frame__handle.se{width:18px;height:18px;border-radius:5px}.op-ie-frame__handle.nw{left:-9px;top:-9px;cursor:nwse-resize}.op-ie-frame__handle.ne{right:-9px;top:-9px;cursor:nesw-resize}.op-ie-frame__handle.sw{left:-9px;bottom:-9px;cursor:nesw-resize}.op-ie-frame__handle.se{right:-9px;bottom:-9px;cursor:nwse-resize}.op-ie-frame__handle.n,.op-ie-frame__handle.s{left:calc(50% - 18px);width:36px;height:10px;border-radius:999px}.op-ie-frame__handle.n{top:-6px;cursor:ns-resize}.op-ie-frame__handle.s{bottom:-6px;cursor:ns-resize}.op-ie-frame__handle.e,.op-ie-frame__handle.w{top:calc(50% - 18px);width:10px;height:36px;border-radius:999px}.op-ie-frame__handle.e{right:-6px;cursor:ew-resize}.op-ie-frame__handle.w{left:-6px;cursor:ew-resize}
.op-ie-brush-cursor{position:absolute;left:0;top:0;width:16px;height:16px;border:1.5px solid rgba(255,255,255,.95);border-radius:50%;pointer-events:none;z-index:7;transform:translate(-50%,-50%);box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 12px rgba(0,0,0,.35);mix-blend-mode:normal;will-change:left,top,width,height}.op-ie-brush-cursor.brush{border-color:var(--cursor-color,#fff);background:color-mix(in srgb,var(--cursor-color,#fff) 14%,transparent)}.op-ie-brush-cursor.eraser{border-color:rgba(255,255,255,.95);background:radial-gradient(circle,rgba(255,255,255,.22) 0%,rgba(255,255,255,.14) var(--soft-core,0%),rgba(255,255,255,.035) 62%,rgba(255,255,255,0) 100%)}
.op-ie-rotate{position:absolute;width:30px;height:30px;border-radius:50%;border:1px solid #f59e0b;background:#111827;color:#fbbf24;font-size:15px;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 12px rgba(0,0,0,.45);transform:scale(var(--op-frame-scale));transform-origin:center}.op-ie-rotate.nw{left:calc(-61px * var(--op-frame-scale));top:calc(-61px * var(--op-frame-scale))}.op-ie-rotate.ne{right:calc(-61px * var(--op-frame-scale));top:calc(-61px * var(--op-frame-scale))}.op-ie-rotate.sw{left:calc(-61px * var(--op-frame-scale));bottom:calc(-61px * var(--op-frame-scale))}.op-ie-rotate.se{right:calc(-61px * var(--op-frame-scale));bottom:calc(-61px * var(--op-frame-scale))}
.op-ie-crop-actions{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);display:flex;gap:10px;padding:10px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.72);border-radius:10px;backdrop-filter:blur(12px)}
.op-ie-layers{border-left:1px solid rgba(255,255,255,.08);background:#0d1018;padding:12px;display:flex;flex-direction:column;gap:12px;min-width:0}
.op-ie-layers__header{display:flex;flex-direction:column;align-items:stretch;gap:8px;font-size:13px}.op-ie-layer-tools{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.op-ie-layer-tool{min-width:0;padding:0 5px;gap:4px;font-size:11px;white-space:nowrap}.op-ie-layer-tool:disabled{opacity:.4;cursor:not-allowed}.op-ie-mask-menu{position:absolute;right:0;top:34px;z-index:4;display:none;grid-template-columns:1fr;gap:6px;width:112px;padding:7px;border:1px solid rgba(148,163,184,.28);border-radius:7px;background:#121722;box-shadow:0 10px 24px rgba(0,0,0,.42)}.op-ie-mask-menu.open{display:grid}.op-ie-mask-option{height:28px;border:1px solid rgba(255,255,255,.1);border-radius:5px;background:#202635;color:#e5e7eb;cursor:pointer}.op-ie-mask-option:hover{border-color:#60a5fa;color:#fff;background:#273349}.op-ie-layer-list{display:flex;flex-direction:column;gap:8px;overflow:auto;max-height:340px}
.op-ie-layer-row{width:100%;min-height:58px;text-align:left;justify-content:flex-start;padding:8px;border-radius:8px;gap:6px;position:relative;transition:border-color .14s ease,background .14s ease,opacity .14s ease,transform .14s ease}.op-ie-layer-row.dragging{opacity:.48;transform:scale(.985)}.op-ie-layer-row.drop-before:before,.op-ie-layer-row.drop-after:after{content:"";position:absolute;left:8px;right:8px;height:2px;border-radius:999px;background:#f59e0b;box-shadow:0 0 12px rgba(245,158,11,.55)}.op-ie-layer-row.drop-before:before{top:-5px}.op-ie-layer-row.drop-after:after{bottom:-5px}.op-ie-layer-thumb{width:40px;height:40px;border-radius:6px;background:#3b2a18;background-size:cover;background-position:center;flex:0 0 auto}.op-ie-layer-main{min-width:0;display:flex;flex-direction:column;flex:1;gap:3px}.op-ie-layer-main b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.op-ie-layer-main small{font-size:10px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.op-ie-layer-actions{display:flex;gap:4px;align-items:center;flex:0 0 auto}.op-ie-layer-actions button,.op-ie-layer-drag{width:24px;height:24px;border:1px solid rgba(255,255,255,.08);border-radius:6px;background:rgba(255,255,255,.04);color:#aeb6c2;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;font-size:12px;line-height:1}.op-ie-layer-actions button:hover,.op-ie-layer-drag:hover{border-color:rgba(245,158,11,.42);color:#fff;background:rgba(245,158,11,.12)}.op-ie-layer-actions button.active{border-color:rgba(245,158,11,.52);color:#fbbf24;background:rgba(245,158,11,.14)}.op-ie-layer-actions button:disabled,.op-ie-layer-drag:disabled{opacity:.38;cursor:not-allowed}.op-ie-layer-actions svg,.op-ie-layer-drag svg,.op-ie-layers__header svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.8;fill:none;stroke-linecap:round;stroke-linejoin:round}.op-ie-layer-row[data-draggable=true] .op-ie-layer-drag{color:#7d8797;cursor:grab}.op-ie-layer-row[data-draggable=true] .op-ie-layer-drag:active{cursor:grabbing}.op-ie-layer-row.active .op-ie-layer-drag{color:#fbbf24}
.op-ie-layer-row.mask-layer{border-color:rgba(59,130,246,.34)}.op-ie-layer-row.mask-layer.active{border-color:#60a5fa;background:rgba(59,130,246,.16)}.op-ie-layer-row.mask-layer .op-ie-layer-thumb{outline:1px solid rgba(96,165,250,.6)}
.op-ie-layer-mask-check{appearance:none;width:17px;height:17px;flex:0 0 17px;margin:0 1px;border:1.5px solid #64748b;border-radius:4px;background:#111827;cursor:pointer;display:grid;place-items:center}.op-ie-layer-mask-check:before{content:"";width:8px;height:4px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) scale(0);transition:transform .1s ease}.op-ie-layer-mask-check:checked{border-color:#3b82f6;background:#2563eb}.op-ie-layer-mask-check:checked:before{transform:rotate(-45deg) scale(1)}.op-ie-layer-mask-check:disabled{opacity:.25;cursor:not-allowed}.op-ie-layer-row.mask-source-selected{border-color:rgba(59,130,246,.72);box-shadow:inset 0 0 0 1px rgba(59,130,246,.2)}
.op-ie-layer-detail{font-size:12px;color:#aeb6c2;display:flex;flex-direction:column;gap:7px}.op-ie-layer-detail input{width:100%;accent-color:#3b82f6}
.op-ie-eraser-popover{position:absolute;z-index:9;width:190px;border:1px solid rgba(255,255,255,.13);border-radius:12px;background:rgba(18,22,32,.96);box-shadow:0 18px 54px rgba(0,0,0,.5);backdrop-filter:blur(16px);padding:12px;display:flex;flex-direction:column;gap:12px}.op-ie-eraser-popover:before{content:"";position:absolute;left:-7px;top:22px;width:12px;height:12px;transform:rotate(45deg);background:rgba(18,22,32,.96);border-left:1px solid rgba(255,255,255,.13);border-bottom:1px solid rgba(255,255,255,.13)}.op-ie-eraser-popover__head{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#e5e7eb}.op-ie-eraser-popover__preview{height:38px;border-radius:8px;background:linear-gradient(90deg,rgba(255,255,255,.08),rgba(255,255,255,.02));display:flex;align-items:center;justify-content:center;overflow:hidden}.op-ie-eraser-preview-dot{width:30px;height:30px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.82) 0%,rgba(255,255,255,.58) var(--soft-core,0%),rgba(255,255,255,.16) 64%,rgba(255,255,255,0) 100%);border:1px solid rgba(255,255,255,.28)}.op-ie-eraser-popover label{display:flex;flex-direction:column;gap:6px;font-size:11px;color:#aeb6c2}.op-ie-eraser-popover input{width:100%;accent-color:#f59e0b}.op-ie-eraser-popover b{font-weight:600;color:#fff}
.op-ie-pen-popover{position:absolute;z-index:9;width:224px;border:1px solid rgba(255,255,255,.13);border-radius:12px;background:rgba(18,22,32,.96);box-shadow:0 18px 54px rgba(0,0,0,.5);backdrop-filter:blur(16px);padding:10px;display:flex;flex-direction:column;gap:6px}.op-ie-pen-popover:before{content:"";position:absolute;left:-7px;top:22px;width:12px;height:12px;transform:rotate(45deg);background:rgba(18,22,32,.96);border-left:1px solid rgba(255,255,255,.13);border-bottom:1px solid rgba(255,255,255,.13)}.op-ie-pen-popover__head{font-size:12px;font-weight:700;color:#e8edf5;padding:2px 4px 6px}.op-ie-pen-popover__item{width:100%;display:flex;align-items:flex-start;gap:10px;text-align:left;border:1px solid transparent;border-radius:9px;background:transparent;color:#dbe4f0;padding:9px;cursor:pointer}.op-ie-pen-popover__item:hover{border-color:rgba(245,158,11,.32);background:rgba(245,158,11,.12)}.op-ie-pen-popover__item i{font-size:19px;color:#f0a030;line-height:1.1}.op-ie-pen-popover__item span{display:flex;flex-direction:column;gap:3px}.op-ie-pen-popover__item strong{font-size:12px}.op-ie-pen-popover__item small{font-size:10px;color:#9ca3af;line-height:1.35}
.op-ie-pop-mask,.op-ie-outpaint-mask,.op-ie-crop-mask{position:absolute;inset:0;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;z-index:8;padding:20px}.op-ie-panel{width:min(760px,88vw);max-height:84vh;overflow:auto;border:1px solid rgba(255,255,255,.12);background:#151924;border-radius:14px;box-shadow:0 26px 80px rgba(0,0,0,.55);padding:16px}.op-ie-panel__header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.op-ie-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.op-ie-ratio-btn{min-height:70px;flex-direction:column}.op-ie-ratio-icon{display:block;border:2px solid rgba(245,158,11,.75);border-radius:3px;background:#f59e0b1a}
.op-ie-crop-panel{width:min(520px,calc(100vw - 40px));border:1px solid rgba(255,255,255,.12);border-radius:10px;background:#141722;box-shadow:0 24px 80px rgba(0,0,0,.58);overflow:hidden}.op-ie-crop-panel__header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}.op-ie-crop-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:14px}.op-ie-crop-option{display:flex;align-items:center;gap:10px;min-height:52px;padding:10px;border:1px solid rgba(255,255,255,.1);border-radius:8px;background:rgba(255,255,255,.06);color:#e8edf5;font-size:13px;cursor:pointer}.op-ie-crop-option:hover{border-color:rgba(240,160,48,.48);background:rgba(240,160,48,.12)}.op-ie-crop-option__icon-wrap{flex:0 0 44px;height:34px;display:inline-flex;align-items:center;justify-content:center}.op-ie-crop-option__icon{display:block;flex:0 0 auto;border:2px solid #f0a030;border-radius:4px;background:rgba(240,160,48,.12)}
.op-ie-outpaint-panel{width:min(720px,calc(100vw - 40px));max-height:calc(100vh - 40px);display:flex;flex-direction:column;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:#141722;box-shadow:0 24px 80px rgba(0,0,0,.58);overflow:hidden}.op-ie-outpaint-head,.op-ie-outpaint-controls,.op-ie-outpaint-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.08)}.op-ie-outpaint-head strong{font-size:14px}.op-ie-outpaint-controls{justify-content:flex-start;flex-wrap:wrap}.op-ie-outpaint-controls label{display:inline-flex;align-items:center;gap:8px;color:rgba(232,237,245,.72);font-size:12px}.op-ie-outpaint-controls input{width:80px;height:30px;border:1px solid rgba(255,255,255,.1);border-radius:6px;background:rgba(255,255,255,.08);color:#fff;padding:0 8px}.op-ie-outpaint-ratios{display:inline-flex;align-items:center;gap:6px;margin-left:4px}.op-ie-outpaint-ratio{height:30px;min-width:42px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px;border:1px solid rgba(255,255,255,.1);border-radius:7px;background:rgba(255,255,255,.055);color:rgba(232,237,245,.72);font-size:11px;cursor:pointer}.op-ie-outpaint-ratio:hover,.op-ie-outpaint-ratio.active{border-color:rgba(240,160,48,.64);background:rgba(240,160,48,.16);color:#fff}.op-ie-outpaint-ratio i{display:inline-block;flex:0 0 auto;max-width:18px;max-height:18px;border:1.5px solid currentColor;border-radius:3px;opacity:.82}.op-ie-outpaint-stage{position:relative;height:min(420px,calc(100vh - 212px));min-height:260px;box-sizing:border-box;overflow:hidden;background:repeating-conic-gradient(rgba(255,255,255,.04) 0% 25%,transparent 0% 50%) 0 0/20px 20px,#0b0e15;touch-action:none}.op-ie-outpaint-frame{position:absolute;border:2px solid #f0a030;background:transparent;box-sizing:border-box;overflow:visible;box-shadow:0 0 0 1px rgba(240,160,48,.18),0 18px 48px rgba(0,0,0,.32);will-change:left,top,width,height}.op-ie-outpaint-original{position:absolute;border:1px solid rgba(255,255,255,.36);box-sizing:border-box;background-color:transparent;background-position:center;background-repeat:no-repeat;background-size:100% 100%;pointer-events:none;will-change:left,top,width,height}.op-ie-outpaint-handle{position:absolute;border:1px solid rgba(6,8,12,.92);background:#f6f7fb;box-shadow:0 0 0 1px rgba(255,255,255,.18),0 2px 8px rgba(0,0,0,.38);touch-action:none}.op-ie-outpaint-handle.corner{width:10px;height:10px;border-radius:3px}.op-ie-outpaint-handle.edge{border-radius:999px}.op-ie-outpaint-handle.nw{left:-6px;top:-6px;cursor:nwse-resize}.op-ie-outpaint-handle.ne{right:-6px;top:-6px;cursor:nesw-resize}.op-ie-outpaint-handle.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.op-ie-outpaint-handle.se{right:-6px;bottom:-6px;cursor:nwse-resize}.op-ie-outpaint-handle.n,.op-ie-outpaint-handle.s{left:calc(50% - 12px);width:24px;height:6px;cursor:ns-resize}.op-ie-outpaint-handle.n{top:-5px}.op-ie-outpaint-handle.s{bottom:-5px}.op-ie-outpaint-handle.e,.op-ie-outpaint-handle.w{top:calc(50% - 12px);width:6px;height:24px;cursor:ew-resize}.op-ie-outpaint-handle.e{right:-5px}.op-ie-outpaint-handle.w{left:-5px}.op-ie-outpaint-footer{border-bottom:0}.op-ie-outpaint-size{font-size:12px;color:#cbd5e1}
.op-ie-hidden{display:none!important}`;
    document.head.appendChild(style);
}

function imageFromSrc(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

function uid(prefix = "op") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneStroke(stroke) {
    return {
        ...stroke,
        points: (stroke.points || []).map(p => ({ ...p })),
    };
}

function cloneShape(shape) {
    return {
        ...shape,
        points: shape.points ? shape.points.map(p => ({ ...p })) : shape.points,
    };
}

function cloneBezierPath(path) {
    return {
        ...path,
        anchors: (path.anchors || []).map(anchor => ({
            ...anchor,
            handleIn: { ...(anchor.handleIn || { x: 0, y: 0 }) },
            handleOut: { ...(anchor.handleOut || { x: 0, y: 0 }) },
        })),
    };
}

function serializeLayerForProject(layer) {
    return {
        id: layer.id || uid("layer"),
        name: layer.name || "Layer",
        type: layer.type || "paint",
        visible: layer.visible !== false,
        opacity: Number.isFinite(layer.opacity) ? layer.opacity : 1,
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        w: Math.max(1, Number(layer.w) || 1),
        h: Math.max(1, Number(layer.h) || 1),
        rotation: Number(layer.rotation) || 0,
        locked: !!layer.locked,
        color: layer.color || "",
        maskMode: layer.maskMode === "inverse" ? "inverse" : "positive",
        src: layer.src || layer.image?.src || "",
        maskSrc: layer.maskSrc || layer.maskImage?.src || "",
        strokes: (layer.strokes || []).map(cloneStroke),
        eraseStrokes: (layer.eraseStrokes || []).map(cloneStroke),
        shapes: (layer.shapes || []).map(cloneShape),
        bezierPaths: (layer.bezierPaths || []).map(cloneBezierPath),
    };
}

function cropIconSize(ratio) {
    const maxW = 38;
    const maxH = 28;
    if (!ratio) return { w: 34, h: 22 };
    const safeRatio = Math.max(0.2, Number(ratio) || 1);
    if (safeRatio >= maxW / maxH) {
        return { w: maxW, h: Math.max(10, Math.round(maxW / safeRatio)) };
    }
    return { w: Math.max(10, Math.round(maxH * safeRatio)), h: maxH };
}

function opIcon(name) {
    const icons = {
        plus: '<path d="M12 5v14M5 12h14"/>',
        diamond: '<path d="M12 3l9 9-9 9-9-9 9-9z"/><path d="M12 8l4 4-4 4-4-4 4-4z"/>',
        mask: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 11h.01M16 11h.01"/><path d="M8 15c2.5 1.5 5.5 1.5 8 0"/>',
        eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
        eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 10.6a2.5 2.5 0 0 0 2.8 2.8"/><path d="M7.4 7.5C4 9.2 2 12 2 12s3.5 6 10 6c1.8 0 3.4-.45 4.7-1.1"/><path d="M13.7 6.2C19 7 22 12 22 12a17 17 0 0 1-2.1 2.8"/>',
        copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
        grip: '<path d="M8 5h.01M8 12h.01M8 19h.01M16 5h.01M16 12h.01M16 19h.01"/>',
        trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/>',
        lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
        unlock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ""}</svg>`;
}

function cloneLayer(layer) {
    return {
        ...layer,
        strokes: layer.strokes ? layer.strokes.map(cloneStroke) : [],
        eraseStrokes: layer.eraseStrokes ? layer.eraseStrokes.map(cloneStroke) : [],
        shapes: layer.shapes ? layer.shapes.map(cloneShape) : [],
        bezierPaths: layer.bezierPaths ? layer.bezierPaths.map(cloneBezierPath) : [],
    };
}

function paintContentBounds(layer) {
    if (layer.type !== "paint") return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const include = (x, y, pad = 0) => {
        minX = Math.min(minX, x - pad);
        minY = Math.min(minY, y - pad);
        maxX = Math.max(maxX, x + pad);
        maxY = Math.max(maxY, y + pad);
    };
    for (const stroke of [...(layer.strokes || []), ...(layer.eraseStrokes || [])]) {
        const pad = Math.max(1, (stroke.size || 1) / 2);
        for (const point of stroke.points || []) include(point.x, point.y, pad);
    }
    for (const shape of layer.shapes || []) {
        const pad = Math.max(1, (shape.size || 1) / 2);
        if (shape.points?.length) {
            shape.points.forEach(point => include(point.x, point.y, pad));
        } else {
            include(shape.x, shape.y, pad);
            include(shape.x + shape.w, shape.y + shape.h, pad);
        }
    }
    for (const path of layer.bezierPaths || []) {
        const pad = Math.max(1, (path.size || 1) / 2);
        for (const anchor of path.anchors || []) {
            include(anchor.x, anchor.y, pad);
            include(anchor.x + (anchor.handleIn?.x || 0), anchor.y + (anchor.handleIn?.y || 0), pad);
            include(anchor.x + (anchor.handleOut?.x || 0), anchor.y + (anchor.handleOut?.y || 0), pad);
        }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;
    return {
        x: Math.round(minX),
        y: Math.round(minY),
        w: Math.max(1, Math.round(maxX - minX)),
        h: Math.max(1, Math.round(maxY - minY)),
    };
}

function layerBounds(layer) {
    const paintBounds = paintContentBounds(layer);
    if (paintBounds) return { ...paintBounds, rotation: layer.rotation || 0 };
    return { x: layer.x, y: layer.y, w: layer.w, h: layer.h, rotation: layer.rotation || 0 };
}

function rotatePointAround(point, center, degrees) {
    const rad = degrees * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + dx * cos - dy * sin,
        y: center.y + dx * sin + dy * cos,
    };
}

function layerVisualGeometry(layer) {
    const r = layerBounds(layer);
    const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const corners = {
        nw: { x: r.x, y: r.y },
        ne: { x: r.x + r.w, y: r.y },
        sw: { x: r.x, y: r.y + r.h },
        se: { x: r.x + r.w, y: r.y + r.h },
    };
    for (const key of Object.keys(corners)) {
        corners[key] = rotatePointAround(corners[key], center, r.rotation);
    }
    return { rect: r, center, corners };
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersects = ((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 0.000001) + xi);
        if (intersects) inside = !inside;
    }
    return inside;
}

function colorToRgb(color) {
    const hex = String(color || "").trim();
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return [255, 255, 255];
    const raw = m[1].length === 3
        ? m[1].split("").map(ch => ch + ch).join("")
        : m[1];
    return [
        parseInt(raw.slice(0, 2), 16),
        parseInt(raw.slice(2, 4), 16),
        parseInt(raw.slice(4, 6), 16),
    ];
}

function rgba(color, alpha = 1) {
    const [r, g, b] = colorToRgb(color);
    return `rgba(${r},${g},${b},${alpha})`;
}

function contrastGuideColor(color) {
    const [r, g, b] = colorToRgb(color);
    const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luma > 0.62 ? "#111827" : "#f8fafc";
}

class OkayPixelsEditor {
    constructor({
        node,
        imageData,
        project = null,
        inputSignature = "",
        onSave,
        imageMimeType = "image/png",
        imageQuality,
        includeImageBase64 = true,
        includeMaskBase64 = true,
        alphaMask = false,
    }) {
        this.node = node;
        this.imageData = imageData;
        this.project = project;
        this.inputSignature = inputSignature;
        this.onSave = onSave;
        this.imageMimeType = imageMimeType;
        this.imageQuality = imageQuality;
        this.includeImageBase64 = includeImageBase64;
        this.includeMaskBase64 = includeMaskBase64;
        this.alphaMask = alphaMask;
        this.root = null;
        this.canvas = null;
        this.preview = null;
        this.ctx = null;
        this.previewCtx = null;
        this.materialInput = null;
        this.width = 1;
        this.height = 1;
        this.zoom = 1;
        this.pan = { x: 0, y: 0 };
        this.tool = "brush";
        this.color = "#ffffff";
        this.size = 14;
        this.opacity = 1;
        this.eraserHardness = 72;
        this.rectFill = false;
        this.layers = [];
        this.activeLayerId = "";
        this.history = [];
        this.drag = null;
        this.cropRect = null;
        this.cropOptionsOpen = false;
        this.cropDragFrame = 0;
        this.pendingCropPoint = null;
        this.pendingCropRect = null;
        this.outpaint = null;
        this.scaleMode = "fixed";
        this.renderQueued = false;
        this.pendingPreviewStroke = null;
        this.pendingPreviewShape = null;
        this.previewQueued = false;
        this.penPath = null;
        this.penMode = "freehand";
        this.penPopover = null;
        this.activeBezierLayerId = "";
        this.activeBezierPathId = "";
        this.bezierDragging = false;
        this.bezierDragAnchorIdx = -1;
        this.bezierDragHandle = "none";
        this.bezierHoveredIdx = -1;
        this.bezierHoveredType = "none";
        this.layerListDirty = true;
        this.frameMode = "";
        this.spaceDown = false;
        this.outpaintEls = null;
        this.outpaintRenderQueued = false;
        this.outpaintDragScale = 1;
        this.cursorPoint = null;
        this.layerDragId = "";
        this.layerMouseDrag = null;
        this.maskSourceLayerIds = new Set();
        this.saving = false;
    }

    async open() {
        injectEditorStyle();
        const base = await imageFromSrc(this.imageData);
        if (await this.restoreProject(base)) {
            this.mount();
            await new Promise(resolve => requestAnimationFrame(resolve));
            this.fitView();
            this.render();
            return;
        }
        this.width = base.naturalWidth || base.width;
        this.height = base.naturalHeight || base.height;
        this.layers = [{
            id: uid("base"),
            name: "原图",
            type: "base",
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: this.width,
            h: this.height,
            rotation: 0,
            image: base,
            src: this.imageData,
            locked: true,
        }, {
            id: uid("paint"),
            name: "绘制图层",
            type: "paint",
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: this.width,
            h: this.height,
            rotation: 0,
            strokes: [],
            shapes: [],
            bezierPaths: [],
        }];
        this.activeLayerId = this.layers[1].id;
        this.mount();
        await new Promise(resolve => requestAnimationFrame(resolve));
        this.fitView();
        this.render();
    }

    async restoreProject(baseFallback) {
        const project = this.project;
        if (!project || !Array.isArray(project.layers) || project.layers.length === 0) return false;
        const width = Math.max(1, Math.round(Number(project.width) || 0));
        const height = Math.max(1, Math.round(Number(project.height) || 0));
        if (!width || !height) return false;
        const imageCache = new Map();
        const loadCached = async src => {
            if (!src) return null;
            if (!imageCache.has(src)) imageCache.set(src, imageFromSrc(src).catch(() => null));
            return imageCache.get(src);
        };
        this.width = width;
        this.height = height;
        this.tool = project.tool || this.tool;
        if (this.tool === "pen") this.tool = project.penMode === "bezier" ? "pen-bezier" : "pen-freehand";
        if (!["pen-bezier", "pen-freehand"].includes(this.tool) && project.penMode) this.penMode = project.penMode;
        if (this.tool === "pen-bezier") this.penMode = "bezier";
        if (this.tool === "pen-freehand") this.penMode = "freehand";
        this.color = project.color || this.color;
        this.size = Number(project.size) || this.size;
        this.opacity = Number.isFinite(project.opacity) ? project.opacity : this.opacity;
        this.eraserHardness = Number.isFinite(project.eraserHardness) ? project.eraserHardness : this.eraserHardness;
        this.rectFill = !!project.rectFill;
        this.scaleMode = project.scaleMode || this.scaleMode;
        this.layers = [];
        for (const savedLayer of project.layers) {
            const layer = {
                ...serializeLayerForProject(savedLayer),
                image: null,
                maskImage: null,
            };
            if (layer.src) layer.image = await loadCached(layer.src);
            if (layer.maskSrc) layer.maskImage = await loadCached(layer.maskSrc);
            if (layer.type === "base" && !layer.image) {
                layer.image = baseFallback;
                layer.src = this.imageData;
            }
            if (layer.type === "base") layer.locked = true;
            this.layers.push(layer);
        }
        if (!this.layers.some(layer => layer.type === "base")) {
            this.layers.unshift({
                id: uid("base"),
                name: "Base",
                type: "base",
                visible: true,
                opacity: 1,
                x: 0,
                y: 0,
                w: this.width,
                h: this.height,
                rotation: 0,
                image: baseFallback,
                src: this.imageData,
                locked: true,
                strokes: [],
                eraseStrokes: [],
                shapes: [],
                bezierPaths: [],
            });
        }
        const activeExists = this.layers.some(layer => layer.id === project.activeLayerId);
        this.activeLayerId = activeExists
            ? project.activeLayerId
            : (this.layers.find(layer => !layer.locked)?.id || this.layers[this.layers.length - 1]?.id || "");
        this.migratePenPaintLayers();
        this.layerListDirty = true;
        return true;
    }

    migratePenPaintLayers() {
        const extraLayers = [];
        for (const layer of this.layers) {
            if (layer.type !== "paint") continue;
            const remainingShapes = [];
            for (const shape of layer.shapes || []) {
                if (shape.type === "pen" && shape.points?.length >= 3) {
                    extraLayers.push(this.createFreehandPenLayer(shape.points, {
                        color: shape.color || this.color,
                        size: Math.max(1, (shape.size || 1) * 12),
                        opacity: Number.isFinite(shape.opacity) ? shape.opacity : 1,
                    }));
                } else {
                    remainingShapes.push(shape);
                }
            }
            const remainingPaths = [];
            for (const path of layer.bezierPaths || []) {
                if (path.closed && path.anchors?.length >= 3) {
                    extraLayers.push(this.createBezierPenLayer(path));
                } else {
                    remainingPaths.push(path);
                }
            }
            layer.shapes = remainingShapes;
            layer.bezierPaths = remainingPaths;
        }
        if (extraLayers.length) this.layers.push(...extraLayers);
    }

    mount() {
        document.getElementById(OP_EDITOR_ROOT_ID)?.remove();
        const root = document.createElement("div");
        root.id = OP_EDITOR_ROOT_ID;
        root.innerHTML = this.template();
        document.body.appendChild(root);
        this.root = root;
        this.canvas = root.querySelector(".op-ie-canvas");
        this.preview = root.querySelector(".op-ie-preview");
        this.ctx = this.canvas.getContext("2d");
        this.previewCtx = this.preview.getContext("2d");
        this.canvas.width = this.preview.width = this.width;
        this.canvas.height = this.preview.height = this.height;
        this.materialInput = root.querySelector(".op-ie-material-input");
        this.bind();
        this.updateUi();
    }

    template() {
        return `
<div class="op-ie-topbar">
  <div class="op-ie-topbar__side">
    <button class="op-ie-btn" data-action="close">← 返回</button>
    <span class="op-ie-title">图片编辑</span>
    <span class="op-ie-meta" data-meta>${this.width} x ${this.height}</span>
  </div>
  <div class="op-ie-topbar__center">
    <button class="op-ie-icon-btn" data-action="zoom-out">⌕</button>
    <span class="op-ie-zoom" data-zoom>100%</span>
    <button class="op-ie-icon-btn" data-action="zoom-in">⌖</button>
  </div>
  <div class="op-ie-topbar__side">
    <button class="op-ie-btn" data-action="reset">↻ 还原</button>
    <button class="op-ie-btn op-ie-btn--save" data-action="save">✓ 保存</button>
  </div>
</div>
<div class="op-ie-subbar">
  <button class="op-ie-sub-btn" data-tool="rect">▭ 矩形</button>
  <button class="op-ie-sub-btn" data-tool="arrow">↗ 箭头</button>
  <label class="op-ie-toggle"><input type="checkbox" data-fill> 填充</label>
  <span class="op-ie-sep"></span>
  <div class="op-ie-swatches">${OP_COLORS.map(c => `<button class="op-ie-swatch" data-color="${c}" style="background:${c}"></button>`).join("")}</div>
  <input class="op-ie-color" type="color" data-color-input value="${this.color}">
  <span class="op-ie-sep"></span>
  <label class="op-ie-slider"><span>大小</span><input type="range" min="1" max="96" value="${this.size}" data-size><b data-size-val>${this.size}px</b></label>
  <label class="op-ie-slider"><span>透明</span><input type="range" min="5" max="100" value="100" data-opacity><b data-opacity-val>100%</b></label>
</div>
<div class="op-ie-body">
  <aside class="op-ie-toolbar">
    <button class="op-ie-tool-btn" data-action="material">＋<span>添加素材</span></button>
    <input class="op-ie-material-input op-ie-hidden" type="file" accept="image/png,image/webp,image/jpeg">
    <button class="op-ie-tool-btn" data-action="crop">⌗<span>裁剪</span></button>
    <button class="op-ie-tool-btn" data-action="outpaint">⛶<span>扩图</span></button>
    <div class="op-ie-toolbar-sep"></div>
    <button class="op-ie-tool-btn" data-tool="move">✥<span>移动</span></button>
    <button class="op-ie-tool-btn" data-action="scale">↔<span>缩放旋转</span></button>
    <button class="op-ie-tool-btn" data-tool="brush">◌<span>画笔</span></button>
    <button class="op-ie-tool-btn" data-action="pen-menu" data-pen-button="true">✒<span>钢笔</span></button>
    <button class="op-ie-tool-btn" data-tool="eraser">⌫<span>橡皮擦</span></button>
    <div class="op-ie-toolbar-sep"></div>
    <button class="op-ie-tool-btn" data-action="layer">⊞<span>图层</span></button>
    <button class="op-ie-tool-btn" data-action="undo">↶<span>撤销</span></button>
  </aside>
  <main class="op-ie-stage-wrap">
    <div class="op-ie-stage" data-stage>
      <canvas class="op-ie-canvas"></canvas>
      <canvas class="op-ie-preview"></canvas>
      <div class="op-ie-frame op-ie-hidden" data-frame></div>
    </div>
    <div class="op-ie-crop-actions op-ie-hidden" data-crop-actions>
      <button class="op-ie-btn op-ie-btn--save" data-action="apply-crop">确认裁剪</button>
      <button class="op-ie-btn" data-action="cancel-crop">取消</button>
    </div>
    <div class="op-ie-brush-cursor op-ie-hidden" data-brush-cursor></div>
  </main>
  <aside class="op-ie-layers">
    <div class="op-ie-layers__header"><strong>图层</strong><div class="op-ie-layer-tools"><button class="op-ie-icon-btn op-ie-layer-tool" data-action="layer" title="新建绘制图层" aria-label="新建绘制图层">${opIcon("plus")}<span>新建</span></button><button class="op-ie-icon-btn op-ie-layer-tool" data-action="duplicate-layer" title="复制当前图层" aria-label="复制当前图层">${opIcon("copy")}<span>复制</span></button><button class="op-ie-icon-btn op-ie-layer-tool" data-action="color-block" title="当前图层转色块" aria-label="当前图层转色块">${opIcon("diamond")}<span>色块</span></button><button class="op-ie-icon-btn op-ie-layer-tool" data-action="mask-layer-menu" title="从勾选图层生成遮罩" aria-label="从勾选图层生成遮罩">${opIcon("mask")}<span>遮罩</span></button><div class="op-ie-mask-menu" data-mask-layer-menu><button class="op-ie-mask-option" data-action="mask-layer-positive">正向遮罩</button><button class="op-ie-mask-option" data-action="mask-layer-inverse">反向遮罩</button></div></div></div>
    <div class="op-ie-layer-list" data-layer-list></div>
    <div class="op-ie-layer-detail"><label>透明度<input type="range" min="0" max="100" value="100" data-layer-opacity></label></div>
  </aside>
</div>`;
    }

    bind() {
        this.root.addEventListener("click", e => {
            const el = e.target.closest("[data-action],[data-tool],[data-color]");
            if (!el) return;
            const action = el.dataset.action;
            const tool = el.dataset.tool;
            if (tool) this.setTool(tool, el);
            if (el.dataset.color) this.setColor(el.dataset.color);
            if (action) this.handleAction(action, el);
        });
        this.root.querySelector("[data-color-input]").addEventListener("input", e => this.setColor(e.target.value));
        this.root.querySelector("[data-size]").addEventListener("input", e => {
            this.size = Number(e.target.value);
            this.root.querySelector("[data-size-val]").textContent = `${this.size}px`;
            this.refreshBrushCursor();
        });
        this.root.querySelector("[data-opacity]").addEventListener("input", e => {
            this.opacity = Number(e.target.value) / 100;
            this.root.querySelector("[data-opacity-val]").textContent = `${Math.round(this.opacity * 100)}%`;
        });
        this.root.querySelector("[data-fill]").addEventListener("change", e => { this.rectFill = e.target.checked; });
        this.root.querySelector("[data-layer-opacity]").addEventListener("input", e => {
            const layer = this.activeLayer();
            if (!layer || layer.locked) return;
            layer.opacity = Number(e.target.value) / 100;
            this.layerListDirty = true;
            this.requestRender();
            this.updateUi(true);
        });
        this.materialInput.addEventListener("change", e => this.addMaterial(e.target.files?.[0]));
        const wrap = this.root.querySelector(".op-ie-stage-wrap");
        wrap.addEventListener("wheel", e => {
            e.preventDefault();
            this.zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.9 : 1.1);
        }, { passive: false });
        wrap.addEventListener("contextmenu", e => e.preventDefault());
        wrap.addEventListener("mousemove", e => this.updateBrushCursor(e));
        wrap.addEventListener("mouseleave", () => this.hideBrushCursor());
        wrap.addEventListener("mousedown", e => this.pointerDown(e));
        window.addEventListener("mousemove", this._move = e => this.pointerMove(e));
        window.addEventListener("mouseup", this._up = e => this.pointerUp(e));
        window.addEventListener("paste", this._paste = e => {
            if (!this.root?.isConnected) return;
            const target = e.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return;
            const files = [...(e.clipboardData?.files || [])];
            let file = files.find(item => String(item?.type || "").startsWith("image/"));
            if (!file) {
                const imageItem = [...(e.clipboardData?.items || [])].find(item => item.kind === "file" && String(item.type || "").startsWith("image/"));
                file = imageItem?.getAsFile?.() || null;
            }
            if (!file) return;
            e.preventDefault();
            this.addMaterial(file);
        });
        window.addEventListener("keydown", this._key = e => {
            if (e.code === "Space" && !this.spaceDown) {
                this.spaceDown = true;
                e.preventDefault();
            }
            if (e.key === "Escape") {
                if (this.outpaint?.open) this.closeOutpaint();
                else if (this.cropOptionsOpen) this.closeCropOptions();
                else if (this.cropRect) this.cancelCrop();
                else if (this.tool === "pen-bezier" && this.activeBezierPath()) this.abandonBezierPath();
                else this.close();
            }
            if (e.key === "Enter" && this.tool === "pen-bezier" && this.activeBezierPath()) {
                e.preventDefault();
                this.finishBezierPath();
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
                e.preventDefault();
                this.undo();
            }
        });
        window.addEventListener("keyup", this._keyUp = e => {
            if (e.code === "Space") {
                this.spaceDown = false;
                e.preventDefault();
            }
        });
    }

    handleAction(action) {
        if (action === "close") this.close();
        if (action === "save" && !this.saving) this.save();
        if (action === "reset") this.reset();
        if (action === "zoom-in") this.zoomBy(1.12);
        if (action === "zoom-out") this.zoomBy(0.88);
        if (action === "material") this.materialInput.click();
        if (action === "crop") this.startCrop();
        if (action === "outpaint") this.openOutpaint();
        if (action === "pen-menu") this.openPenPopover(this.root.querySelector("[data-pen-button]"));
        if (action === "scale") this.setTool("scale");
        if (action === "layer") this.addPaintLayer();
        if (action === "duplicate-layer") this.duplicateActiveLayer();
        if (action === "undo") this.undo();
        if (action === "apply-crop") this.applyCrop();
        if (action === "cancel-crop") this.cancelCrop();
        if (action === "color-block") this.convertActiveToColorBlock();
        if (action === "mask-layer-menu") this.toggleMaskLayerMenu();
        if (action === "mask-layer-positive") this.createMaskLayersFromSelection("positive");
        if (action === "mask-layer-inverse") this.createMaskLayersFromSelection("inverse");
    }

    toggleMaskLayerMenu(open = null) {
        const menu = this.root?.querySelector("[data-mask-layer-menu]");
        if (!menu) return;
        const next = open == null ? !menu.classList.contains("open") : !!open;
        menu.classList.toggle("open", next);
    }

    setTool(tool, anchor = null) {
        if (this.tool === "pen-bezier" && tool !== "pen-bezier" && tool !== "pen-freehand") this.finishBezierPath();
        if (this.tool === "pen-freehand" && tool !== "pen-freehand") this.clearPenPath();
        this.tool = tool;
        if (tool !== "crop") this.cancelCrop(false);
        if (tool === "eraser") this.showEraserPopover(anchor || this.root.querySelector('[data-tool="eraser"]'));
        else this.hideEraserPopover();
        this.hidePenPopover();
        if (!["pen-bezier", "pen-freehand"].includes(tool)) {
            this.bezierHoveredIdx = -1;
            this.bezierHoveredType = "none";
        }
        this.updateUi();
        this.requestRender();
        this.refreshBrushCursor();
    }

    openPenPopover(anchor) {
        this.hidePenPopover();
        this.hideEraserPopover();
        if (!anchor) return;
        const pop = document.createElement("div");
        pop.className = "op-ie-pen-popover";
        pop.dataset.penPopover = "true";
        pop.innerHTML = `
<div class="op-ie-pen-popover__head">选择钢笔模式</div>
<button class="op-ie-pen-popover__item" data-pen-mode="bezier"><i>✒</i><span><strong>钢笔</strong><small>点击放置锚点，拖拽创建曲线手柄</small></span></button>
<button class="op-ie-pen-popover__item" data-pen-mode="freehand"><i>◌</i><span><strong>自由钢笔</strong><small>拖动绘出闭合填充路径</small></span></button>`;
        this.root.appendChild(pop);
        const rootRect = this.root.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        pop.style.left = `${rect.right - rootRect.left + 12}px`;
        pop.style.top = `${Math.max(8, rect.top - rootRect.top - 8)}px`;
        pop.addEventListener("click", e => {
            const mode = e.target.closest("[data-pen-mode]")?.dataset.penMode;
            if (!mode) return;
            this.selectPenMode(mode);
        });
        this.penPopover = pop;
    }

    hidePenPopover() {
        this.penPopover?.remove();
        this.penPopover = null;
        this.root?.querySelector("[data-pen-popover]")?.remove();
    }

    selectPenMode(mode) {
        this.hidePenPopover();
        if (this.tool === "pen-bezier") this.finishBezierPath();
        if (this.tool === "pen-freehand") this.clearPenPath(false);
        this.penMode = mode === "bezier" ? "bezier" : "freehand";
        this.tool = mode === "bezier" ? "pen-bezier" : "pen-freehand";
        this.cancelCrop(false);
        this.closeOutpaint();
        this.activeBezierLayerId = "";
        this.activeBezierPathId = "";
        this.activeLayerId = this.ensurePaintLayer()?.id || this.activeLayerId;
        this.updateUi(true);
        this.render();
        this.refreshBrushCursor();
    }

    showEraserPopover(anchor) {
        this.hideEraserPopover();
        if (!anchor) return;
        const pop = document.createElement("div");
        pop.className = "op-ie-eraser-popover";
        pop.dataset.eraserPopover = "true";
        pop.innerHTML = `
<div class="op-ie-eraser-popover__head"><span>橡皮擦</span><b data-eraser-hardness-val>${this.eraserHardness}%</b></div>
<div class="op-ie-eraser-popover__preview"><span class="op-ie-eraser-preview-dot" data-eraser-preview></span></div>
<label><span>硬度</span><input type="range" min="0" max="100" value="${this.eraserHardness}" data-eraser-hardness></label>`;
        this.root.appendChild(pop);
        const rootRect = this.root.getBoundingClientRect();
        const rect = anchor.getBoundingClientRect();
        pop.style.left = `${rect.right - rootRect.left + 12}px`;
        pop.style.top = `${Math.max(8, rect.top - rootRect.top - 8)}px`;
        const sync = value => {
            this.eraserHardness = Math.max(0, Math.min(100, Number(value) || 0));
            pop.querySelector("[data-eraser-hardness-val]").textContent = `${this.eraserHardness}%`;
            pop.querySelector("[data-eraser-preview]").style.setProperty("--soft-core", `${this.eraserSoftCorePercent(this.eraserHardness)}%`);
            this.refreshBrushCursor();
        };
        sync(this.eraserHardness);
        pop.querySelector("[data-eraser-hardness]").addEventListener("input", e => sync(e.target.value));
    }

    hideEraserPopover() {
        this.root?.querySelector("[data-eraser-popover]")?.remove();
    }

    setColor(color) {
        this.color = color;
        this.root.querySelector("[data-color-input]").value = color;
        const layer = this.activeLayer();
        if (layer && !layer.locked && layer.type === "color") {
            this.pushHistory();
            layer.color = color;
            this.render();
        }
        this.updateUi();
    }

    activeLayer() {
        return this.layers.find(l => l.id === this.activeLayerId);
    }

    pushHistory() {
        const slim = this.layers.map(l => ({
            ...cloneLayer(l),
            image: undefined,
            maskImage: undefined,
        }));
        this.history.push(JSON.stringify({ width: this.width, height: this.height, activeLayerId: this.activeLayerId, layers: slim }));
        if (this.history.length > 30) this.history.shift();
    }

    async undo() {
        const path = this.activeBezierPath();
        if (this.tool === "pen-bezier" && path) {
            if (path.anchors.length > 1) path.anchors.pop();
            else this.abandonBezierPath(false);
            this.render();
            return;
        }
        const snap = this.history.pop();
        if (!snap) return;
        const parsed = JSON.parse(snap);
        this.width = parsed.width;
        this.height = parsed.height;
        this.activeLayerId = parsed.activeLayerId;
        const bySrc = new Map(this.layers.filter(l => l.src && l.image).map(l => [l.src, l.image]));
        const byMaskSrc = new Map(this.layers.filter(l => l.maskSrc && l.maskImage).map(l => [l.maskSrc, l.maskImage]));
        this.layers = parsed.layers;
        this.maskSourceLayerIds.clear();
        for (const layer of this.layers) {
            if (layer.src) layer.image = bySrc.get(layer.src) || await imageFromSrc(layer.src);
            if (layer.maskSrc) layer.maskImage = byMaskSrc.get(layer.maskSrc) || await imageFromSrc(layer.maskSrc);
        }
        this.resizeCanvases();
        this.render();
        this.updateUi(true);
    }

    reset() {
        this.pushHistory();
        const base = this.layers[0];
        this.layers = [base, {
            id: uid("paint"),
            name: "绘制图层",
            type: "paint",
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: this.width,
            h: this.height,
            rotation: 0,
            strokes: [],
            shapes: [],
            bezierPaths: [],
        }];
        this.maskSourceLayerIds.clear();
        this.activeLayerId = this.layers[1].id;
        this.render();
        this.updateUi(true);
    }

    close() {
        this.closeOutpaint();
        this.closeCropOptions();
        this.hidePenPopover();
        if (this.tool === "pen-bezier") this.finishBezierPath(false);
        window.removeEventListener("mousemove", this._move);
        window.removeEventListener("mouseup", this._up);
        window.removeEventListener("paste", this._paste);
        window.removeEventListener("keydown", this._key);
        window.removeEventListener("keyup", this._keyUp);
        this.root?.remove();
    }

    updateUi(refreshLayers = false) {
        this.root.querySelectorAll("[data-tool]").forEach(btn => btn.classList.toggle("active", btn.dataset.tool === this.tool));
        this.root.querySelectorAll("[data-pen-button]").forEach(btn => btn.classList.toggle("active", ["pen-bezier", "pen-freehand"].includes(this.tool)));
        this.root.querySelectorAll("[data-color]").forEach(btn => btn.classList.toggle("active", btn.dataset.color?.toLowerCase() === this.color.toLowerCase()));
        this.root.querySelector("[data-zoom]").textContent = `${Math.round(this.zoom * 100)}%`;
        this.root.querySelector("[data-meta]").textContent = `${this.width} x ${this.height}`;
        const duplicateButton = this.root.querySelector('[data-action="duplicate-layer"]');
        if (duplicateButton) duplicateButton.disabled = !this.activeLayer() || !!this.activeLayer()?.locked;
        const maskButton = this.root.querySelector('[data-action="mask-layer-menu"]');
        if (maskButton) {
            const hasCheckedSource = this.selectedMaskSourceLayers().length > 0;
            const active = this.activeLayer();
            const canConvertActive = !!active && !active.locked && !["base", "mask"].includes(active.type);
            maskButton.disabled = !hasCheckedSource && !canConvertActive;
        }
        if (refreshLayers || this.layerListDirty) this.renderLayerList();
    }

    renderLayerList() {
        const list = this.root.querySelector("[data-layer-list]");
        list.innerHTML = "";
        [...this.layers].reverse().forEach(layer => {
            const row = document.createElement("button");
            row.className = `op-ie-layer-row ${layer.id === this.activeLayerId ? "active" : ""} ${layer.type === "mask" ? "mask-layer" : ""}`;
            row.innerHTML = `<span class="op-ie-layer-thumb"></span><span class="op-ie-layer-main"><b>${layer.name}</b><small>${layer.type} · ${Math.round(layer.opacity * 100)}%</small></span><span class="op-ie-layer-actions"><button data-mini="visible">${layer.visible ? "◉" : "○"}</button><button data-mini="up">⌃</button><button data-mini="delete">⌫</button></span>`;
            const legacyThumb = row.querySelector(".op-ie-layer-thumb");
            legacyThumb.style.backgroundImage = `url(${this.layerThumbnailUrl(layer)})`;
            row.addEventListener("click", e => {
                const mini = e.target.closest("[data-mini]")?.dataset.mini;
                if (mini) {
                    e.stopPropagation();
                    this.handleLayerMini(layer, mini);
                    return;
                }
                this.activeLayerId = layer.id;
                this.updateUi(true);
                this.render();
            });
            list.appendChild(row);
        });
        const opacity = this.root.querySelector("[data-layer-opacity]");
        const active = this.activeLayer();
        opacity.value = active ? Math.round(active.opacity * 100) : 100;
        opacity.disabled = !active || active.locked;
        this.layerListDirty = false;
    }

    handleLayerMini(layer, mini) {
        if (mini === "visible") layer.visible = !layer.visible;
        if (mini === "delete" && !layer.locked) {
            this.pushHistory();
            this.maskSourceLayerIds.delete(layer.id);
            this.layers = this.layers.filter(l => l.id !== layer.id);
            this.activeLayerId = this.layers[Math.max(0, this.layers.length - 1)]?.id || "";
        }
        if (mini === "up") {
            const idx = this.layers.findIndex(l => l.id === layer.id);
            if (idx >= 0 && idx < this.layers.length - 1) {
                this.pushHistory();
                [this.layers[idx], this.layers[idx + 1]] = [this.layers[idx + 1], this.layers[idx]];
            }
        }
        this.layerListDirty = true;
        this.render();
        this.updateUi(true);
    }

    renderLayerList() {
        const list = this.root.querySelector("[data-layer-list]");
        list.innerHTML = "";
        [...this.layers].reverse().forEach(layer => {
            const row = document.createElement("div");
            row.className = `op-ie-layer-row ${layer.id === this.activeLayerId ? "active" : ""} ${layer.type === "mask" ? "mask-layer" : ""}`;
            row.dataset.layerId = layer.id;
            row.draggable = false;
            row.dataset.draggable = String(!layer.locked);
            row.setAttribute("role", "button");
            row.tabIndex = 0;
            const canColorBlock = !layer.locked && !["color", "paint", "mask"].includes(layer.type);
            const canUseAsMaskSource = !layer.locked && !["base", "mask"].includes(layer.type);
            const maskSourceChecked = canUseAsMaskSource && this.maskSourceLayerIds.has(layer.id);
            row.classList.toggle("mask-source-selected", maskSourceChecked);
            const lockTitle = layer.type === "base" ? "原图固定锁定" : (layer.locked ? "解锁图层" : "锁定图层");
            row.innerHTML = `<button class="op-ie-layer-drag" type="button" data-layer-drag title="${layer.locked ? "图层已锁定，无法拖拽" : "拖拽排序"}" aria-label="${layer.locked ? "图层已锁定，无法拖拽" : "拖拽排序"}" ${layer.locked ? "disabled" : ""}>${opIcon("grip")}</button><span class="op-ie-layer-thumb"></span><span class="op-ie-layer-main"><b>${layer.name}</b><small>${this.layerTypeLabel(layer)} · ${Math.round(layer.opacity * 100)}%</small></span><span class="op-ie-layer-actions"><button data-mini="lock" class="${layer.locked ? "active" : ""}" title="${lockTitle}" aria-label="${lockTitle}" aria-pressed="${!!layer.locked}" ${layer.type === "base" ? "disabled" : ""}>${opIcon(layer.locked ? "lock" : "unlock")}</button><button data-mini="visible" title="${layer.visible ? "隐藏图层" : "显示图层"}" aria-label="${layer.visible ? "隐藏图层" : "显示图层"}">${opIcon(layer.visible ? "eye" : "eyeOff")}</button><button data-mini="color" title="转为色块" aria-label="转为色块" ${canColorBlock ? "" : "disabled"}>${opIcon("diamond")}</button><button data-mini="delete" title="删除图层" aria-label="删除图层" ${layer.locked ? "disabled" : ""}>${opIcon("trash")}</button></span>`;
            const thumb = row.querySelector(".op-ie-layer-thumb");
            thumb.style.backgroundImage = `url(${this.layerThumbnailUrl(layer)})`;
            const maskSourceInput = document.createElement("input");
            maskSourceInput.className = "op-ie-layer-mask-check";
            maskSourceInput.type = "checkbox";
            maskSourceInput.dataset.maskSource = "true";
            maskSourceInput.checked = maskSourceChecked;
            maskSourceInput.disabled = !canUseAsMaskSource;
            maskSourceInput.title = canUseAsMaskSource ? "选择为遮罩来源" : "该图层不能作为遮罩来源";
            maskSourceInput.setAttribute("aria-label", `选择 ${layer.name} 作为遮罩来源`);
            row.prepend(maskSourceInput);
            maskSourceInput.addEventListener("click", e => e.stopPropagation());
            maskSourceInput.addEventListener("change", e => {
                e.stopPropagation();
                if (maskSourceInput.checked) this.maskSourceLayerIds.add(layer.id);
                else this.maskSourceLayerIds.delete(layer.id);
                this.layerListDirty = true;
                this.updateUi(true);
            });
            row.addEventListener("click", e => {
                const mini = e.target.closest("[data-mini]")?.dataset.mini;
                if (mini) {
                    e.stopPropagation();
                    this.handleLayerMini(layer, mini);
                    return;
                }
                this.activeLayerId = layer.id;
                this.updateUi(true);
                this.render();
            });
            row.addEventListener("dragstart", e => this.beginLayerDrag(e, layer));
            row.addEventListener("dragover", e => this.onLayerDragOver(e, layer, row));
            row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
            row.addEventListener("drop", e => this.dropLayer(e, layer, row));
            row.addEventListener("dragend", () => this.endLayerDrag());
            row.addEventListener("mousedown", e => this.beginLayerMouseDrag(e, layer, row));
            list.appendChild(row);
        });
        const opacity = this.root.querySelector("[data-layer-opacity]");
        const active = this.activeLayer();
        opacity.value = active ? Math.round(active.opacity * 100) : 100;
        opacity.disabled = !active || active.locked;
        this.layerListDirty = false;
    }

    layerTypeLabel(layer) {
        if (layer.type === "base") return "底图";
        if (layer.type === "material") return "素材";
        if (layer.type === "paint") return "绘制";
        if (layer.type === "color") return "色块";
        return layer.type || "图层";
    }

    layerTypeLabel(layer) {
        if (layer.type === "base") return "原图";
        if (layer.type === "material") return "素材";
        if (layer.type === "paint") return "绘制";
        if (layer.type === "color") return "色块";
        if (layer.type === "mask") return layer.maskMode === "inverse" ? "反向遮罩" : "遮罩";
        return layer.type || "图层";
    }

    layerThumbnailUrl(layer) {
        const size = 48;
        const thumb = document.createElement("canvas");
        thumb.width = size;
        thumb.height = size;
        const ctx = thumb.getContext("2d");
        ctx.fillStyle = "#141824";
        ctx.fillRect(0, 0, size, size);
        const source = this.layerThumbnailSource(layer);
        if (source?.width || source?.naturalWidth) {
            const sw = source.naturalWidth || source.width;
            const sh = source.naturalHeight || source.height;
            const scale = Math.min(size / Math.max(sw, 1), size / Math.max(sh, 1));
            const w = Math.max(1, sw * scale);
            const h = Math.max(1, sh * scale);
            ctx.drawImage(source, (size - w) / 2, (size - h) / 2, w, h);
        } else if (layer.type === "color" || layer.type === "mask") {
            ctx.fillStyle = layer.type === "mask" ? "#ffffff" : (layer.color || "#555");
            ctx.fillRect(6, 6, size - 12, size - 12);
        }
        if (layer.type === "mask") {
            ctx.strokeStyle = "#60a5fa";
            ctx.lineWidth = 3;
            ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
        }
        return thumb.toDataURL("image/png");
    }

    layerThumbnailSource(layer) {
        if (layer.type === "base" || layer.type === "material") return layer.image || null;
        if (["color", "mask", "paint"].includes(layer.type)) return this.renderLayerSourceCanvas(layer);
        return layer.image || layer.maskImage || null;
    }

    beginLayerDrag(event, layer) {
        if (layer.locked) {
            event.preventDefault();
            return;
        }
        this.layerDragId = layer.id;
        event.currentTarget.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", layer.id);
    }

    onLayerDragOver(event, targetLayer, row) {
        if (!this.layerDragId || this.layerDragId === targetLayer.id) return;
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        let place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        if (targetLayer.locked && place === "after") place = "before";
        this.clearLayerDropClasses();
        row.classList.add(place === "before" ? "drop-before" : "drop-after");
        event.dataTransfer.dropEffect = "move";
    }

    dropLayer(event, targetLayer, row) {
        event.preventDefault();
        if (!this.layerDragId || this.layerDragId === targetLayer.id) return;
        const rect = row.getBoundingClientRect();
        let place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        if (targetLayer.locked && place === "after") place = "before";
        this.reorderLayerByDisplay(this.layerDragId, targetLayer.id, place);
        this.endLayerDrag();
    }

    endLayerDrag() {
        this.layerDragId = "";
        this.clearLayerDropClasses();
        this.root?.querySelectorAll(".op-ie-layer-row.dragging").forEach(row => row.classList.remove("dragging"));
    }

    clearLayerDropClasses() {
        this.root?.querySelectorAll(".op-ie-layer-row.drop-before,.op-ie-layer-row.drop-after").forEach(row => row.classList.remove("drop-before", "drop-after"));
    }

    reorderLayerByDisplay(draggedId, targetId, place) {
        const display = [...this.layers].reverse();
        const dragged = display.find(layer => layer.id === draggedId);
        if (!dragged || dragged.locked) return;
        const withoutDragged = display.filter(layer => layer.id !== draggedId);
        let targetIndex = withoutDragged.findIndex(layer => layer.id === targetId);
        if (targetIndex < 0) return;
        if (place === "after") targetIndex += 1;
        withoutDragged.splice(targetIndex, 0, dragged);
        const next = withoutDragged.reverse();
        this.pushHistory();
        this.layers = next;
        this.layerListDirty = true;
        this.render();
        this.updateUi(true);
    }

    beginLayerMouseDrag(event, layer, row) {
        if (event.button !== 0 || layer.locked || !event.target.closest("[data-layer-drag]")) return;
        this.layerMouseDrag = {
            layerId: layer.id,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            targetId: "",
            place: "before",
            row,
        };
        this._layerMouseMove = e => this.onLayerMouseDragMove(e);
        this._layerMouseUp = e => this.endLayerMouseDrag(e);
        document.addEventListener("mousemove", this._layerMouseMove);
        document.addEventListener("mouseup", this._layerMouseUp);
    }

    onLayerMouseDragMove(event) {
        const drag = this.layerMouseDrag;
        if (!drag) return;
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (!drag.active && distance < 5) return;
        event.preventDefault();
        drag.active = true;
        drag.row.classList.add("dragging");
        const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest(".op-ie-layer-row");
        this.clearLayerDropClasses();
        if (!targetRow || targetRow.dataset.layerId === drag.layerId) {
            drag.targetId = "";
            return;
        }
        const targetLayer = this.layers.find(layer => layer.id === targetRow.dataset.layerId);
        if (!targetLayer) return;
        const rect = targetRow.getBoundingClientRect();
        let place = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        if (targetLayer.locked && place === "after") place = "before";
        targetRow.classList.add(place === "before" ? "drop-before" : "drop-after");
        drag.targetId = targetLayer.id;
        drag.place = place;
    }

    endLayerMouseDrag() {
        const drag = this.layerMouseDrag;
        document.removeEventListener("mousemove", this._layerMouseMove);
        document.removeEventListener("mouseup", this._layerMouseUp);
        this._layerMouseMove = null;
        this._layerMouseUp = null;
        this.layerMouseDrag = null;
        this.root?.querySelectorAll(".op-ie-layer-row.dragging").forEach(row => row.classList.remove("dragging"));
        this.clearLayerDropClasses();
        if (drag?.active && drag.targetId) {
            this.reorderLayerByDisplay(drag.layerId, drag.targetId, drag.place);
        }
    }

    handleLayerMini(layer, mini) {
        if (mini === "visible") layer.visible = !layer.visible;
        if (mini === "lock" && layer.type !== "base") {
            this.pushHistory();
            layer.locked = !layer.locked;
        }
        if (mini === "delete" && !layer.locked) {
            this.pushHistory();
            this.layers = this.layers.filter(l => l.id !== layer.id);
            this.activeLayerId = this.layers[Math.max(0, this.layers.length - 1)]?.id || "";
        }
        if (mini === "color" && !layer.locked && !["color", "paint", "mask"].includes(layer.type)) {
            this.activeLayerId = layer.id;
            this.convertActiveToColorBlock();
            return;
        }
        this.layerListDirty = true;
        this.render();
        this.updateUi(true);
    }

    resizeCanvases() {
        this.canvas.width = this.preview.width = this.width;
        this.canvas.height = this.preview.height = this.height;
        this.fitView();
    }

    fitView() {
        const wrap = this.root.querySelector(".op-ie-stage-wrap").getBoundingClientRect();
        const paddingX = 96;
        const paddingY = 96;
        const availableW = Math.max(120, wrap.width - paddingX);
        const availableH = Math.max(120, wrap.height - paddingY);
        this.zoom = Math.min(availableW / this.width, availableH / this.height, 1);
        this.zoom = Math.max(0.05, this.zoom);
        this.pan = { x: 0, y: 0 };
        this.applyStageTransform();
    }

    applyStageTransform() {
        const stage = this.root.querySelector("[data-stage]");
        const wrap = this.root.querySelector(".op-ie-stage-wrap").getBoundingClientRect();
        const x = Math.round((wrap.width - this.width * this.zoom) / 2 + this.pan.x);
        const y = Math.round((wrap.height - this.height * this.zoom) / 2 + this.pan.y);
        stage.style.width = `${this.width}px`;
        stage.style.height = `${this.height}px`;
        stage.style.transform = `translate(${x}px, ${y}px) scale(${this.zoom})`;
        this.root.querySelector("[data-zoom]").textContent = `${Math.round(this.zoom * 100)}%`;
        this.root.querySelector("[data-meta]").textContent = `${this.width} x ${this.height}`;
        this.updateFrameScale();
        this.refreshBrushCursor();
    }

    updateFrameScale() {
        const frame = this.root?.querySelector("[data-frame]");
        if (!frame) return;
        frame.style.setProperty("--op-frame-scale", String(1 / Math.max(this.zoom, 0.05)));
    }

    zoomBy(factor) {
        this.zoom = Math.max(0.05, Math.min(6, this.zoom * factor));
        this.applyStageTransform();
    }

    zoomAt(clientX, clientY, factor) {
        const wrap = this.root.querySelector(".op-ie-stage-wrap").getBoundingClientRect();
        const oldZoom = this.zoom;
        const nextZoom = Math.max(0.05, Math.min(6, this.zoom * factor));
        const baseX = (wrap.width - this.width * oldZoom) / 2 + this.pan.x;
        const baseY = (wrap.height - this.height * oldZoom) / 2 + this.pan.y;
        const canvasX = (clientX - wrap.left - baseX) / oldZoom;
        const canvasY = (clientY - wrap.top - baseY) / oldZoom;
        this.zoom = nextZoom;
        this.pan.x = clientX - wrap.left - (wrap.width - this.width * nextZoom) / 2 - canvasX * nextZoom;
        this.pan.y = clientY - wrap.top - (wrap.height - this.height * nextZoom) / 2 - canvasY * nextZoom;
        this.applyStageTransform();
    }

    canvasPoint(e) {
        const pt = this.canvasPointRaw(e);
        return {
            x: Math.max(0, Math.min(this.width, pt.x)),
            y: Math.max(0, Math.min(this.height, pt.y)),
        };
    }

    canvasPointRaw(e) {
        const rect = this.preview.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoom,
            y: (e.clientY - rect.top) / this.zoom,
        };
    }

    brushCursorEnabled() {
        return ["brush", "pen-freehand", "eraser"].includes(this.tool) && !this.cropRect && !this.cropOptionsOpen && !this.outpaint?.open;
    }

    updateBrushCursor(e) {
        this.cursorPoint = { clientX: e.clientX, clientY: e.clientY };
        this.refreshBrushCursor();
    }

    refreshBrushCursor() {
        const cursor = this.root?.querySelector("[data-brush-cursor]");
        if (!cursor || !this.cursorPoint || !this.brushCursorEnabled()) {
            this.hideBrushCursor();
            return;
        }
        const canvasRect = this.preview.getBoundingClientRect();
        const pt = {
            x: (this.cursorPoint.clientX - canvasRect.left) / this.zoom,
            y: (this.cursorPoint.clientY - canvasRect.top) / this.zoom,
        };
        if (pt.x < 0 || pt.x > this.width || pt.y < 0 || pt.y > this.height) {
            this.hideBrushCursor();
            return;
        }
        const wrapRect = this.root.querySelector(".op-ie-stage-wrap").getBoundingClientRect();
        const diameter = Math.max(6, this.size * this.zoom);
        cursor.classList.remove("op-ie-hidden", "brush", "eraser");
        cursor.classList.add(this.tool === "eraser" ? "eraser" : "brush");
        cursor.style.left = `${this.cursorPoint.clientX - wrapRect.left}px`;
        cursor.style.top = `${this.cursorPoint.clientY - wrapRect.top}px`;
        cursor.style.width = `${diameter}px`;
        cursor.style.height = `${diameter}px`;
        cursor.style.setProperty("--cursor-color", this.tool === "eraser" ? "#ffffff" : this.color);
        cursor.style.setProperty("--soft-core", `${this.tool === "eraser" ? this.eraserSoftCorePercent(this.eraserHardness) : 100}%`);
    }

    hideBrushCursor() {
        this.root?.querySelector("[data-brush-cursor]")?.classList.add("op-ie-hidden");
    }

    eraserSoftCorePercent(hardness) {
        const h = Math.max(0, Math.min(100, Number(hardness) || 0)) / 100;
        return Math.round(6 + Math.pow(h, 1.7) * 70);
    }

    pointerDown(e) {
        if (e.button === 1 || e.button === 2 || this.spaceDown) {
            e.preventDefault();
            this.drag = { kind: "pan", startClientX: e.clientX, startClientY: e.clientY, pan: { ...this.pan } };
            return;
        }
        const visualHit = this.hitVisualControl(e);
        if (visualHit?.kind === "rotate" || visualHit?.kind === "scale") {
            const layer = this.activeLayer();
            if (this.tool === "scale" && layer && !layer.locked) {
                const pt = this.canvasPointRaw(e);
                this.pushHistory();
                this.drag = this.attachPaintTransformSource({ kind: visualHit.kind, mode: visualHit.mode, start: pt, layer, frame: layerBounds(layer), startAngle: Math.atan2(pt.y - (layer.y + layer.h / 2), pt.x - (layer.x + layer.w / 2)) });
                return;
            }
        }
        const isTransformHit = this.tool === "crop" || this.tool === "scale" || this.tool === "move";
        const pt = isTransformHit ? this.canvasPointRaw(e) : this.canvasPoint(e);
        let layer = this.activeLayer();
        if (this.tool === "crop" && this.cropRect) {
            this.drag = { kind: "crop", mode: this.hitFrameHandle(pt, this.cropRect), start: pt, rect: { ...this.cropRect } };
            return;
        }
        if (this.tool === "scale" || this.tool === "move") {
            const picked = this.pickLayerAtPoint(pt);
            if (picked && picked.id !== this.activeLayerId) {
                this.activeLayerId = picked.id;
                layer = picked;
                this.updateUi(true);
                this.render();
            }
        }
        if (this.tool === "scale" && layer && !layer.locked) {
            const hit = this.hitLayerTransform(pt, layer);
            if (hit) {
                this.pushHistory();
                this.drag = this.attachPaintTransformSource({ kind: hit.kind, mode: hit.mode, start: pt, layer, frame: layerBounds(layer), startAngle: Math.atan2(pt.y - (layer.y + layer.h / 2), pt.x - (layer.x + layer.w / 2)) });
                return;
            }
            if (this.layerContainsPoint(layer, pt)) {
                this.pushHistory();
                this.drag = this.attachPaintTransformSource({ kind: "move", start: pt, layer, frame: layerBounds(layer) });
                return;
            }
        }
        if (this.tool === "move" && layer && !layer.locked && this.layerContainsPoint(layer, pt)) {
            this.pushHistory();
            this.drag = this.attachPaintTransformSource({ kind: "move", start: pt, layer, frame: layerBounds(layer) });
            return;
        }
        if (this.tool === "eraser") {
            const target = this.eraserTargetLayer(pt);
            if (!target) return;
            this.pushHistory();
            const stroke = {
                tool: "eraser",
                size: this.size,
                opacity: 1,
                hardness: this.eraserHardness,
                points: target.type === "paint" ? [pt] : [this.layerLocalPoint(target, pt)],
            };
            if (target.type === "paint") {
                target.strokes = target.strokes || [];
                target.strokes.push(stroke);
                this.drag = { kind: "paint-erase", layer: target, stroke };
                this.requestRender();
            } else {
                target.eraseStrokes = target.eraseStrokes || [];
                target.eraseStrokes.push(stroke);
                this.drag = { kind: "layer-erase", layer: target, stroke };
                this.requestRender();
            }
            return;
        }
        if (this.tool === "pen-bezier") {
            this.handleBezierPointerDown(pt, e);
            return;
        }
        if (this.tool === "pen-freehand") {
            this.beginEditorPen(pt);
            return;
        }
        if (this.tool === "brush") {
            const paint = this.ensurePaintLayer();
            this.pushHistory();
            this.drag = { kind: "stroke", layer: paint, stroke: { tool: this.tool, color: this.color, size: this.size, opacity: this.opacity, points: [pt] } };
            return;
        }
        if (["rect", "arrow"].includes(this.tool)) {
            const paint = this.ensurePaintLayer();
            this.pushHistory();
            this.drag = { kind: "shape", layer: paint, shape: { id: uid("shape"), type: this.tool, x: pt.x, y: pt.y, w: 1, h: 1, color: this.color, size: this.size, opacity: this.opacity, fill: this.rectFill } };
        }
    }

    eraserTargetLayer(pt) {
        let layer = this.activeLayer();
        if (layer && !layer.locked && layer.type !== "base") return layer;
        const picked = this.pickLayerAtPoint(pt);
        if (picked) {
            this.activeLayerId = picked.id;
            this.updateUi(true);
            return picked;
        }
        return null;
    }

    // ============ Editor pen tool ============
    clearPenPath(render = true) {
        this.penPath = null;
        this.previewCtx?.clearRect(0, 0, this.width, this.height);
        if (render) this.requestRender();
    }

    beginEditorPen(pt) {
        this.penPath = {
            points: [pt],
            color: this.color,
            size: this.size,
            opacity: this.opacity,
        };
        this.drag = { kind: "pen", last: pt };
        this.requestPreview(null, this.penPreviewShape());
    }

    extendEditorPen(pt) {
        if (!this.penPath) return;
        const points = this.penPath.points;
        const last = points[points.length - 1];
        const spacing = Math.max(0.7, Math.min(2.4, (this.size || 14) * 0.08));
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < spacing) return;
        points.push(pt);
        this.requestPreview(null, this.penPreviewShape());
    }

    finishEditorPen() {
        if (!this.penPath) return;
        const source = this.penPath;
        const points = this.simplifyPenPoints(source.points);
        this.penPath = null;
        this.previewCtx?.clearRect(0, 0, this.width, this.height);
        if (points.length < 3) {
            this.requestRender();
            return;
        }
        this.pushHistory();
        const layer = this.createFreehandPenLayer(points, source);
        this.layers.push(layer);
        this.activeLayerId = layer.id;
        this.layerListDirty = true;
        this.render();
        this.updateUi(true);
    }

    simplifyPenPoints(points) {
        const cleaned = [];
        const minDist = Math.max(1.2, Math.min(4, (this.size || 14) * 0.16));
        for (const point of points || []) {
            const last = cleaned[cleaned.length - 1];
            if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= minDist) {
                cleaned.push({ x: point.x, y: point.y });
            }
        }
        if (cleaned.length > 2) {
            const first = cleaned[0];
            const last = cleaned[cleaned.length - 1];
            if (Math.hypot(first.x - last.x, first.y - last.y) < minDist) cleaned.pop();
        }
        return cleaned;
    }

    penPreviewShape() {
        if (!this.penPath) return null;
        return {
            type: "pen-preview",
            points: this.penPath.points,
            color: this.penPath.color,
            size: 1,
            opacity: this.penPath.opacity,
        };
    }

    createFreehandPenLayer(points, source) {
        const size = Math.max(1, Math.round((source.size || this.size) * 0.08));
        const bounds = this.boundsFromPoints(points, size);
        return this.createPenColorLayer({
            name: "Pen Shape",
            bounds,
            color: source.color,
            opacity: source.opacity,
            draw: ctx => {
                this.drawShape(ctx, {
                    type: "pen",
                    points: points.map(point => ({ x: point.x - bounds.x, y: point.y - bounds.y })),
                    color: "#ffffff",
                    size,
                    opacity: 1,
                    fill: true,
                });
            },
        });
    }

    createBezierPenLayer(path) {
        const bounds = paintContentBounds({ type: "paint", bezierPaths: [path] }) || this.boundsFromPoints(path.anchors || [], path.size || 1);
        return this.createPenColorLayer({
            name: "Pen Shape",
            bounds,
            color: path.color || this.color,
            opacity: Number.isFinite(path.opacity) ? path.opacity : 1,
            draw: ctx => {
                const localPath = {
                    ...cloneBezierPath(path),
                    color: "#ffffff",
                    opacity: 1,
                    anchors: (path.anchors || []).map(anchor => ({
                        ...anchor,
                        x: anchor.x - bounds.x,
                        y: anchor.y - bounds.y,
                        handleIn: { ...(anchor.handleIn || { x: 0, y: 0 }) },
                        handleOut: { ...(anchor.handleOut || { x: 0, y: 0 }) },
                    })),
                };
                this.drawBezierPath(ctx, localPath, false);
            },
        });
    }

    boundsFromPoints(points, pad = 1) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of points || []) {
            minX = Math.min(minX, point.x - pad);
            minY = Math.min(minY, point.y - pad);
            maxX = Math.max(maxX, point.x + pad);
            maxY = Math.max(maxY, point.y + pad);
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return { x: 0, y: 0, w: 1, h: 1 };
        }
        return {
            x: Math.floor(minX),
            y: Math.floor(minY),
            w: Math.max(1, Math.ceil(maxX - minX)),
            h: Math.max(1, Math.ceil(maxY - minY)),
        };
    }

    createPenColorLayer({ name, bounds, color, opacity, draw }) {
        const mask = document.createElement("canvas");
        mask.width = Math.max(1, Math.round(bounds.w));
        mask.height = Math.max(1, Math.round(bounds.h));
        const ctx = mask.getContext("2d");
        draw(ctx);
        return {
            id: uid("pen"),
            name,
            type: "color",
            visible: true,
            opacity: Number.isFinite(opacity) ? opacity : 1,
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            w: mask.width,
            h: mask.height,
            rotation: 0,
            color: color || this.color,
            maskImage: mask,
            maskSrc: mask.toDataURL("image/png"),
            locked: false,
            strokes: [],
            eraseStrokes: [],
            shapes: [],
            bezierPaths: [],
        };
    }

    clearBezierInteraction(render = true) {
        this.activeBezierLayerId = "";
        this.activeBezierPathId = "";
        this.bezierDragging = false;
        this.bezierDragAnchorIdx = -1;
        this.bezierDragHandle = "none";
        this.bezierHoveredIdx = -1;
        this.bezierHoveredType = "none";
        if (render) this.requestRender();
    }

    activeBezierLayer() {
        return this.layers.find(layer => layer.id === this.activeBezierLayerId) || null;
    }

    activeBezierPath() {
        const layer = this.activeBezierLayer();
        return (layer?.bezierPaths || []).find(path => path.id === this.activeBezierPathId) || null;
    }

    ensureBezierLayer() {
        const layer = this.ensurePaintLayer();
        if (!layer) return null;
        layer.bezierPaths = layer.bezierPaths || [];
        return layer;
    }

    startNewBezierPath(pt) {
        const layer = this.ensureBezierLayer();
        if (!layer) return null;
        this.pushHistory();
        const path = {
            id: uid("bezier"),
            anchors: [{
                x: pt.x,
                y: pt.y,
                handleIn: { x: 0, y: 0 },
                handleOut: { x: 0, y: 0 },
                type: "corner",
            }],
            closed: false,
            color: this.color,
            size: Math.max(1, Math.round(this.size * 0.22)),
            opacity: this.opacity,
        };
        layer.bezierPaths.push(path);
        this.activeBezierLayerId = layer.id;
        this.activeBezierPathId = path.id;
        this.activeLayerId = layer.id;
        this.layerListDirty = true;
        return path;
    }

    addBezierAnchor(pt) {
        const path = this.activeBezierPath();
        if (!path) return this.startNewBezierPath(pt);
        path.anchors.push({
            x: pt.x,
            y: pt.y,
            handleIn: { x: 0, y: 0 },
            handleOut: { x: 0, y: 0 },
            type: "corner",
        });
        return path;
    }

    finishBezierPath(render = true) {
        const path = this.activeBezierPath();
        if (path && (path.anchors || []).length < 2) {
            this.abandonBezierPath(false);
        }
        this.clearBezierInteraction(false);
        if (render) this.render();
    }

    closeBezierPath() {
        const path = this.activeBezierPath();
        if (!path || path.anchors.length < 2) return;
        const layer = this.activeBezierLayer();
        path.closed = true;
        const penLayer = this.createBezierPenLayer(path);
        if (layer?.bezierPaths) {
            layer.bezierPaths = layer.bezierPaths.filter(item => item.id !== path.id);
        }
        this.layers.push(penLayer);
        this.activeLayerId = penLayer.id;
        this.clearBezierInteraction(false);
        this.layerListDirty = true;
        this.render();
        this.updateUi(true);
    }

    abandonBezierPath(render = true) {
        const layer = this.activeBezierLayer();
        const index = layer?.bezierPaths?.findIndex(path => path.id === this.activeBezierPathId) ?? -1;
        if (layer && layer.bezierPaths && index >= 0) layer.bezierPaths.splice(index, 1);
        this.clearBezierInteraction(false);
        if (render) this.render();
    }

    setBezierAnchorSmooth(dx, dy) {
        const anchor = this.activeBezierPath()?.anchors?.[this.bezierDragAnchorIdx];
        if (!anchor) return;
        anchor.type = "smooth";
        anchor.handleOut = { x: dx, y: dy };
        anchor.handleIn = { x: -dx, y: -dy };
    }

    moveBezierAnchor(index, pt) {
        const anchor = this.activeBezierPath()?.anchors?.[index];
        if (!anchor) return;
        anchor.x = pt.x;
        anchor.y = pt.y;
    }

    dragBezierHandle(index, which, x, y, splitHandles) {
        const anchor = this.activeBezierPath()?.anchors?.[index];
        if (!anchor) return;
        if (splitHandles || anchor.type === "corner") {
            anchor[which] = { x, y };
            anchor.type = "corner";
            return;
        }
        anchor.handleOut = which === "handleOut" ? { x, y } : { x: -x, y: -y };
        anchor.handleIn = which === "handleIn" ? { x, y } : { x: -x, y: -y };
    }

    retractBezierOutgoingHandle(index) {
        const anchor = this.activeBezierPath()?.anchors?.[index];
        if (!anchor) return;
        anchor.handleOut = { x: 0, y: 0 };
        anchor.type = "corner";
    }

    constrainAngle(dx, dy) {
        const len = Math.hypot(dx, dy);
        if (!len) return { x: 0, y: 0 };
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        return { x: Math.cos(angle) * len, y: Math.sin(angle) * len };
    }

    hitTestBezierAnchor(pt, path, radius = 10) {
        const r = Math.max(radius, radius / Math.max(this.zoom, 0.05));
        for (let i = 0; i < (path.anchors || []).length; i++) {
            const a = path.anchors[i];
            if (Math.hypot(pt.x - a.x, pt.y - a.y) < r) return i;
        }
        return -1;
    }

    hitTestBezierHandle(pt, anchor, which, radius = 8) {
        const handle = anchor?.[which] || { x: 0, y: 0 };
        if (handle.x === 0 && handle.y === 0) return false;
        const r = Math.max(radius, radius / Math.max(this.zoom, 0.05));
        return Math.hypot(pt.x - (anchor.x + handle.x), pt.y - (anchor.y + handle.y)) < r;
    }

    pointToBezierDistance(pt, start, end) {
        const cp1 = { x: start.x + (start.handleOut?.x || 0), y: start.y + (start.handleOut?.y || 0) };
        const cp2 = { x: end.x + (end.handleIn?.x || 0), y: end.y + (end.handleIn?.y || 0) };
        let min = Infinity;
        for (let t = 0; t <= 1; t += 0.05) {
            const mt = 1 - t;
            const x = mt ** 3 * start.x + 3 * mt ** 2 * t * cp1.x + 3 * mt * t ** 2 * cp2.x + t ** 3 * end.x;
            const y = mt ** 3 * start.y + 3 * mt ** 2 * t * cp1.y + 3 * mt * t ** 2 * cp2.y + t ** 3 * end.y;
            min = Math.min(min, Math.hypot(pt.x - x, pt.y - y));
        }
        return min;
    }

    hitTestBezierSegment(pt, path, tolerance = 8) {
        if (!path || path.anchors.length < 2) return -1;
        const tol = Math.max(tolerance, tolerance / Math.max(this.zoom, 0.05));
        const count = path.closed ? path.anchors.length : path.anchors.length - 1;
        for (let i = 0; i < count; i++) {
            const start = path.anchors[i];
            const end = path.anchors[(i + 1) % path.anchors.length];
            if (this.pointToBezierDistance(pt, start, end) < tol) return i;
        }
        return -1;
    }

    handleBezierPointerDown(pt, event) {
        const path = this.activeBezierPath();
        if ((event.ctrlKey || event.metaKey) && path) {
            for (let i = 0; i < path.anchors.length; i++) {
                if (this.hitTestBezierHandle(pt, path.anchors[i], "handleIn")) return this.startBezierDrag(i, "handleIn");
                if (this.hitTestBezierHandle(pt, path.anchors[i], "handleOut")) return this.startBezierDrag(i, "handleOut");
            }
            const idx = this.hitTestBezierAnchor(pt, path);
            if (idx >= 0) return this.startBezierDrag(idx, "move-anchor");
            return;
        }
        if (event.altKey && path) {
            for (let i = 0; i < path.anchors.length; i++) {
                if (this.hitTestBezierHandle(pt, path.anchors[i], "handleIn")) return this.startBezierDrag(i, "handleIn");
                if (this.hitTestBezierHandle(pt, path.anchors[i], "handleOut")) return this.startBezierDrag(i, "handleOut");
            }
            const idx = this.hitTestBezierAnchor(pt, path);
            if (idx >= 0) {
                this.retractBezierOutgoingHandle(idx);
                this.startBezierDrag(idx, "split-anchor");
                this.render();
                return;
            }
        }
        if (path && path.anchors.length >= 2 && this.hitTestBezierAnchor(pt, path, 10) === 0) {
            this.closeBezierPath();
            return;
        }
        const nextPath = this.addBezierAnchor(pt);
        if (!nextPath) return;
        this.startBezierDrag(nextPath.anchors.length - 1, "new-anchor");
        this.render();
    }

    startBezierDrag(index, handle) {
        this.bezierDragging = true;
        this.bezierDragAnchorIdx = index;
        this.bezierDragHandle = handle;
        this.drag = { kind: "bezier" };
    }

    moveBezierDrag(pt, event) {
        const path = this.activeBezierPath();
        const anchor = path?.anchors?.[this.bezierDragAnchorIdx];
        if (!anchor) {
            this.clearBezierInteraction();
            return;
        }
        if (this.bezierDragHandle === "new-anchor") {
            const dx = pt.x - anchor.x;
            const dy = pt.y - anchor.y;
            if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
                const next = event.shiftKey ? this.constrainAngle(dx, dy) : { x: dx, y: dy };
                this.setBezierAnchorSmooth(next.x, next.y);
            }
        } else if (this.bezierDragHandle === "move-anchor") {
            this.moveBezierAnchor(this.bezierDragAnchorIdx, pt);
        } else if (this.bezierDragHandle === "split-anchor") {
            const dx = pt.x - anchor.x;
            const dy = pt.y - anchor.y;
            if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
                const next = event.shiftKey ? this.constrainAngle(dx, dy) : { x: dx, y: dy };
                this.dragBezierHandle(this.bezierDragAnchorIdx, "handleOut", next.x, next.y, true);
            }
        } else if (this.bezierDragHandle === "handleIn" || this.bezierDragHandle === "handleOut") {
            const dx = pt.x - anchor.x;
            const dy = pt.y - anchor.y;
            const next = event.shiftKey ? this.constrainAngle(dx, dy) : { x: dx, y: dy };
            this.dragBezierHandle(this.bezierDragAnchorIdx, this.bezierDragHandle, next.x, next.y, event.altKey);
        }
        this.requestRender();
    }

    layerLocalPoint(layer, pt) {
        const r = layerBounds(layer);
        const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        const local = rotatePointAround(pt, center, -(r.rotation || 0));
        return { x: local.x - r.x, y: local.y - r.y };
    }

    attachPaintTransformSource(drag) {
        if (drag?.layer?.type === "paint") drag.sourceLayer = cloneLayer(drag.layer);
        return drag;
    }

    transformPaintLayer(layer, sourceLayer, fromRect, toRect) {
        const sx = toRect.w / Math.max(fromRect.w, 1);
        const sy = toRect.h / Math.max(fromRect.h, 1);
        const scalePoint = point => ({
            x: toRect.x + (point.x - fromRect.x) * sx,
            y: toRect.y + (point.y - fromRect.y) * sy,
        });
        const scaleStroke = stroke => ({
            ...stroke,
            size: Math.max(1, (stroke.size || this.size) * ((Math.abs(sx) + Math.abs(sy)) / 2)),
            points: (stroke.points || []).map(scalePoint),
        });
        layer.strokes = (sourceLayer.strokes || []).map(scaleStroke);
        layer.eraseStrokes = (sourceLayer.eraseStrokes || []).map(scaleStroke);
        layer.shapes = (sourceLayer.shapes || []).map(shape => ({
            ...shape,
            points: shape.points ? shape.points.map(scalePoint) : shape.points,
            x: toRect.x + (shape.x - fromRect.x) * sx,
            y: toRect.y + (shape.y - fromRect.y) * sy,
            w: shape.w * sx,
            h: shape.h * sy,
            size: Math.max(1, (shape.size || this.size) * ((Math.abs(sx) + Math.abs(sy)) / 2)),
        }));
        layer.bezierPaths = (sourceLayer.bezierPaths || []).map(path => ({
            ...path,
            size: Math.max(1, (path.size || this.size) * ((Math.abs(sx) + Math.abs(sy)) / 2)),
            anchors: (path.anchors || []).map(anchor => {
                const pt = scalePoint(anchor);
                return {
                    ...anchor,
                    x: pt.x,
                    y: pt.y,
                    handleIn: { x: (anchor.handleIn?.x || 0) * sx, y: (anchor.handleIn?.y || 0) * sy },
                    handleOut: { x: (anchor.handleOut?.x || 0) * sx, y: (anchor.handleOut?.y || 0) * sy },
                };
            }),
        }));
        layer.x = Math.round(toRect.x);
        layer.y = Math.round(toRect.y);
        layer.w = Math.max(1, Math.round(toRect.w));
        layer.h = Math.max(1, Math.round(toRect.h));
    }

    rotatePaintLayer(layer, sourceLayer, frame, degrees) {
        const center = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
        const rotatePoint = point => rotatePointAround(point, center, degrees);
        const rotateStroke = stroke => ({
            ...stroke,
            points: (stroke.points || []).map(rotatePoint),
        });
        layer.strokes = (sourceLayer.strokes || []).map(rotateStroke);
        layer.eraseStrokes = (sourceLayer.eraseStrokes || []).map(rotateStroke);
        layer.shapes = (sourceLayer.shapes || []).map(shape => {
            if (shape.points?.length) return { ...shape, points: shape.points.map(rotatePoint) };
            const p1 = rotatePoint({ x: shape.x, y: shape.y });
            const p2 = rotatePoint({ x: shape.x + shape.w, y: shape.y + shape.h });
            return {
                ...shape,
                x: p1.x,
                y: p1.y,
                w: p2.x - p1.x,
                h: p2.y - p1.y,
            };
        });
        layer.bezierPaths = (sourceLayer.bezierPaths || []).map(path => ({
            ...path,
            anchors: (path.anchors || []).map(anchor => {
                const rotated = rotatePoint(anchor);
                const handleInEnd = rotatePoint({
                    x: anchor.x + (anchor.handleIn?.x || 0),
                    y: anchor.y + (anchor.handleIn?.y || 0),
                });
                const handleOutEnd = rotatePoint({
                    x: anchor.x + (anchor.handleOut?.x || 0),
                    y: anchor.y + (anchor.handleOut?.y || 0),
                });
                return {
                    ...anchor,
                    x: rotated.x,
                    y: rotated.y,
                    handleIn: { x: handleInEnd.x - rotated.x, y: handleInEnd.y - rotated.y },
                    handleOut: { x: handleOutEnd.x - rotated.x, y: handleOutEnd.y - rotated.y },
                };
            }),
        }));
        layer.rotation = 0;
        const nextBounds = paintContentBounds(layer);
        if (nextBounds) {
            layer.x = nextBounds.x;
            layer.y = nextBounds.y;
            layer.w = nextBounds.w;
            layer.h = nextBounds.h;
        }
    }

    hitVisualControl(e) {
        if (this.tool !== "scale") return null;
        const frame = this.root?.querySelector("[data-frame]");
        if (!frame || frame.classList.contains("op-ie-hidden")) return null;
        const hit = (selector, kind) => {
            const items = frame.querySelectorAll(selector);
            for (const el of items) {
                const rect = el.getBoundingClientRect();
                const pad = kind === "rotate" ? 18 : 10;
                if (e.clientX >= rect.left - pad && e.clientX <= rect.right + pad &&
                    e.clientY >= rect.top - pad && e.clientY <= rect.bottom + pad) {
                    const mode = ["nw", "ne", "sw", "se"].find(k => el.classList.contains(k));
                    if (mode) return { kind, mode };
                }
            }
            return null;
        };
        return hit(".op-ie-rotate", "rotate") || hit(".op-ie-frame__handle", "scale");
    }

    pickLayerAtPoint(pt) {
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            if (!layer.visible || layer.locked || layer.type === "base") continue;
            if (this.layerContainsPoint(layer, pt)) return layer;
        }
        return null;
    }

    layerContainsPoint(layer, pt) {
        if (layer.type === "paint") {
            return this.paintLayerContainsPoint(layer, pt);
        }
        const geom = layerVisualGeometry(layer);
        if (!pointInPolygon(pt, [geom.corners.nw, geom.corners.ne, geom.corners.se, geom.corners.sw])) return false;
        return this.layerAlphaContainsPoint(layer, pt);
    }

    layerAlphaContainsPoint(layer, pt) {
        if (this.layerRenderedAlphaContainsPoint(layer, pt)) return true;
        if (layer.type === "color" && !layer.maskImage && !layer.image && !(layer.eraseStrokes || []).length) return true;
        return false;
    }

    layerRenderedAlphaContainsPoint(layer, pt) {
        const x = Math.round(pt.x);
        const y = Math.round(pt.y);
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
        const sample = document.createElement("canvas");
        sample.width = this.width;
        sample.height = this.height;
        const sctx = sample.getContext("2d");
        try {
            sctx.save();
            sctx.globalAlpha = Number.isFinite(layer.opacity) ? layer.opacity : 1;
            const r = layerBounds(layer);
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            sctx.translate(cx, cy);
            sctx.rotate((r.rotation || 0) * Math.PI / 180);
            sctx.translate(-cx, -cy);
            if (this.layerNeedsOffscreen(layer)) {
                const source = this.renderLayerSourceCanvas(layer);
                if (layer.type === "paint") sctx.drawImage(source, 0, 0);
                else sctx.drawImage(source, layer.x, layer.y, layer.w, layer.h);
            } else {
                if (layer.image) sctx.drawImage(layer.image, layer.x, layer.y, layer.w, layer.h);
                if (layer.type === "color" || layer.type === "mask") this.drawColorBlockLayer(sctx, layer);
            }
            sctx.restore();
            return sctx.getImageData(x, y, 1, 1).data[3] > 8;
        } catch (_e) {
            return this.layerSourceAlphaContainsPoint(layer, pt);
        }
    }

    layerSourceAlphaContainsPoint(layer, pt) {
        const source = layer.eraseStrokes?.length ? this.renderLayerSourceCanvas(layer) : (layer.maskImage || layer.image);
        if (!source) return true;
        const r = layerBounds(layer);
        const center = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        const local = rotatePointAround(pt, center, -(r.rotation || 0));
        const u = (local.x - r.x) / r.w;
        const v = (local.y - r.y) / r.h;
        if (u < 0 || u > 1 || v < 0 || v > 1) return false;
        const sample = document.createElement("canvas");
        sample.width = sample.height = 1;
        const sctx = sample.getContext("2d");
        try {
            const sw = source.naturalWidth || source.width;
            const sh = source.naturalHeight || source.height;
            sctx.drawImage(source, Math.floor(u * sw), Math.floor(v * sh), 1, 1, 0, 0, 1, 1);
            return sctx.getImageData(0, 0, 1, 1).data[3] > 8;
        } catch (_e) {
            return true;
        }
    }

    paintLayerContainsPoint(layer, pt) {
        const hitPad = Math.max(8, 8 / Math.max(this.zoom, 0.05));
        for (const shape of layer.shapes || []) {
            if (shape.type === "pen" && shape.points?.length) {
                const xs = shape.points.map(p => p.x);
                const ys = shape.points.map(p => p.y);
                const x1 = Math.min(...xs) - hitPad;
                const x2 = Math.max(...xs) + hitPad;
                const y1 = Math.min(...ys) - hitPad;
                const y2 = Math.max(...ys) + hitPad;
                if (pt.x >= x1 && pt.x <= x2 && pt.y >= y1 && pt.y <= y2) return true;
                continue;
            }
            const x1 = Math.min(shape.x, shape.x + shape.w) - hitPad;
            const x2 = Math.max(shape.x, shape.x + shape.w) + hitPad;
            const y1 = Math.min(shape.y, shape.y + shape.h) - hitPad;
            const y2 = Math.max(shape.y, shape.y + shape.h) + hitPad;
            if (pt.x >= x1 && pt.x <= x2 && pt.y >= y1 && pt.y <= y2) return true;
        }
        for (const path of layer.bezierPaths || []) {
            if (this.closedBezierPathContainsPoint(pt, path)) return true;
            if (this.hitTestBezierSegment(pt, path, hitPad) >= 0) return true;
            if (this.hitTestBezierAnchor(pt, path, hitPad) >= 0) return true;
        }
        for (const stroke of layer.strokes || []) {
            for (const p of stroke.points || []) {
                if (Math.hypot(pt.x - p.x, pt.y - p.y) <= (stroke.size || this.size) / 2 + hitPad) return true;
            }
        }
        return false;
    }

    closedBezierPathContainsPoint(pt, path) {
        if (!path?.closed || !path.anchors || path.anchors.length < 3) return false;
        const polygon = this.flattenBezierPath(path);
        return polygon.length >= 3 && pointInPolygon(pt, polygon);
    }

    flattenBezierPath(path, steps = 20) {
        const anchors = path.anchors || [];
        if (anchors.length < 2) return anchors.map(anchor => ({ x: anchor.x, y: anchor.y }));
        const points = [];
        const count = path.closed ? anchors.length : anchors.length - 1;
        for (let i = 0; i < count; i++) {
            const start = anchors[i];
            const end = anchors[(i + 1) % anchors.length];
            const cp1 = { x: start.x + (start.handleOut?.x || 0), y: start.y + (start.handleOut?.y || 0) };
            const cp2 = { x: end.x + (end.handleIn?.x || 0), y: end.y + (end.handleIn?.y || 0) };
            for (let step = i === 0 ? 0 : 1; step <= steps; step++) {
                const t = step / steps;
                const mt = 1 - t;
                points.push({
                    x: mt ** 3 * start.x + 3 * mt ** 2 * t * cp1.x + 3 * mt * t ** 2 * cp2.x + t ** 3 * end.x,
                    y: mt ** 3 * start.y + 3 * mt ** 2 * t * cp1.y + 3 * mt * t ** 2 * cp2.y + t ** 3 * end.y,
                });
            }
        }
        return points;
    }

    pointerMove(e) {
        if (!this.drag) {
            if (this.tool === "pen-bezier" && (e.ctrlKey || e.metaKey)) {
                const path = this.activeBezierPath();
                if (path) {
                    const pt = this.canvasPoint(e);
                    const anchorIdx = this.hitTestBezierAnchor(pt, path);
                    const segmentIdx = anchorIdx >= 0 ? -1 : this.hitTestBezierSegment(pt, path);
                    this.bezierHoveredIdx = anchorIdx >= 0 ? anchorIdx : segmentIdx;
                    this.bezierHoveredType = anchorIdx >= 0 ? "anchor" : segmentIdx >= 0 ? "segment" : "none";
                    this.requestRender();
                }
            }
            return;
        }
        const d = this.drag;
        if (d.kind === "pan") {
            this.pan.x = d.pan.x + e.clientX - d.startClientX;
            this.pan.y = d.pan.y + e.clientY - d.startClientY;
            this.applyStageTransform();
            return;
        }
        const freePoint = d.kind === "move" || d.kind === "scale" || d.kind === "rotate" || d.kind === "crop";
        const pt = freePoint ? this.canvasPointRaw(e) : this.canvasPoint(e);
        if (this.bezierDragging && this.tool === "pen-bezier") {
            this.moveBezierDrag(pt, e);
            return;
        }
        if (d.kind === "stroke") {
            d.stroke.points.push(pt);
            this.requestPreview(d.stroke);
        }
        if (d.kind === "paint-erase") {
            d.stroke.points.push(pt);
            this.requestRender();
        }
        if (d.kind === "layer-erase") {
            d.stroke.points.push(this.layerLocalPoint(d.layer, pt));
            this.requestRender();
        }
        if (d.kind === "shape") {
            d.shape.w = pt.x - d.shape.x;
            d.shape.h = pt.y - d.shape.y;
            this.requestPreview(null, d.shape);
        }
        if (d.kind === "move") {
            const nextRect = {
                ...d.frame,
                x: d.frame.x + pt.x - d.start.x,
                y: d.frame.y + pt.y - d.start.y,
            };
            if (d.layer.type === "paint" && d.sourceLayer) {
                this.transformPaintLayer(d.layer, d.sourceLayer, d.frame, nextRect);
            } else {
                d.layer.x = nextRect.x;
                d.layer.y = nextRect.y;
            }
            this.requestRender();
        }
        if (d.kind === "scale") {
            const dx = pt.x - d.start.x;
            const dy = pt.y - d.start.y;
            const sx = d.mode.includes("w") ? -dx : dx;
            const sy = d.mode.includes("n") ? -dy : dy;
            const ratio = this.scaleMode === "fixed" ? Math.max((d.frame.w + sx) / d.frame.w, (d.frame.h + sy) / d.frame.h) : null;
            const nextRect = { ...d.frame };
            if (ratio) {
                nextRect.w = Math.max(12, d.frame.w * ratio);
                nextRect.h = Math.max(12, d.frame.h * ratio);
            } else {
                nextRect.w = Math.max(12, d.frame.w + sx);
                nextRect.h = Math.max(12, d.frame.h + sy);
            }
            if (d.mode.includes("w")) nextRect.x = d.frame.x + d.frame.w - nextRect.w;
            if (d.mode.includes("n")) nextRect.y = d.frame.y + d.frame.h - nextRect.h;
            if (d.layer.type === "paint" && d.sourceLayer) {
                this.transformPaintLayer(d.layer, d.sourceLayer, d.frame, nextRect);
            } else {
                d.layer.x = nextRect.x;
                d.layer.y = nextRect.y;
                d.layer.w = nextRect.w;
                d.layer.h = nextRect.h;
            }
            this.requestRender();
        }
        if (d.kind === "rotate") {
            const cx = d.frame.x + d.frame.w / 2;
            const cy = d.frame.y + d.frame.h / 2;
            const angle = Math.atan2(pt.y - cy, pt.x - cx);
            const rotation = (d.frame.rotation || 0) + (angle - d.startAngle) * 180 / Math.PI;
            if (d.layer.type === "paint" && d.sourceLayer) {
                this.rotatePaintLayer(d.layer, d.sourceLayer, d.frame, rotation);
            } else {
                d.layer.rotation = rotation;
            }
            this.requestRender();
        }
        if (d.kind === "crop") {
            this.pendingCropPoint = pt;
            if (!this.cropDragFrame) {
                this.cropDragFrame = requestAnimationFrame(() => this.applyPendingCropDrag());
            }
        }
        if (d.kind === "pen") {
            this.extendEditorPen(pt);
        }
    }

    pointerUp() {
        if (!this.drag) return;
        const d = this.drag;
        if (d.kind === "stroke") d.layer.strokes.push(d.stroke);
        if (d.kind === "shape") d.layer.shapes.push(d.shape);
        if (d.kind === "crop") this.finishCropDrag();
        if (d.kind === "pen") this.finishEditorPen();
        if (d.kind === "bezier") {
            this.bezierDragging = false;
            this.bezierDragAnchorIdx = -1;
            this.bezierDragHandle = "none";
        }
        this.drag = null;
        this.render();
    }

    applyPendingCropDrag() {
        this.cropDragFrame = 0;
        const d = this.drag;
        const pt = this.pendingCropPoint;
        if (!d || d.kind !== "crop" || !pt) return;
        this.pendingCropPoint = null;
        this.pendingCropRect = this.resizeFrame(d.rect, d.mode, pt.x - d.start.x, pt.y - d.start.y, this.width, this.height, false);
        this.applyCropFrameDom(this.pendingCropRect);
    }

    finishCropDrag() {
        const d = this.drag;
        const finalRect = d && this.pendingCropPoint
            ? this.resizeFrame(d.rect, d.mode, this.pendingCropPoint.x - d.start.x, this.pendingCropPoint.y - d.start.y, this.width, this.height, false)
            : this.pendingCropRect;
        if (this.cropDragFrame) cancelAnimationFrame(this.cropDragFrame);
        this.cropDragFrame = 0;
        this.pendingCropPoint = null;
        this.pendingCropRect = null;
        if (finalRect) this.cropRect = finalRect;
    }

    applyCropFrameDom(rect) {
        const frame = this.root?.querySelector("[data-frame]");
        if (!frame || !rect) return;
        frame.style.left = `${rect.x}px`;
        frame.style.top = `${rect.y}px`;
        frame.style.width = `${rect.w}px`;
        frame.style.height = `${rect.h}px`;
    }

    ensurePaintLayer() {
        let layer = this.activeLayer();
        if (!layer || layer.locked || layer.type !== "paint") {
            layer = this.addPaintLayer(false);
        }
        return layer;
    }

    addPaintLayer(push = true) {
        if (push) this.pushHistory();
        const layer = { id: uid("paint"), name: "绘制图层", type: "paint", visible: true, opacity: 1, x: 0, y: 0, w: this.width, h: this.height, rotation: 0, strokes: [], shapes: [], bezierPaths: [] };
        this.layers.push(layer);
        this.activeLayerId = layer.id;
        this.layerListDirty = true;
        this.updateUi(true);
        return layer;
    }

    duplicateActiveLayer() {
        const source = this.activeLayer();
        if (!source || source.locked) return null;
        const sourceIndex = this.layers.findIndex(layer => layer.id === source.id);
        if (sourceIndex < 0) return null;
        this.pushHistory();
        const duplicate = cloneLayer(source);
        duplicate.id = uid(source.type || "layer");
        duplicate.name = `${source.name || "图层"} 副本`;
        this.layers.splice(sourceIndex + 1, 0, duplicate);
        this.activeLayerId = duplicate.id;
        this.activeBezierLayerId = "";
        this.activeBezierPathId = "";
        this.layerListDirty = true;
        this.render();
        this.updateUi(true);
        return duplicate;
    }

    async addMaterial(file) {
        if (!file) return;
        const src = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.readAsDataURL(file);
        });
        const img = await imageFromSrc(src);
        this.pushHistory();
        const maxW = this.width * 0.45;
        const ratio = Math.min(1, maxW / img.width);
        const layer = { id: uid("mat"), name: file.name || "素材", type: "material", visible: true, opacity: 1, x: this.width * 0.25, y: this.height * 0.25, w: img.width * ratio, h: img.height * ratio, rotation: 0, image: img, src };
        this.layers.push(layer);
        this.activeLayerId = layer.id;
        this.materialInput.value = "";
        this.setTool("move");
        this.render();
        this.updateUi(true);
    }

    convertActiveToColorBlock() {
        const layer = this.activeLayer();
        if (!layer || layer.locked) return;
        this.pushHistory();
        const maskImage = layer.image || null;
        const maskSrc = layer.src || maskImage?.src || "";
        layer.type = "color";
        layer.color = this.color;
        if (maskImage) layer.maskImage = maskImage;
        if (maskSrc) layer.maskSrc = maskSrc;
        layer.image = null;
        layer.src = "";
        this.render();
        this.updateUi(true);
    }

    convertActiveToMaskLayer(maskMode = "positive") {
        const layer = this.activeLayer();
        if (!layer || layer.locked || layer.type === "base" || layer.type === "mask") return;
        this.pushHistory();
        this.prepareLayerAsMask(layer, maskMode);
        this.maskSourceLayerIds.delete(layer.id);
        this.layerListDirty = true;
        this.toggleMaskLayerMenu(false);
        this.render();
        this.updateUi(true);
    }

    selectedMaskSourceLayers() {
        return this.layers.filter(layer => this.maskSourceLayerIds.has(layer.id)
            && !layer.locked
            && !["base", "mask"].includes(layer.type));
    }

    createMaskLayersFromSelection(maskMode = "positive") {
        const sources = this.selectedMaskSourceLayers();
        if (!sources.length) {
            this.convertActiveToMaskLayer(maskMode);
            return;
        }
        this.pushHistory();
        let newestMask = null;
        for (const sourceLayer of sources) {
            const maskLayer = cloneLayer(sourceLayer);
            maskLayer.id = uid("mask");
            maskLayer.locked = false;
            maskLayer.visible = true;
            maskLayer.opacity = 1;
            this.prepareLayerAsMask(maskLayer, maskMode);
            const sourceIndex = this.layers.findIndex(layer => layer.id === sourceLayer.id);
            this.layers.splice(sourceIndex + 1, 0, maskLayer);
            newestMask = maskLayer;
        }
        this.maskSourceLayerIds.clear();
        if (newestMask) this.activeLayerId = newestMask.id;
        this.activeBezierLayerId = "";
        this.activeBezierPathId = "";
        this.layerListDirty = true;
        this.toggleMaskLayerMenu(false);
        this.render();
        this.updateUi(true);
    }

    prepareLayerAsMask(layer, maskMode = "positive") {
        if (layer.type === "paint") {
            const source = this.renderLayerSourceCanvas(layer);
            layer.x = 0;
            layer.y = 0;
            layer.w = source.width || this.width;
            layer.h = source.height || this.height;
            layer.rotation = 0;
            layer.image = null;
            layer.src = "";
            layer.maskImage = source;
            layer.maskSrc = source.toDataURL("image/png");
            layer.strokes = [];
            layer.shapes = [];
            layer.bezierPaths = [];
            layer.eraseStrokes = [];
        } else if (!layer.maskImage && layer.image) {
            layer.maskImage = layer.image;
            layer.maskSrc = layer.src || layer.image.src || "";
        }
        layer.image = null;
        layer.src = "";
        layer.type = "mask";
        layer.maskMode = maskMode === "inverse" ? "inverse" : "positive";
        const prefix = layer.maskMode === "inverse" ? "Inverse Mask" : "Mask";
        layer.name = layer.name && !/^(Inverse Mask|Mask)\b/i.test(layer.name) ? `${prefix} ${layer.name}` : (layer.name || prefix);
        layer.color = "#ffffff";
        return layer;
    }

    startCrop() {
        this.closeOutpaint();
        this.setTool("crop");
        this.cropRect = null;
        this.renderFrame();
        this.renderCropOptionsPanel();
    }

    renderCropOptionsPanel() {
        this.closeCropOptions();
        this.cropOptionsOpen = true;
        const originalRatio = this.width / Math.max(this.height, 1);
        const mask = document.createElement("div");
        mask.className = "op-ie-crop-mask";
        mask.dataset.cropMask = "true";
        mask.innerHTML = `
<div class="op-ie-crop-panel">
  <div class="op-ie-crop-panel__header">
    <strong>裁剪比例</strong>
    <button class="op-ie-icon-btn" data-crop-options-close>×</button>
  </div>
  <div class="op-ie-crop-grid">
    ${OP_CROP_PRESET_DEFS.map(preset => {
        const ratioValue = preset.ratio === "original" ? originalRatio : preset.ratio;
        const icon = cropIconSize(ratioValue);
        return `<button class="op-ie-crop-option" data-crop-ratio="${preset.ratio ?? "free"}"><span class="op-ie-crop-option__icon-wrap"><span class="op-ie-crop-option__icon" style="width:${icon.w}px;height:${icon.h}px"></span></span><span>${preset.label}</span></button>`;
    }).join("")}
  </div>
</div>`;
        this.root.appendChild(mask);
        mask.addEventListener("click", e => {
            if (e.target === mask || e.target.closest("[data-crop-options-close]")) {
                this.closeCropOptions();
                return;
            }
            const option = e.target.closest("[data-crop-ratio]");
            if (!option) return;
            const raw = option.dataset.cropRatio;
            let ratio = null;
            if (raw === "original") ratio = "original";
            else if (raw !== "free") ratio = Number(raw);
            this.selectCropPreset(ratio);
        });
    }

    closeCropOptions() {
        this.cropOptionsOpen = false;
        this.root?.querySelector("[data-crop-mask]")?.remove();
    }

    selectCropPreset(ratio) {
        this.closeCropOptions();
        const safeRatio = ratio === "original" ? this.width / Math.max(this.height, 1) : ratio;
        const maxW = this.width * 0.82;
        const maxH = this.height * 0.82;
        let w = maxW;
        let h = maxH;
        if (safeRatio) {
            if (maxW / safeRatio <= maxH) {
                w = maxW;
                h = maxW / safeRatio;
            } else {
                h = maxH;
                w = maxH * safeRatio;
            }
        }
        this.cropRect = {
            x: Math.round((this.width - w) / 2),
            y: Math.round((this.height - h) / 2),
            w: Math.round(w),
            h: Math.round(h),
        };
        this.renderFrame();
    }

    cancelCrop(render = true) {
        this.closeCropOptions();
        this.cropRect = null;
        this.root?.querySelector("[data-frame]")?.classList.add("op-ie-hidden");
        this.root?.querySelector("[data-crop-actions]")?.classList.add("op-ie-hidden");
        if (render) this.render();
    }

    async applyCrop() {
        if (!this.cropRect) return;
        this.pushHistory();
        const r = this.normalizeRect(this.cropRect);
        const source = this.exportComposite(true);
        const cropped = document.createElement("canvas");
        cropped.width = Math.max(1, Math.round(r.w));
        cropped.height = Math.max(1, Math.round(r.h));
        cropped.getContext("2d").drawImage(source, r.x, r.y, r.w, r.h, 0, 0, cropped.width, cropped.height);
        const nextSrc = cropped.toDataURL("image/png");
        const img = await imageFromSrc(nextSrc);
        this.width = cropped.width;
        this.height = cropped.height;
        const baseId = uid("base");
        const paintId = uid("paint");
        this.layers = [{
            id: baseId,
            name: "裁剪结果",
            type: "base",
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: this.width,
            h: this.height,
            rotation: 0,
            image: img,
            src: nextSrc,
            locked: true,
        }, {
            id: paintId,
            name: "绘制图层",
            type: "paint",
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: this.width,
            h: this.height,
            rotation: 0,
            strokes: [],
            shapes: [],
            bezierPaths: [],
        }];
        this.activeLayerId = paintId;
        this.tool = "brush";
        this.cancelCrop(false);
        this.resizeCanvases();
        this.render();
        this.updateUi(true);
    }

    openOutpaint() {
        if (this.outpaint?.open) return;
        this.cancelCrop(false);
        this.previewCtx.clearRect(0, 0, this.width, this.height);
        this.outpaint = {
            open: true,
            factor: 1.5,
            ratio: "original",
            frame: { x: 0, y: 0, w: this.width, h: this.height },
            previewUrl: this.exportComposite(true).toDataURL("image/png"),
            drag: null,
        };
        this.applyOutpaintPresetFrame();
        this.renderOutpaintPanel();
    }

    closeOutpaint() {
        if (this._outpaintMove) {
            document.removeEventListener("pointermove", this._outpaintMove);
            document.removeEventListener("pointerup", this._outpaintUp);
            document.removeEventListener("pointercancel", this._outpaintUp);
            this._outpaintMove = null;
            this._outpaintUp = null;
        }
        this.outpaint = null;
        this.outpaintEls = null;
        this.outpaintRenderQueued = false;
        this.root?.querySelector("[data-outpaint-mask]")?.remove();
    }

    renderOutpaintPanel() {
        this.root.querySelector("[data-outpaint-mask]")?.remove();
        const mask = document.createElement("div");
        mask.className = "op-ie-outpaint-mask";
        mask.dataset.outpaintMask = "true";
        mask.innerHTML = `
<div class="op-ie-outpaint-panel">
  <div class="op-ie-outpaint-head">
    <strong>扩图</strong>
    <button class="op-ie-icon-btn" data-outpaint-close>×</button>
  </div>
  <div class="op-ie-outpaint-controls">
    ${[1.5, 2, 3].map(f => `<button class="op-ie-btn ${this.outpaint.factor === f ? "active" : ""}" data-outpaint-factor="${f}">${f}x</button>`).join("")}
    <label><span>自定义</span><input type="number" min="1.1" max="5" step="0.1" value="${this.outpaint.factor}" data-outpaint-factor-input></label>
    <div class="op-ie-outpaint-ratios">
      ${OP_OUTPAINT_RATIOS.map(item => `<button class="op-ie-outpaint-ratio ${this.outpaint.ratio === item.key ? "active" : ""}" data-outpaint-ratio="${item.key}"><i style="width:${item.icon.w}px;height:${item.icon.h}px"></i><span>${item.label}</span></button>`).join("")}
    </div>
  </div>
  <div class="op-ie-outpaint-stage" data-outpaint-stage>
    <div class="op-ie-outpaint-frame" data-outpaint-frame>
      <span class="op-ie-outpaint-original" data-outpaint-original></span>
      ${["nw", "ne", "sw", "se"].map(k => `<i class="op-ie-outpaint-handle corner ${k}" data-outpaint-handle="${k}"></i>`).join("")}
      ${["n", "s", "e", "w"].map(k => `<i class="op-ie-outpaint-handle edge ${k}" data-outpaint-handle="${k}"></i>`).join("")}
    </div>
  </div>
  <div class="op-ie-outpaint-footer">
    <span class="op-ie-outpaint-size" data-outpaint-size></span>
    <div>
      <button class="op-ie-btn" data-outpaint-close>取消</button>
      <button class="op-ie-btn op-ie-btn--save" data-outpaint-apply>应用扩图</button>
    </div>
  </div>
</div>`;
        this.root.appendChild(mask);
        this.outpaintEls = {
            mask,
            stage: mask.querySelector("[data-outpaint-stage]"),
            frame: mask.querySelector("[data-outpaint-frame]"),
            original: mask.querySelector("[data-outpaint-original]"),
            size: mask.querySelector("[data-outpaint-size]"),
            factorInput: mask.querySelector("[data-outpaint-factor-input]"),
            factorButtons: [...mask.querySelectorAll("[data-outpaint-factor]")],
            ratioButtons: [...mask.querySelectorAll("[data-outpaint-ratio]")],
        };
        mask.addEventListener("click", e => {
            if (e.target === mask || e.target.closest("[data-outpaint-close]")) this.closeOutpaint();
            const factorBtn = e.target.closest("[data-outpaint-factor]");
            if (factorBtn) this.setOutpaintFactor(Number(factorBtn.dataset.outpaintFactor));
            const ratioBtn = e.target.closest("[data-outpaint-ratio]");
            if (ratioBtn) this.setOutpaintRatio(ratioBtn.dataset.outpaintRatio);
            if (e.target.closest("[data-outpaint-apply]")) this.applyOutpaint();
        });
        mask.querySelector("[data-outpaint-factor-input]").addEventListener("change", e => this.setOutpaintFactor(Number(e.target.value)));
        mask.querySelector("[data-outpaint-frame]").addEventListener("pointerdown", e => {
            const handle = e.target.closest("[data-outpaint-handle]");
            if (!handle) return;
            this.beginOutpaintDrag(e, handle.dataset.outpaintHandle);
        });
        this.updateOutpaintPreview();
    }

    updateOutpaintPreview() {
        if (!this.outpaint) return;
        const els = this.outpaintEls;
        if (!els?.stage) return;
        const scale = this.outpaintScale(els.stage.getBoundingClientRect());
        this.applyOutpaintFrameStyles(scale);
        this.syncOutpaintControls();
    }

    applyOutpaintFrameStyles(scale = null) {
        if (!this.outpaint || !this.outpaintEls?.stage) return;
        const els = this.outpaintEls;
        const stage = els.stage;
        const frameEl = els.frame;
        const originalEl = els.original;
        const sizeEl = els.size;
        const actualScale = scale ?? this.outpaintScale(stage.getBoundingClientRect());
        const origin = {
            x: (stage.clientWidth - this.width * actualScale) / 2,
            y: (stage.clientHeight - this.height * actualScale) / 2,
        };
        const frame = this.outpaint.frame;
        frameEl.style.left = `${origin.x + frame.x * actualScale}px`;
        frameEl.style.top = `${origin.y + frame.y * actualScale}px`;
        frameEl.style.width = `${frame.w * actualScale}px`;
        frameEl.style.height = `${frame.h * actualScale}px`;
        originalEl.style.left = `${-frame.x * actualScale}px`;
        originalEl.style.top = `${-frame.y * actualScale}px`;
        originalEl.style.width = `${this.width * actualScale}px`;
        originalEl.style.height = `${this.height * actualScale}px`;
        if (!originalEl.style.backgroundImage) originalEl.style.backgroundImage = `url("${this.outpaint.previewUrl}")`;
        sizeEl.textContent = `${Math.round(frame.w)} x ${Math.round(frame.h)}`;
    }

    syncOutpaintControls() {
        if (!this.outpaint || !this.outpaintEls) return;
        this.outpaintEls.factorButtons.forEach(btn => btn.classList.toggle("active", Number(btn.dataset.outpaintFactor) === this.outpaint.factor));
        this.outpaintEls.factorInput.value = this.outpaint.factor;
        this.outpaintEls.ratioButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.outpaintRatio === this.outpaint.ratio));
    }

    requestOutpaintFrameRender() {
        if (this.outpaintRenderQueued) return;
        this.outpaintRenderQueued = true;
        requestAnimationFrame(() => {
            this.outpaintRenderQueued = false;
            this.applyOutpaintFrameStyles(this.outpaintDragScale);
        });
    }

    outpaintScale(stageRect) {
        const availableW = Math.max((stageRect?.width || 0) - 32, 240);
        const availableH = Math.max((stageRect?.height || 0) - 32, 180);
        const fitW = Math.max(3, this.outpaint.factor, this.outpaint.frame.w / Math.max(this.width, 1));
        const fitH = Math.max(3, this.outpaint.factor, this.outpaint.frame.h / Math.max(this.height, 1));
        return Math.min(0.36, availableW / Math.max(this.width * fitW, 1), availableH / Math.max(this.height * fitH, 1));
    }

    setOutpaintFactor(factor) {
        if (!this.outpaint) return;
        this.outpaint.factor = Math.max(1.1, Math.min(5, Number(factor) || 1.5));
        this.applyOutpaintPresetFrame();
        this.updateOutpaintPreview();
    }

    setOutpaintRatio(ratio) {
        if (!this.outpaint) return;
        this.outpaint.ratio = ratio;
        this.applyOutpaintPresetFrame();
        this.updateOutpaintPreview();
    }

    selectedOutpaintRatioValue() {
        if (!this.outpaint || this.outpaint.ratio === "custom") {
            return (this.outpaint?.frame.w || this.width) / Math.max(this.outpaint?.frame.h || this.height, 1);
        }
        const preset = OP_OUTPAINT_RATIOS.find(item => item.key === this.outpaint.ratio);
        return preset?.ratio || this.width / Math.max(this.height, 1);
    }

    applyOutpaintPresetFrame() {
        if (!this.outpaint) return;
        const ratio = this.selectedOutpaintRatioValue();
        const minW = this.width * this.outpaint.factor;
        const minH = this.height * this.outpaint.factor;
        let w = minW;
        let h = w / Math.max(ratio, 0.01);
        if (h < minH) {
            h = minH;
            w = h * ratio;
        }
        this.outpaint.frame = {
            x: Math.round((this.width - w) / 2),
            y: Math.round((this.height - h) / 2),
            w: Math.round(w),
            h: Math.round(h),
        };
    }

    beginOutpaintDrag(event, mode) {
        if (!this.outpaint) return;
        event.preventDefault();
        event.stopPropagation();
        this.outpaint.drag = {
            mode,
            start: { x: event.clientX, y: event.clientY },
            frame: { ...this.outpaint.frame },
        };
        this.outpaintDragScale = this.outpaintScale(this.outpaintEls.stage.getBoundingClientRect()) || 1;
        this._outpaintMove = e => this.onOutpaintDragMove(e);
        this._outpaintUp = () => this.endOutpaintDrag();
        document.addEventListener("pointermove", this._outpaintMove);
        document.addEventListener("pointerup", this._outpaintUp);
        document.addEventListener("pointercancel", this._outpaintUp);
    }

    onOutpaintDragMove(event) {
        if (!this.outpaint?.drag) return;
        const dx = (event.clientX - this.outpaint.drag.start.x) / this.outpaintDragScale;
        const dy = (event.clientY - this.outpaint.drag.start.y) / this.outpaintDragScale;
        if (["n", "s", "e", "w"].includes(this.outpaint.drag.mode)) this.outpaint.ratio = "custom";
        this.outpaint.frame = this.resizeOutpaintFrame(this.outpaint.drag.frame, this.outpaint.drag.mode, dx, dy);
        this.requestOutpaintFrameRender();
    }

    endOutpaintDrag() {
        if (!this.outpaint) return;
        this.outpaint.drag = null;
        document.removeEventListener("pointermove", this._outpaintMove);
        document.removeEventListener("pointerup", this._outpaintUp);
        document.removeEventListener("pointercancel", this._outpaintUp);
        this._outpaintMove = null;
        this._outpaintUp = null;
        this.applyOutpaintFrameStyles(this.outpaintDragScale);
        this.syncOutpaintControls();
    }

    applyOutpaint() {
        if (!this.outpaint) return;
        const frame = this.normalizeOutpaintFrame(this.outpaint.frame);
        const nextW = Math.round(frame.w);
        const nextH = Math.round(frame.h);
        this.pushHistory();
        for (const layer of this.layers) {
            layer.x -= frame.x;
            layer.y -= frame.y;
            if (layer.type === "paint") {
                for (const stroke of layer.strokes || []) for (const point of stroke.points || []) {
                    point.x -= frame.x;
                    point.y -= frame.y;
                }
                for (const shape of layer.shapes || []) {
                    shape.x -= frame.x;
                    shape.y -= frame.y;
                }
                layer.w = frame.w;
                layer.h = frame.h;
            }
        }
        this.layers.unshift({
            id: uid("color"),
            name: "扩图填充",
            type: "color",
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: nextW,
            h: nextH,
            color: this.color,
            rotation: 0,
            strokes: [],
            shapes: [],
        });
        this.width = nextW;
        this.height = nextH;
        this.closeOutpaint();
        this.resizeCanvases();
        this.render();
        this.updateUi(true);
    }

    normalizeOutpaintFrame(frame) {
        let x = Math.min(frame.x, 0);
        let y = Math.min(frame.y, 0);
        let w = Math.max(frame.w, OP_OUTPAINT_MIN_SIZE, this.width - x);
        let h = Math.max(frame.h, OP_OUTPAINT_MIN_SIZE, this.height - y);
        if (x + w < this.width) w = this.width - x;
        if (y + h < this.height) h = this.height - y;
        return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }

    resizeOutpaintFrame(rect, mode, dx, dy) {
        if (["nw", "ne", "sw", "se"].includes(mode)) {
            return this.resizeOutpaintCorner(rect, mode, dx, dy);
        }
        let { x, y, w, h } = rect;
        const right = rect.x + rect.w;
        const bottom = rect.y + rect.h;
        if (mode === "w") {
            x = Math.min(rect.x + dx, 0);
            w = right - x;
        } else if (mode === "e") {
            w = Math.max(rect.w + dx, this.width - rect.x, OP_OUTPAINT_MIN_SIZE);
        } else if (mode === "n") {
            y = Math.min(rect.y + dy, 0);
            h = bottom - y;
        } else if (mode === "s") {
            h = Math.max(rect.h + dy, this.height - rect.y, OP_OUTPAINT_MIN_SIZE);
        }
        return this.normalizeOutpaintFrame({ x, y, w, h });
    }

    resizeOutpaintCorner(rect, mode, dx, dy) {
        const ratio = rect.w / Math.max(rect.h, 1);
        const growsEast = mode.includes("e");
        const growsSouth = mode.includes("s");
        const fixedX = growsEast ? rect.x : rect.x + rect.w;
        const fixedY = growsSouth ? rect.y : rect.y + rect.h;
        let w = Math.max(OP_OUTPAINT_MIN_SIZE, rect.w + (growsEast ? dx : -dx));
        let h = Math.max(OP_OUTPAINT_MIN_SIZE, rect.h + (growsSouth ? dy : -dy));
        const relativeW = Math.abs(w - rect.w) / Math.max(rect.w, 1);
        const relativeH = Math.abs(h - rect.h) / Math.max(rect.h, 1);
        if (relativeW >= relativeH) h = w / ratio;
        else w = h * ratio;
        const minW = Math.max(OP_OUTPAINT_MIN_SIZE, growsEast ? this.width - fixedX : fixedX);
        const minH = Math.max(OP_OUTPAINT_MIN_SIZE, growsSouth ? this.height - fixedY : fixedY);
        if (w < minW) {
            w = minW;
            h = w / ratio;
        }
        if (h < minH) {
            h = minH;
            w = h * ratio;
        }
        const x = growsEast ? fixedX : fixedX - w;
        const y = growsSouth ? fixedY : fixedY - h;
        return this.normalizeOutpaintFrame({ x, y, w, h });
    }

    normalizeRect(r) {
        const x = Math.min(r.x, r.x + r.w);
        const y = Math.min(r.y, r.y + r.h);
        return { x, y, w: Math.abs(r.w), h: Math.abs(r.h) };
    }

    resizeFrame(rect, mode, dx, dy, maxW = this.width, maxH = this.height, allowOutside = false) {
        let { x, y, w, h } = rect;
        const corner = ["nw", "ne", "sw", "se"].includes(mode);
        if (mode === "move") {
            x += dx;
            y += dy;
        } else {
            if (mode.includes("w")) { x += dx; w -= dx; }
            if (mode.includes("e")) w += dx;
            if (mode.includes("n")) { y += dy; h -= dy; }
            if (mode.includes("s")) h += dy;
            if (corner) {
                const ratio = rect.w / Math.max(rect.h, 1);
                if (Math.abs(dx) > Math.abs(dy)) h = w / ratio;
                else w = h * ratio;
                if (mode.includes("w")) x = rect.x + rect.w - w;
                if (mode.includes("n")) y = rect.y + rect.h - h;
            }
        }
        w = Math.max(16, w);
        h = Math.max(16, h);
        if (!allowOutside) {
            x = Math.max(0, Math.min(x, maxW - 16));
            y = Math.max(0, Math.min(y, maxH - 16));
            w = Math.min(w, maxW - x);
            h = Math.min(h, maxH - y);
        }
        return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }

    hitFrameHandle(pt, rect) {
        const r = this.normalizeRect(rect);
        const corners = { nw: [r.x, r.y], ne: [r.x + r.w, r.y], sw: [r.x, r.y + r.h], se: [r.x + r.w, r.y + r.h] };
        const hit = Math.max(18, 18 / Math.max(this.zoom, 0.05));
        for (const [k, pos] of Object.entries(corners)) {
            if (Math.abs(pt.x - pos[0]) < hit && Math.abs(pt.y - pos[1]) < hit) return k;
        }
        const edgeHit = Math.max(10, 10 / Math.max(this.zoom, 0.05));
        const insideX = pt.x >= r.x && pt.x <= r.x + r.w;
        const insideY = pt.y >= r.y && pt.y <= r.y + r.h;
        if (insideX && Math.abs(pt.y - r.y) < edgeHit) return "n";
        if (insideX && Math.abs(pt.y - (r.y + r.h)) < edgeHit) return "s";
        if (insideY && Math.abs(pt.x - (r.x + r.w)) < edgeHit) return "e";
        if (insideY && Math.abs(pt.x - r.x) < edgeHit) return "w";
        return "move";
    }

    hitLayerTransform(pt, layer) {
        const geom = layerVisualGeometry(layer);
        const scaleHit = Math.max(18, 20 / Math.max(this.zoom, 0.05));
        const rotateHit = Math.max(18, 22 / Math.max(this.zoom, 0.05));
        const rotateGap = 46 / Math.max(this.zoom, 0.05);
        for (const [k, pos] of Object.entries(geom.corners)) {
            const angle = Math.atan2(pos.y - geom.center.y, pos.x - geom.center.x);
            const rx = pos.x + Math.cos(angle) * rotateGap;
            const ry = pos.y + Math.sin(angle) * rotateGap;
            if (Math.abs(pt.x - rx) < rotateHit && Math.abs(pt.y - ry) < rotateHit) return { kind: "rotate", mode: k };
            if (Math.abs(pt.x - pos.x) < scaleHit && Math.abs(pt.y - pos.y) < scaleHit) return { kind: "scale", mode: k };
        }
        if (pointInPolygon(pt, [geom.corners.nw, geom.corners.ne, geom.corners.se, geom.corners.sw])) {
            return { kind: "move", mode: "move" };
        }
        return null;
    }

    requestRender(previewStroke = null, previewShape = null) {
        this.pendingPreviewStroke = previewStroke;
        this.pendingPreviewShape = previewShape;
        if (this.renderQueued) return;
        this.renderQueued = true;
        requestAnimationFrame(() => {
            this.renderQueued = false;
            const stroke = this.pendingPreviewStroke;
            const shape = this.pendingPreviewShape;
            this.pendingPreviewStroke = null;
            this.pendingPreviewShape = null;
            this.render(stroke, shape);
        });
    }

    requestPreview(previewStroke = null, previewShape = null) {
        this.pendingPreviewStroke = previewStroke;
        this.pendingPreviewShape = previewShape;
        if (this.previewQueued) return;
        this.previewQueued = true;
        requestAnimationFrame(() => {
            this.previewQueued = false;
            const stroke = this.pendingPreviewStroke;
            const shape = this.pendingPreviewShape;
            this.pendingPreviewStroke = null;
            this.pendingPreviewShape = null;
            this.previewCtx.clearRect(0, 0, this.width, this.height);
            if (stroke) this.drawStroke(this.previewCtx, stroke);
            if (shape) this.drawShape(this.previewCtx, shape);
        });
    }

    render(previewStroke = null, previewShape = null) {
        this.ctx.clearRect(0, 0, this.width, this.height);
        for (const layer of this.layers) this.drawLayer(this.ctx, layer);
        this.previewCtx.clearRect(0, 0, this.width, this.height);
        if (previewStroke) this.drawStroke(this.previewCtx, previewStroke);
        if (previewShape) this.drawShape(this.previewCtx, previewShape);
        this.renderFrame();
    }

    drawLayer(ctx, layer) {
        if (!layer.visible) return;
        ctx.save();
        ctx.globalAlpha = layer.type === "mask" ? Math.min(0.65, layer.opacity) : layer.opacity;
        if (layer.type === "paint") {
            const source = this.renderLayerSourceCanvas(layer);
            ctx.drawImage(source, 0, 0);
            if (layer.id === this.activeBezierLayerId) {
                const path = (layer.bezierPaths || []).find(item => item.id === this.activeBezierPathId);
                if (path) this.drawBezierPath(ctx, path, true, true);
            }
            ctx.restore();
            return;
        }
        const cx = layer.x + layer.w / 2;
        const cy = layer.y + layer.h / 2;
        ctx.translate(cx, cy);
        ctx.rotate((layer.rotation || 0) * Math.PI / 180);
        ctx.translate(-cx, -cy);
        if (this.layerNeedsOffscreen(layer)) {
            const source = this.renderLayerSourceCanvas(layer);
            if (layer.type === "paint") ctx.drawImage(source, 0, 0);
            else ctx.drawImage(source, layer.x, layer.y, layer.w, layer.h);
        } else {
            if (layer.image) ctx.drawImage(layer.image, layer.x, layer.y, layer.w, layer.h);
            if (layer.type === "color" || layer.type === "mask") this.drawColorBlockLayer(ctx, layer);
            if (layer.strokes) layer.strokes.forEach(s => this.drawStroke(ctx, s));
            if (layer.shapes) layer.shapes.forEach(s => this.drawShape(ctx, s));
            if (layer.bezierPaths) layer.bezierPaths.forEach(path => this.drawBezierPath(ctx, path, layer.id === this.activeBezierLayerId && path.id === this.activeBezierPathId));
        }
        ctx.restore();
    }

    layerNeedsOffscreen(layer) {
        if (layer.type === "paint") return (layer.strokes || []).some(stroke => stroke.tool === "eraser") || (layer.eraseStrokes || []).length;
        return layer.eraseStrokes?.length && (layer.image || layer.type === "color");
    }

    renderLayerSourceCanvas(layer) {
        const temp = document.createElement("canvas");
        temp.width = layer.type === "paint" ? this.width : Math.max(1, Math.round(layer.w));
        temp.height = layer.type === "paint" ? this.height : Math.max(1, Math.round(layer.h));
        const tctx = temp.getContext("2d");
        if (layer.type === "paint") {
            for (const stroke of layer.strokes || []) this.drawStroke(tctx, stroke);
            for (const shape of layer.shapes || []) this.drawShape(tctx, shape);
            for (const path of layer.bezierPaths || []) this.drawBezierPath(tctx, path, false);
            for (const stroke of layer.eraseStrokes || []) this.drawEraserStroke(tctx, stroke);
            return temp;
        }
        if (layer.image) tctx.drawImage(layer.image, 0, 0, temp.width, temp.height);
        if (layer.type === "color" || layer.type === "mask") {
            tctx.fillStyle = layer.type === "mask" ? "#ffffff" : (layer.color || this.color);
            tctx.fillRect(0, 0, temp.width, temp.height);
            const maskSource = layer.maskImage || layer.image;
            if (maskSource) {
                tctx.globalCompositeOperation = "destination-in";
                tctx.drawImage(maskSource, 0, 0, temp.width, temp.height);
                tctx.globalCompositeOperation = "source-over";
            }
        }
        for (const stroke of layer.eraseStrokes || []) this.drawEraserStroke(tctx, stroke);
        return temp;
    }

    drawColorBlockLayer(ctx, layer) {
        if (!layer.maskImage) {
            ctx.fillStyle = layer.color || this.color;
            ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
            return;
        }
        const temp = document.createElement("canvas");
        temp.width = Math.max(1, Math.round(layer.w));
        temp.height = Math.max(1, Math.round(layer.h));
        const tctx = temp.getContext("2d");
        tctx.fillStyle = layer.color || this.color;
        tctx.fillRect(0, 0, temp.width, temp.height);
        tctx.globalCompositeOperation = "destination-in";
        tctx.drawImage(layer.maskImage, 0, 0, temp.width, temp.height);
        tctx.globalCompositeOperation = "source-over";
        ctx.drawImage(temp, layer.x, layer.y, layer.w, layer.h);
    }

    drawStroke(ctx, stroke) {
        if (!stroke.points || stroke.points.length < 1) return;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = stroke.size;
        if (stroke.tool === "eraser") {
            this.drawEraserStroke(ctx, stroke);
            ctx.restore();
            return;
        } else {
            ctx.globalAlpha = stroke.opacity;
            ctx.strokeStyle = stroke.color;
        }
        ctx.beginPath();
        stroke.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        if (stroke.tool === "pen" && stroke.points.length > 3) {
            ctx.closePath();
            ctx.fillStyle = stroke.color;
            ctx.fill();
        }
        ctx.stroke();
        ctx.restore();
    }

    drawEraserStroke(ctx, stroke) {
        if (!stroke.points || stroke.points.length < 1) return;
        const hardness = Math.max(0, Math.min(100, stroke.hardness ?? 100));
        const radius = Math.max(0.5, (stroke.size || this.size) / 2);
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        if (hardness >= 96) {
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.lineWidth = radius * 2;
            ctx.strokeStyle = "rgba(0,0,0,1)";
            if (stroke.points.length === 1) {
                const p = stroke.points[0];
                ctx.fillStyle = "rgba(0,0,0,1)";
                ctx.beginPath();
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
                return;
            }
            ctx.beginPath();
            stroke.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.stroke();
            ctx.restore();
            return;
        }
        const h = hardness / 100;
        const centerStrength = 0.34 + h * 0.66;
        const core = radius * (0.06 + Math.pow(h, 1.7) * 0.7);
        const mid = radius * (0.48 + h * 0.18);
        const spacing = Math.max(0.75, radius * (0.18 + h * 0.18));
        const stamp = p => {
            const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
            gradient.addColorStop(0, `rgba(0,0,0,${centerStrength})`);
            gradient.addColorStop(Math.min(0.92, core / radius), `rgba(0,0,0,${centerStrength})`);
            gradient.addColorStop(Math.min(0.96, mid / radius), `rgba(0,0,0,${centerStrength * 0.32})`);
            gradient.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();
        };
        for (let i = 0; i < stroke.points.length; i++) {
            const p = stroke.points[i];
            if (i === 0) {
                stamp(p);
                continue;
            }
            const prev = stroke.points[i - 1];
            const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
            const steps = Math.max(1, Math.ceil(dist / spacing));
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                stamp({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
            }
        }
        ctx.restore();
    }

    drawShape(ctx, shape) {
        ctx.save();
        ctx.globalAlpha = shape.opacity;
        ctx.lineWidth = shape.size;
        ctx.strokeStyle = shape.color;
        ctx.fillStyle = shape.color;
        if (shape.type === "pen-preview") {
            this.drawPenGuide(ctx, shape);
        } else if (shape.type === "pen") {
            if (!shape.points || shape.points.length < 3) {
                ctx.restore();
                return;
            }
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.beginPath();
            shape.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.closePath();
            ctx.fill();
            if ((shape.size || 0) > 0) ctx.stroke();
        } else if (shape.type === "rect") {
            if (shape.fill) ctx.fillRect(shape.x, shape.y, shape.w, shape.h);
            ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
        } else {
            const x2 = shape.x + shape.w;
            const y2 = shape.y + shape.h;
            ctx.beginPath();
            ctx.moveTo(shape.x, shape.y);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            const ang = Math.atan2(shape.h, shape.w);
            const head = Math.max(10, shape.size * 2.5);
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
            ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    drawPenGuide(ctx, shape) {
        const points = shape.points || [];
        if (!points.length) return;
        const guideColor = contrastGuideColor(shape.color);
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(1, 1 / Math.max(this.zoom, 0.05));
        ctx.strokeStyle = rgba(guideColor, 0.92);
        ctx.beginPath();
        points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.stroke();
        if (points.length >= 3) {
            const first = points[0];
            const last = points[points.length - 1];
            ctx.setLineDash([4 / Math.max(this.zoom, 0.05), 4 / Math.max(this.zoom, 0.05)]);
            ctx.strokeStyle = rgba(guideColor, 0.35);
            ctx.beginPath();
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(first.x, first.y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        const anchorRadius = Math.max(2.2, 3.2 / Math.max(this.zoom, 0.05));
        points.forEach((p, i) => {
            ctx.fillStyle = i === 0 ? rgba("#3b82f6", 0.95) : rgba("#f8fafc", 0.92);
            ctx.strokeStyle = rgba("#0f172a", 0.88);
            ctx.lineWidth = Math.max(1, 1 / Math.max(this.zoom, 0.05));
            ctx.beginPath();
            ctx.arc(p.x, p.y, i === 0 ? anchorRadius + 0.8 : anchorRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });
        ctx.save();
        ctx.globalAlpha = 0.16 * (shape.opacity ?? 1);
        ctx.fillStyle = shape.color;
        if (points.length >= 3) {
            ctx.beginPath();
            points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
        ctx.restore();
    }

    drawBezierPath(ctx, path, isActive = false, controlsOnly = false) {
        const anchors = path.anchors || [];
        if (!anchors.length) return;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (!controlsOnly && anchors.length >= 2) {
            const count = path.closed ? anchors.length : anchors.length - 1;
            ctx.lineWidth = path.size || 1;
            ctx.strokeStyle = path.color || this.color;
            ctx.fillStyle = path.color || this.color;
            ctx.globalAlpha = Number.isFinite(path.opacity) ? path.opacity : 1;
            ctx.beginPath();
            ctx.moveTo(anchors[0].x, anchors[0].y);
            for (let i = 0; i < count; i++) {
                const start = anchors[i];
                const end = anchors[(i + 1) % anchors.length];
                ctx.bezierCurveTo(
                    start.x + (start.handleOut?.x || 0),
                    start.y + (start.handleOut?.y || 0),
                    end.x + (end.handleIn?.x || 0),
                    end.y + (end.handleIn?.y || 0),
                    end.x,
                    end.y,
                );
            }
            if (path.closed) ctx.fill();
            ctx.stroke();
        }
        if (isActive || this.bezierDragging) {
            ctx.globalAlpha = 1;
            for (let i = 0; i < anchors.length; i++) {
                const anchor = anchors[i];
                this.drawBezierHandleLine(ctx, anchor, "handleOut");
                this.drawBezierHandleLine(ctx, anchor, "handleIn");
                const activeAnchor = this.bezierHoveredType === "anchor" && this.bezierHoveredIdx === i;
                const size = Math.max(activeAnchor ? 7 : 5.5, (activeAnchor ? 7 : 5.5) / Math.max(this.zoom, 0.05));
                const half = size / 2;
                ctx.setLineDash([]);
                ctx.lineWidth = Math.max(1, 1.5 / Math.max(this.zoom, 0.05));
                ctx.strokeStyle = "#0a0a0f";
                ctx.fillStyle = activeAnchor ? "#f0a030" : "#ffffff";
                const filled = anchor.type === "smooth" ||
                    (anchor.handleIn?.x || 0) !== 0 || (anchor.handleIn?.y || 0) !== 0 ||
                    (anchor.handleOut?.x || 0) !== 0 || (anchor.handleOut?.y || 0) !== 0 ||
                    i === anchors.length - 1;
                if (filled) ctx.fillRect(anchor.x - half, anchor.y - half, size, size);
                ctx.strokeRect(anchor.x - half, anchor.y - half, size, size);
            }
        }
        ctx.restore();
    }

    drawBezierHandleLine(ctx, anchor, which) {
        const handle = anchor[which] || { x: 0, y: 0 };
        if (handle.x === 0 && handle.y === 0) return;
        const x = anchor.x + handle.x;
        const y = anchor.y + handle.y;
        const dot = Math.max(3, 3 / Math.max(this.zoom, 0.05));
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(x, y);
        ctx.strokeStyle = "rgba(240,160,48,.42)";
        ctx.lineWidth = Math.max(1, 1 / Math.max(this.zoom, 0.05));
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = "#f0a030";
        ctx.fillRect(-dot, -dot, dot * 2, dot * 2);
        ctx.restore();
    }

    renderFrame() {
        const frame = this.root.querySelector("[data-frame]");
        const actions = this.root.querySelector("[data-crop-actions]");
        let rect = null;
        let mode = "hidden";
        if (this.cropRect) {
            rect = this.normalizeRect(this.cropRect);
            mode = "crop";
            actions.classList.remove("op-ie-hidden");
        } else {
            actions.classList.add("op-ie-hidden");
            const layer = this.activeLayer();
            if (this.tool === "scale" && layer && !layer.locked) {
                rect = layerBounds(layer);
                mode = "transform";
            }
        }
        if (!rect) {
            frame.classList.add("op-ie-hidden");
            this.frameMode = "hidden";
            return;
        }
        frame.classList.remove("op-ie-hidden");
        frame.style.left = `${rect.x}px`;
        frame.style.top = `${rect.y}px`;
        frame.style.width = `${rect.w}px`;
        frame.style.height = `${rect.h}px`;
        frame.style.transform = `rotate(${rect.rotation || 0}deg)`;
        this.updateFrameScale();
        if (this.frameMode === mode) return;
        frame.innerHTML = "";
        const handles = mode === "crop" ? ["nw", "ne", "sw", "se", "n", "s", "e", "w"] : ["nw", "ne", "sw", "se"];
        handles.forEach(k => {
            const h = document.createElement("i");
            h.className = `op-ie-frame__handle ${k}`;
            frame.appendChild(h);
            if (mode === "transform") {
                const r = document.createElement("button");
                r.className = `op-ie-rotate ${k}`;
                r.textContent = "↻";
                frame.appendChild(r);
            }
        });
        this.frameMode = mode;
    }

    exportComposite(includeBase = true) {
        const out = document.createElement("canvas");
        out.width = this.width;
        out.height = this.height;
        const ctx = out.getContext("2d");
        for (const layer of this.layers) {
            if (!includeBase && layer.type === "base") continue;
            if (layer.type === "mask") continue;
            this.drawLayer(ctx, layer);
        }
        return out;
    }

    exportMask(alphaBackground = false, maskMode = "positive") {
        const mask = document.createElement("canvas");
        mask.width = this.width;
        mask.height = this.height;
        const ctx = mask.getContext("2d");
        const inverseMode = maskMode === "inverse";
        if (!alphaBackground || inverseMode) {
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, this.width, this.height);
        }
        if (inverseMode) {
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, this.width, this.height);
            ctx.globalCompositeOperation = "destination-out";
        }
        ctx.fillStyle = "#fff";
        this.layers.forEach(layer => {
            if (!layer.visible || layer.type !== "mask") return;
            const layerMode = layer.maskMode === "inverse" ? "inverse" : "positive";
            if (layerMode !== maskMode) return;
            ctx.save();
            const cx = layer.x + layer.w / 2;
            const cy = layer.y + layer.h / 2;
            ctx.translate(cx, cy);
            ctx.rotate((layer.rotation || 0) * Math.PI / 180);
            ctx.translate(-cx, -cy);
            if (layer.maskImage || layer.image || layer.eraseStrokes?.length) {
                this.drawLayerAlphaMask(ctx, layer);
                ctx.restore();
                return;
            }
            ctx.fillRect(layer.x, layer.y, layer.w, layer.h);
            ctx.restore();
        });
        ctx.globalCompositeOperation = "source-over";
        return mask;
    }

    drawLayerAlphaMask(ctx, layer) {
        let temp;
        if (layer.eraseStrokes?.length) {
            temp = this.renderLayerSourceCanvas(layer);
            const tctx = temp.getContext("2d");
            tctx.globalCompositeOperation = "source-in";
            tctx.fillStyle = "#fff";
            tctx.fillRect(0, 0, temp.width, temp.height);
            tctx.globalCompositeOperation = "source-over";
        } else {
            temp = document.createElement("canvas");
            temp.width = Math.max(1, Math.round(layer.w));
            temp.height = Math.max(1, Math.round(layer.h));
            const tctx = temp.getContext("2d");
            tctx.fillStyle = "#fff";
            tctx.fillRect(0, 0, temp.width, temp.height);
            const source = layer.maskImage || layer.image;
            if (source) {
                tctx.globalCompositeOperation = "destination-in";
                tctx.drawImage(source, 0, 0, temp.width, temp.height);
                tctx.globalCompositeOperation = "source-over";
            }
        }
        if (layer.type === "paint") ctx.drawImage(temp, 0, 0);
        else ctx.drawImage(temp, layer.x, layer.y, layer.w, layer.h);
    }

    serializeProject() {
        return {
            version: 1,
            editor: "okaypixels-comfy-image-editor",
            inputSignature: this.inputSignature || "",
            width: this.width,
            height: this.height,
            activeLayerId: this.activeLayerId,
            tool: this.tool,
            penMode: this.penMode,
            color: this.color,
            size: this.size,
            opacity: this.opacity,
            eraserHardness: this.eraserHardness,
            rectFill: this.rectFill,
            scaleMode: this.scaleMode,
            layers: this.layers.map(serializeLayerForProject),
            updatedAt: Date.now(),
        };
    }

    setSaving(saving) {
        this.saving = !!saving;
        const btn = this.root?.querySelector('[data-action="save"]');
        if (!btn) return;
        btn.disabled = this.saving;
        btn.classList.toggle("saving", this.saving);
        btn.innerHTML = this.saving ? '<span class="op-ie-spinner"></span><span>保存中</span>' : "✓ 保存";
    }

    async save() {
        if (this.saving) return;
        this.setSaving(true);
        try {
            const canvasToBlob = (canvas, mimeType = "image/png", quality) => new Promise(resolve => {
                if (!canvas?.toBlob) {
                    resolve(null);
                    return;
                }
                canvas.toBlob(resolve, mimeType, quality);
            });
            const blobToBase64 = blob => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
            });
            const imageCanvas = this.exportComposite(true);
            const imageBlob = await canvasToBlob(imageCanvas, this.imageMimeType, this.imageQuality);
            const imageBase64 = this.includeImageBase64
                ? (imageBlob ? await blobToBase64(imageBlob) : imageCanvas.toDataURL(this.imageMimeType, this.imageQuality).split(",")[1])
                : "";
            const hasMaskLayer = this.layers.some(layer => layer.visible && layer.type === "mask" && layer.maskMode !== "inverse");
            const hasInverseMaskLayer = this.layers.some(layer => layer.visible && layer.type === "mask" && layer.maskMode === "inverse");
            const maskCanvas = hasMaskLayer ? this.exportMask(this.alphaMask, "positive") : null;
            const inverseMaskCanvas = hasInverseMaskLayer ? this.exportMask(this.alphaMask, "inverse") : null;
            const maskBlob = maskCanvas ? await canvasToBlob(maskCanvas) : null;
            const inverseMaskBlob = inverseMaskCanvas ? await canvasToBlob(inverseMaskCanvas) : null;
            const maskBase64 = this.includeMaskBase64
                ? (maskBlob ? await blobToBase64(maskBlob) : (maskCanvas ? maskCanvas.toDataURL("image/png").split(",")[1] : ""))
                : "";
            const inverseMaskBase64 = this.includeMaskBase64
                ? (inverseMaskBlob ? await blobToBase64(inverseMaskBlob) : (inverseMaskCanvas ? inverseMaskCanvas.toDataURL("image/png").split(",")[1] : ""))
                : "";
            const project = this.serializeProject();
            await this.onSave?.({ imageBase64, imageBlob, maskBase64, maskBlob, inverseMaskBase64, inverseMaskBlob, width: this.width, height: this.height, project });
            this.close();
        } catch (err) {
            console.error("[OkayPixels] save failed:", err);
            this.setSaving(false);
            const btn = this.root?.querySelector('[data-action="save"]');
            if (btn) {
                const message = err?.message || String(err || "保存失败");
                btn.textContent = "保存失败";
                btn.title = message;
                window.setTimeout(() => {
                    if (!this.root || this.saving) return;
                    btn.textContent = "✓ 保存";
                    btn.title = "";
                }, 3000);
            }
        }
    }
}

window.OkayPixelsComfyImageEditor = {
    async open(options) {
        const editor = new OkayPixelsEditor(options);
        await editor.open();
        return editor;
    }
};
