import { app } from "../../scripts/app.js";
import "../../scripts/domWidget.js";

const NODE_CLASS = "MyComfnodeThreeDReferenceNode";
const DATA_WIDGET = "render_image_data";
const MODEL_WIDGET = "model_file";
const WIDTH_WIDGET = "width";
const HEIGHT_WIDGET = "height";
const BG_WIDGET = "background";
const ROTATION_WIDGET = "rotation";
const ELEVATION_WIDGET = "elevation";
const INTENSITY_WIDGET = "intensity";
const SHADOW_WIDGET = "shadow_opacity";
const CONFIG_WIDGETS = [
  MODEL_WIDGET,
  WIDTH_WIDGET,
  HEIGHT_WIDGET,
  BG_WIDGET,
  ROTATION_WIDGET,
  ELEVATION_WIDGET,
  INTENSITY_WIDGET,
  SHADOW_WIDGET,
];
const VIEWER_HEIGHT = 430;

const VIEWER_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      background: #101114;
      height: 100%;
      margin: 0;
      overflow: hidden;
      width: 100%;
    }
    body {
      font-family: Arial, "Microsoft YaHei", sans-serif;
    }
    #root {
      background: #15161a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      box-sizing: border-box;
      height: 100%;
      overflow: hidden;
      position: relative;
      width: 100%;
    }
    canvas {
      display: block;
      height: 100%;
      width: 100%;
    }
    #bar {
      align-items: center;
      display: flex;
      gap: 8px;
      left: 8px;
      pointer-events: none;
      position: absolute;
      right: 8px;
      top: 8px;
    }
    #status {
      background: rgba(15, 16, 20, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.13);
      border-radius: 5px;
      color: rgba(255, 255, 255, 0.84);
      flex: 1;
      font-size: 12px;
      min-width: 0;
      overflow: hidden;
      padding: 5px 8px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    button {
      background: rgba(34, 38, 46, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 5px;
      color: rgba(255, 255, 255, 0.9);
      cursor: pointer;
      flex: 0 0 auto;
      font-size: 12px;
      height: 28px;
      padding: 0 10px;
      pointer-events: auto;
    }
    button:hover {
      background: rgba(52, 58, 70, 0.96);
    }
    #error {
      align-items: center;
      background: rgba(16, 17, 20, 0.92);
      color: #f3b8b8;
      display: none;
      inset: 0;
      justify-content: center;
      padding: 20px;
      position: absolute;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="root">
    <canvas id="view"></canvas>
    <div id="bar">
      <div id="status">loading</div>
      <button id="fit">适配</button>
      <button id="reset">重置</button>
    </div>
    <div id="error"></div>
  </div>
  <script type="module">
    import * as THREE from "/extensions/My-Comfnode/vendor/three/three.module.js";
    import { OrbitControls } from "/extensions/My-Comfnode/vendor/three/OrbitControls.js";
  </script>
</body>
</html>`;

const VIEWER_HTML_FIXED = VIEWER_HTML.replace("</script>", `
    import { GLTFLoader } from "/extensions/My-Comfnode/vendor/three/loaders/GLTFLoader.js";

    const canvas = document.getElementById("view");
    const root = document.getElementById("root");
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");
    const fitBtn = document.getElementById("fit");
    const resetBtn = document.getElementById("reset");

    const state = {
      model: null,
      modelUrl: "",
      modelName: "",
      background: "#ffffff",
      width: 1024,
      height: 1024,
      bounds: null,
      lastCamera: null,
      captureTimer: null,
    };

    window.addEventListener("error", (event) => {
      const text = event?.message || "viewer script error";
      const el = document.getElementById("error");
      const st = document.getElementById("status");
      if (st) st.textContent = "error";
      if (el) {
        el.textContent = text;
        el.style.display = "flex";
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      const text = event?.reason?.message || String(event?.reason || "viewer promise error");
      const el = document.getElementById("error");
      const st = document.getElementById("status");
      if (st) st.textContent = "error";
      if (el) {
        el.textContent = text;
        el.style.display = "flex";
      }
    });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 500);
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      canvas,
      preserveDrawingBuffer: true,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0xffffff, 1);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.2;
    controls.maxDistance = 80;

    const ambient = new THREE.HemisphereLight(0xffffff, 0x404040, 2.4);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xffffff, 1.4);
    fill.position.set(-5, 3, -4);
    scene.add(fill);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.18 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.visible = true;
    scene.add(ground);

    const loader = new GLTFLoader();

    function setStatus(text) {
      statusEl.textContent = text || "";
    }

    function showError(text) {
      errorEl.textContent = text || "";
      errorEl.style.display = text ? "flex" : "none";
    }

    function setBackground(hex) {
      state.background = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#ffffff";
      const color = new THREE.Color(state.background);
      scene.background = color;
      renderer.setClearColor(color, 1);
    }

    function disposeObject(object) {
      object?.traverse?.((child) => {
        if (child.geometry) child.geometry.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if (!material) continue;
          for (const value of Object.values(material)) {
            if (value?.isTexture) value.dispose?.();
          }
          material.dispose?.();
        }
      });
    }

    function fitCamera(resetAzimuth = true) {
      if (!state.model) return;
      const box = new THREE.Box3().setFromObject(state.model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.01);
      const distance = maxDim / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.55;

      controls.target.copy(center);
      if (resetAzimuth) {
        camera.position.set(center.x + distance * 0.78, center.y + distance * 0.42, center.z + distance * 0.88);
      } else {
        const dir = camera.position.clone().sub(controls.target).normalize();
        if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.001) dir.set(0.7, 0.35, 0.8).normalize();
        camera.position.copy(center).add(dir.multiplyScalar(distance));
      }
      camera.near = Math.max(0.001, distance / 100);
      camera.far = Math.max(100, distance * 100);
      camera.updateProjectionMatrix();
      controls.update();
      updateGround(box);
      renderOnce();
      queueCapture();
    }

    function updateGround(box) {
      if (!box || !Number.isFinite(box.min.y)) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      ground.position.set(center.x, box.min.y - Math.max(size.y, 0.01) * 0.012, center.z);
    }

    function normalizeModel(object) {
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.01);
      const scale = 3.4 / maxDim;
      object.position.sub(center).multiplyScalar(scale);
      object.scale.multiplyScalar(scale);
      object.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (child.material) {
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            for (const material of materials) {
              material.side = material.side ?? THREE.FrontSide;
              material.needsUpdate = true;
            }
          }
        }
      });
    }

    function loadModel(model) {
      if (!model?.url) {
        setStatus("no model");
        return;
      }
      if (model.url === state.modelUrl) {
        queueCapture();
        return;
      }
      state.modelUrl = model.url;
      state.modelName = model.relative || model.name || "";
      setStatus("loading " + state.modelName);
      showError("");

      loader.load(
        model.url,
        (gltf) => {
          if (state.model) {
            scene.remove(state.model);
            disposeObject(state.model);
          }
          state.model = gltf.scene || gltf.scenes?.[0];
          if (!state.model) {
            showError("model has no scene");
            return;
          }
          normalizeModel(state.model);
          scene.add(state.model);
          const box = new THREE.Box3().setFromObject(state.model);
          state.bounds = box;
          setStatus(state.modelName);
          fitCamera(true);
        },
        undefined,
        (err) => {
          console.error("[3DReference] model load failed", err);
          showError("load failed: " + state.modelName);
          setStatus("load failed");
        }
      );
    }

    function resizeToDisplay() {
      const rect = root.getBoundingClientRect();
      const width = Math.max(16, Math.floor(rect.width));
      const height = Math.max(16, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderOnce();
    }

    function renderOnce() {
      renderer.render(scene, camera);
    }

    function cameraInfo() {
      const target = controls.target.clone();
      const position = camera.position.clone();
      const rel = position.clone().sub(target);
      const distance = rel.length();
      const azimuth = THREE.MathUtils.radToDeg(Math.atan2(rel.x, rel.z));
      const elevation = distance > 0 ? THREE.MathUtils.radToDeg(Math.asin(rel.y / distance)) : 0;
      return {
        position: [position.x, position.y, position.z].map((v) => Number(v.toFixed(5))),
        target: [target.x, target.y, target.z].map((v) => Number(v.toFixed(5))),
        azimuth: Number(azimuth.toFixed(3)),
        elevation: Number(elevation.toFixed(3)),
        distance: Number(distance.toFixed(5)),
        fov: camera.fov,
      };
    }

    function capture(width = state.width, height = state.height) {
      const rect = root.getBoundingClientRect();
      const oldWidth = Math.max(16, Math.floor(rect.width));
      const oldHeight = Math.max(16, Math.floor(rect.height));
      const outWidth = Math.max(16, Math.min(4096, Math.floor(width || state.width || 1024)));
      const outHeight = Math.max(16, Math.min(4096, Math.floor(height || state.height || 1024)));

      renderer.setSize(outWidth, outHeight, false);
      camera.aspect = outWidth / outHeight;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const image = renderer.domElement.toDataURL("image/png");

      renderer.setSize(oldWidth, oldHeight, false);
      camera.aspect = oldWidth / oldHeight;
      camera.updateProjectionMatrix();
      renderOnce();

      return {
        image,
        camera: cameraInfo(),
        target: controls.target.toArray().map((v) => Number(v.toFixed(5))),
        width: outWidth,
        height: outHeight,
        model_file: state.modelName,
      };
    }

    function queueCapture() {
      clearTimeout(state.captureTimer);
      state.captureTimer = setTimeout(() => {
        try {
          parent.postMessage({ type: "MYCOMFNODE_3D_CAPTURE_UPDATE", payload: capture() }, "*");
        } catch (err) {
          console.warn("[3DReference] capture update failed", err);
        }
      }, 180);
    }

    controls.addEventListener("change", () => {
      renderOnce();
      queueCapture();
    });
    fitBtn.addEventListener("click", () => fitCamera(false));
    resetBtn.addEventListener("click", () => fitCamera(true));
    window.addEventListener("resize", resizeToDisplay);
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());

    function applyConfig(config) {
      state.width = config.width || state.width;
      state.height = config.height || state.height;
      setBackground(config.background || state.background);
      if (config.model) loadModel(config.model);
      resizeToDisplay();
    }

    window.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "MYCOMFNODE_3D_INIT" || data.type === "MYCOMFNODE_3D_CONFIG") {
        applyConfig(data.config || {});
      } else if (data.type === "MYCOMFNODE_3D_CAPTURE") {
        const config = data.config || {};
        state.width = config.width || state.width;
        state.height = config.height || state.height;
        setBackground(config.background || state.background);
        const payload = capture(state.width, state.height);
        parent.postMessage({ type: "MYCOMFNODE_3D_CAPTURE_RESULT", requestId: data.requestId, payload }, "*");
      }
    });

    setBackground(state.background);
    resizeToDisplay();
    camera.position.set(3.6, 2.4, 4.2);
    controls.target.set(0, 0, 0);
    controls.update();
    renderOnce();
    setStatus("ready");
    parent.postMessage({ type: "MYCOMFNODE_3D_READY" }, "*");
  </script>`);

function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

function numberWidget(node, name, fallback) {
  const value = Number(findWidget(node, name)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function textWidget(node, name, fallback = "") {
  const value = findWidget(node, name)?.value;
  return typeof value === "string" && value ? value : fallback;
}

function setHiddenWidget(node, name) {
  const widget = findWidget(node, name);
  if (!widget) return;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  if (widget.options) widget.options.hidden = true;
}

function ensureStore() {
  if (!window.__mycomfnode3dReference) {
    window.__mycomfnode3dReference = {
      models: null,
      loading: null,
      nodes: new Map(),
    };
  }
  return window.__mycomfnode3dReference;
}

async function fetchModels() {
  const store = ensureStore();
  if (store.models) return store.models;
  if (!store.loading) {
    store.loading = fetch("/my_comfnode/3d_reference/models")
      .then((response) => response.ok ? response.json() : { models: [] })
      .then((data) => {
        store.models = Array.isArray(data.models) ? data.models : [];
        return store.models;
      })
      .catch((err) => {
        console.warn("[3DReference] model list failed", err);
        store.models = [];
        return store.models;
      });
  }
  return store.loading;
}

function modelForNode(node, models) {
  const selected = textWidget(node, MODEL_WIDGET, "");
  return models.find((model) => model.relative === selected) || models[0] || null;
}

function configForNode(node) {
  const store = ensureStore();
  const models = store.models || [];
  return {
    model: modelForNode(node, models),
    width: numberWidget(node, WIDTH_WIDGET, 1024),
    height: numberWidget(node, HEIGHT_WIDGET, 1024),
    background: textWidget(node, BG_WIDGET, "#ffffff"),
    rotation: numberWidget(node, ROTATION_WIDGET, -108),
    elevation: numberWidget(node, ELEVATION_WIDGET, 47),
    intensity: numberWidget(node, INTENSITY_WIDGET, 2.6),
    shadow_opacity: numberWidget(node, SHADOW_WIDGET, 0.18),
  };
}

function setPayload(node, payload) {
  if (!node || !payload?.image) return "";
  const fullPayload = {
    ...payload,
    model_file: textWidget(node, MODEL_WIDGET, payload.model_file || ""),
  };
  const value = JSON.stringify(fullPayload);
  const widget = findWidget(node, DATA_WIDGET);
  if (widget) widget.value = value;
  node.properties = node.properties || {};
  node.properties.threeDReferenceCamera = fullPayload.camera || null;
  node.properties.threeDReferenceLighting = {
    rotation: fullPayload.rotation,
    elevation: fullPayload.elevation,
    intensity: fullPayload.intensity,
    shadow_opacity: fullPayload.shadow_opacity,
  };
  node._threeDReferenceLastPayload = value;
  return value;
}

function postConfig(node) {
  if (!node?._threeDReferenceIframe?.contentWindow) return;
  node._threeDReferenceIframe.contentWindow.postMessage({
    type: "MYCOMFNODE_3D_CONFIG",
    config: configForNode(node),
  }, "*");
}

function requestCapture(node, timeoutMs = 1600) {
  return new Promise((resolve) => {
    const iframe = node?._threeDReferenceIframe;
    if (!iframe?.contentWindow) {
      resolve(findWidget(node, DATA_WIDGET)?.value || "");
      return;
    }

    const requestId = `${node.id || "node"}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(value || findWidget(node, DATA_WIDGET)?.value || "");
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data || {};
      if (data.type !== "MYCOMFNODE_3D_CAPTURE_RESULT" || data.requestId !== requestId) return;
      finish(setPayload(node, data.payload));
    };

    window.addEventListener("message", onMessage);
    iframe.contentWindow.postMessage({
      type: "MYCOMFNODE_3D_CAPTURE",
      requestId,
      config: configForNode(node),
    }, "*");
    setTimeout(() => finish(""), timeoutMs);
  });
}

function patchPromptFetch() {
  if (window.__mycomfnode3dReferenceFetchPatched) return;
  window.__mycomfnode3dReferenceFetchPatched = true;
  const originalFetch = window.fetch?.bind(window);
  if (!originalFetch) return;

  window.fetch = async function(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (typeof url === "string" && url.includes("/api/prompt") && typeof init?.body === "string") {
        const payload = JSON.parse(init.body);
        const prompt = payload?.prompt || payload?.workflow?.prompt;
        if (prompt && typeof prompt === "object") {
          const captures = [];
          for (const [nodeId, def] of Object.entries(prompt)) {
            if (def?.class_type !== NODE_CLASS || !def.inputs) continue;
            const graphNode = app.graph?.getNodeById?.(Number(nodeId));
            if (graphNode) {
              captures.push(
                requestCapture(graphNode).then((value) => {
                  if (value) def.inputs[DATA_WIDGET] = value;
                })
              );
            }
          }
          if (captures.length) {
            await Promise.all(captures);
            init = { ...init, body: JSON.stringify(payload) };
          }
        }
      }
    } catch (err) {
      console.warn("[3DReference] prompt capture failed", err);
    }
    return originalFetch(input, init);
  };
}

function wrapWidgetCallbacks(node) {
  for (const name of CONFIG_WIDGETS) {
    const widget = findWidget(node, name);
    if (!widget || widget._threeDReferenceWrapped) continue;
    const original = widget.callback;
    widget.callback = function(...args) {
      const result = original?.apply?.(this, args);
      setTimeout(() => postConfig(node), 0);
      return result;
    };
    widget._threeDReferenceWrapped = true;
  }
}

async function initNode(node) {
  if (!node || node._threeDReferenceReady) return;
  node._threeDReferenceReady = true;
  node.title = node.title === NODE_CLASS ? "3D多视角参考" : node.title;
  setHiddenWidget(node, DATA_WIDGET);
  wrapWidgetCallbacks(node);
  patchPromptFetch();

  const iframe = document.createElement("iframe");
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.style.borderRadius = "8px";
  iframe.style.display = "block";
  iframe.style.background = "#15161a";
  iframe.setAttribute("title", "3D reference viewer");
  iframe.src = `/extensions/My-Comfnode/three_d_reference_viewer.html?v=${Date.now()}`;
  iframe.addEventListener("load", () => {
    setTimeout(() => postConfig(node), 0);
    setTimeout(() => postConfig(node), 250);
  });
  node._threeDReferenceIframe = iframe;

  const widget = node.addDOMWidget("viewer", "MYCOMFNODE_3D_VIEW", iframe, {
    serialize: false,
    getValue() {
      return "";
    },
    setValue() {},
  });
  widget.serialize = false;
  widget.computeSize = function(width) {
    return [width || 420, VIEWER_HEIGHT];
  };

  node.setSize?.([Math.max(node.size?.[0] || 420, 500), Math.max(node.size?.[1] || 520, 740)]);

  const onMessage = (event) => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data || {};
    if (data.type === "MYCOMFNODE_3D_READY") {
      postConfig(node);
    } else if (data.type === "MYCOMFNODE_3D_CAPTURE_UPDATE") {
      setPayload(node, data.payload);
    }
  };
  window.addEventListener("message", onMessage);

  const originalRemoved = node.onRemoved;
  node.onRemoved = function() {
    window.removeEventListener("message", onMessage);
    originalRemoved?.apply?.(this, arguments);
  };

  await fetchModels();
  postConfig(node);
  setTimeout(() => postConfig(node), 500);
  setTimeout(() => postConfig(node), 1200);
}

app.registerExtension({
  name: "MyComfnode.ThreeDReference",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
      const result = originalCreated?.apply?.(this, arguments);
      initNode(this);
      return result;
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function() {
      const result = originalConfigured?.apply?.(this, arguments);
      setTimeout(() => initNode(this), 0);
      return result;
    };
  },
});
