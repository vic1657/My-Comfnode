import { app } from "/scripts/app.js";


const TYPE = "MY_LIGHT_COLOR";
const DEFAULT_COLOR = "#FFFFFF";
const HEX_COLOR = /^#[0-9A-F]{6}$/i;


function normalizeColor(value) {
  const candidate = String(value ?? "").trim().toUpperCase();
  return HEX_COLOR.test(candidate) ? candidate : DEFAULT_COLOR;
}


function contrastColor(hex) {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.55 ? "#171717" : "#FFFFFF";
}


function createColorWidget(node, inputName, inputData) {
  const widget = {
    name: inputName,
    type: TYPE,
    value: normalizeColor(inputData?.[1]?.default),
    options: inputData?.[1] ?? {},

    computeSize(width) {
      return [width, 32];
    },

    draw(ctx, currentNode, width, y, height) {
      const liteGraph = globalThis.LiteGraph;
      const margin = 10;
      const x = margin;
      const widgetWidth = width - margin * 2;
      const widgetHeight = Math.min(28, height - 2);
      const top = y + (height - widgetHeight) / 2;
      const radius = 6;

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, top, widgetWidth, widgetHeight, radius);
      ctx.fillStyle = liteGraph?.WIDGET_BGCOLOR ?? "#303030";
      ctx.fill();
      ctx.strokeStyle = liteGraph?.WIDGET_OUTLINE_COLOR ?? "#666666";
      ctx.lineWidth = 1;
      ctx.stroke();

      const swatchSize = 20;
      const swatchX = x + 4;
      const swatchY = top + (widgetHeight - swatchSize) / 2;
      ctx.beginPath();
      ctx.roundRect(swatchX, swatchY, swatchSize, swatchSize, 4);
      ctx.fillStyle = this.value;
      ctx.fill();
      ctx.strokeStyle = contrastColor(this.value) === "#171717" ? "#777777" : "#D0D0D0";
      ctx.stroke();

      ctx.fillStyle = liteGraph?.WIDGET_TEXT_COLOR ?? "#E5E5E5";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("光影颜色", swatchX + swatchSize + 8, top + widgetHeight / 2);
      ctx.textAlign = "right";
      ctx.fillText(this.value, x + widgetWidth - 8, top + widgetHeight / 2);
      ctx.restore();
    },

    mouse(event, position) {
      if (event.type !== "pointerdown") return false;
      const picker = document.createElement("input");
      picker.type = "color";
      picker.value = normalizeColor(this.value);
      picker.setAttribute("aria-label", "光影颜色");
      Object.assign(picker.style, {
        position: "fixed",
        left: "-10000px",
        top: "-10000px",
        width: "1px",
        height: "1px",
      });
      document.body.appendChild(picker);

      const update = () => {
        const nextValue = normalizeColor(picker.value);
        if (nextValue === this.value) return;
        this.value = nextValue;
        this.callback?.(nextValue, app.canvas, node, position, event);
        if (node.graph) node.graph._version = (node.graph._version ?? 0) + 1;
        node.setDirtyCanvas(true, true);
      };
      const remove = () => picker.remove();
      picker.addEventListener("input", update);
      picker.addEventListener("change", () => {
        update();
        remove();
      });
      picker.addEventListener("blur", () => window.setTimeout(remove, 0), { once: true });
      picker.click();
      return true;
    },
  };
  return widget;
}


app.registerExtension({
  name: "MyComfnode.MyLighting",
  getCustomWidgets() {
    return {
      [TYPE](node, inputName, inputData) {
        return {
          widget: node.addCustomWidget(createColorWidget(node, inputName, inputData)),
          minWidth: 190,
          minHeight: 32,
        };
      },
    };
  },
});
