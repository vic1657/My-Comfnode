import { app } from "../../scripts/app.js";

const NODE_CLASS = "MYDisableGroup";
const MENU_LABEL = "加入禁用组";
const DEFAULT_TITLE = "MY禁用组";
const DATA_WIDGET = "group_data";

function isManager(node) {
  return node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS;
}

function isDisableGroup(node) {
  return Boolean(node?.properties?.myDisableGroup);
}

function alwaysMode() {
  return globalThis.LiteGraph?.ALWAYS ?? 0;
}

function neverMode() {
  return globalThis.LiteGraph?.NEVER ?? 2;
}

function hideWidget(node, name) {
  const widget = node.widgets?.find((item) => item?.name === name);
  if (!widget || widget._myDisableHidden) return;
  widget._myDisableHidden = true;
  widget.hidden = true;
  widget.type = "converted-widget";
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  widget.serializeValue = async () => widget.value;
  if (widget.element) widget.element.style.display = "none";
}

function currentGraph() {
  try { return app.graph || app.canvas?.graph; } catch { return null; }
}

function markDirty() {
  const graph = currentGraph();
  graph?.change?.();
  try { app.canvas?.setDirty?.(true, true); } catch {}
}

function disableGroups() {
  return (currentGraph()?._nodes || []).filter(isDisableGroup);
}

function findConvertToSubgraphOption(options) {
  return options.find((option) => {
    const content = String(option?.content || "").toLowerCase();
    return content.includes("转换为子图") || content.includes("convert to subgraph");
  });
}

function refreshManagers() {
  for (const node of currentGraph()?._nodes || []) {
    if (isManager(node)) node._myDisableRender?.();
  }
}

function markCreatedSubgraph(canvas, graph, existingIds) {
  const created = graph?._nodes?.filter((node) => !existingIds.has(node.id) && !isManager(node)) || [];
  const subgraph = created.find((node) => /subgraph/i.test(String(node.type || node.comfyClass || node.constructor?.name || ""))) || created[0];
  if (!subgraph) return false;

  subgraph.properties ||= {};
  subgraph.properties.myDisableGroup = true;
  subgraph.properties.myDisableSavedMode = subgraph.mode ?? alwaysMode();
  subgraph.title = DEFAULT_TITLE;
  graph.change?.();
  canvas.setDirty?.(true, true);
  refreshManagers();
  return true;
}

function installNodeMenu() {
  let CanvasClass;
  try { CanvasClass = globalThis.LGraphCanvas || app.canvas?.constructor; } catch {}
  if (!CanvasClass?.prototype) {
    setTimeout(installNodeMenu, 250);
    return;
  }
  if (CanvasClass.prototype._myDisableGroupMenuInstalled) return;
  CanvasClass.prototype._myDisableGroupMenuInstalled = true;

  const originalGetNodeMenuOptions = CanvasClass.prototype.getNodeMenuOptions;
  CanvasClass.prototype.getNodeMenuOptions = function (node) {
    const options = originalGetNodeMenuOptions?.apply(this, arguments) || [];
    if (!node || isManager(node) || !this.selected_nodes?.[node.id]) return options;

    const nativeOption = findConvertToSubgraphOption(options);
    options.unshift({
      content: MENU_LABEL,
      disabled: !nativeOption?.callback,
      callback: (...args) => {
        if (!nativeOption?.callback) return;
        const graph = this.graph;
        const existingIds = new Set(graph?._nodes?.map((item) => item.id));
        nativeOption.callback.apply(this, args);
        let attempts = 0;
        const finish = () => {
          if (markCreatedSubgraph(this, graph, existingIds) || attempts++ >= 20) return;
          setTimeout(finish, 50);
        };
        queueMicrotask(finish);
      },
    });
    return options;
  };
}

function setGroupEnabled(group, enabled) {
  group.properties ||= {};
  if (enabled) {
    const saved = Number(group.properties.myDisableSavedMode);
    group.mode = Number.isFinite(saved) ? saved : alwaysMode();
  } else {
    if (group.mode !== neverMode()) group.properties.myDisableSavedMode = group.mode;
    group.mode = neverMode();
  }
}

function buildManager(node) {
  hideWidget(node, DATA_WIDGET);
  if (node._myDisablePanel) return;
  node.properties ||= {};
  node.properties.myDisableSelectionMode ||= "single";

  const panel = document.createElement("div");
  panel.className = "my-disable-panel";
  node._myDisablePanel = panel;
  node.addDOMWidget("my_disable_panel", "customwidget", panel, {
    getValue: () => JSON.stringify(disableGroups().map((group) => ({
      id: group.id, title: group.title, enabled: group.mode !== neverMode(),
    }))),
    setValue: () => {},
  });

  node._myDisableRender = () => {
    const groups = disableGroups();
    const signature = JSON.stringify(groups.map((group) => [group.id, group.title, group.mode]));
    if (signature === node._myDisableSignature && panel.childElementCount) return;
    node._myDisableSignature = signature;
    panel.replaceChildren();

    const modeRow = document.createElement("label");
    modeRow.className = "my-disable-mode";
    modeRow.textContent = "选择模式";
    const select = document.createElement("select");
    select.innerHTML = "<option value='single'>单选</option><option value='multi'>多选</option>";
    select.value = node.properties.myDisableSelectionMode;
    select.onchange = () => {
      node.properties.myDisableSelectionMode = select.value;
      if (select.value === "single") {
        const enabled = groups.filter((group) => group.mode !== neverMode());
        enabled.slice(1).forEach((group) => setGroupEnabled(group, false));
      }
      node._myDisableSignature = "";
      node._myDisableRender();
      markDirty();
    };
    modeRow.append(select);
    panel.append(modeRow);

    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "my-disable-empty";
      empty.textContent = "多选节点后，在已选节点上右键 → 加入禁用组";
      panel.append(empty);
    }

    for (const group of groups) {
      const row = document.createElement("div");
      row.className = "my-disable-row";
      const name = document.createElement("span");
      name.className = "my-disable-name";
      name.textContent = group.title || DEFAULT_TITLE;
      name.title = "双击画布中的子图节点标题可改名";
      const toggle = document.createElement("button");
      const enabled = group.mode !== neverMode();
      toggle.className = `my-disable-toggle ${enabled ? "is-on" : "is-off"}`;
      toggle.textContent = enabled ? "开" : "关";
      toggle.onclick = () => {
        const turnOn = group.mode === neverMode();
        if (turnOn && node.properties.myDisableSelectionMode === "single") {
          groups.filter((item) => item !== group).forEach((item) => setGroupEnabled(item, false));
        }
        setGroupEnabled(group, turnOn);
        node._myDisableSignature = "";
        node._myDisableRender();
        markDirty();
      };
      row.append(name, toggle);
      panel.append(row);
    }

    node.setSize([310, Math.max(120, 70 + groups.length * 34)]);
    const widget = node.widgets?.find((item) => item.name === DATA_WIDGET);
    if (widget) widget.value = JSON.stringify(groups.map((group) => ({ id: group.id, title: group.title })));
  };

  node._myDisableTimer = setInterval(() => node._myDisableRender?.(), 500);
  const originalRemoved = node.onRemoved;
  node.onRemoved = function () {
    clearInterval(this._myDisableTimer);
    return originalRemoved?.apply(this, arguments);
  };
  node._myDisableRender();
}

function injectStyles() {
  if (document.getElementById("my-disable-group-style")) return;
  const style = document.createElement("style");
  style.id = "my-disable-group-style";
  style.textContent = `
    .my-disable-panel{min-width:260px;color:#dde2ea;font:12px sans-serif}
    .my-disable-mode{display:flex;align-items:center;gap:8px;margin:2px 0 8px}
    .my-disable-mode select{flex:1;background:#292d35;color:#eee;border:1px solid #4b5260;border-radius:6px;padding:4px}
    .my-disable-row{display:grid;grid-template-columns:minmax(0,1fr) 36px;gap:8px;align-items:center;margin:5px 0}
    .my-disable-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#252931;border:1px solid #454c58;border-radius:6px;padding:5px 7px}
    .my-disable-toggle{border:1px solid #5a616e;border-radius:12px;padding:3px 0;color:#fff;cursor:pointer}
    .my-disable-toggle.is-on{background:#28603e;border-color:#55a56e}
    .my-disable-toggle.is-off{background:#4a3034;border-color:#8a555e;color:#d5bbc0}
    .my-disable-empty{border:1px dashed #555e6d;border-radius:7px;padding:10px;color:#9da8b8;line-height:1.45}
  `;
  document.head.append(style);
}

app.registerExtension({
  name: "MyComfnode.DisableGroupSubgraph",
  setup() {
    injectStyles();
    installNodeMenu();
  },
  nodeCreated(node) {
    if (isManager(node)) buildManager(node);
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = originalCreated?.apply(this, arguments);
      buildManager(this);
      return result;
    };
    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigure?.apply(this, arguments);
      buildManager(this);
      this._myDisableSignature = "";
      this._myDisableRender?.();
      return result;
    };
  },
});
