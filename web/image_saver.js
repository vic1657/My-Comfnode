import { app } from "../../scripts/app.js";

const NODE_CLASS = "MyComfnodeImageSaver";
const OLD_WIDGET_COUNT = 7;
const NEW_WIDGET_COUNT = 8;
const FOLDER_MODES = new Set(["不新建", "自定义名称", "按当天日期(MMDD)"]);

function migrateLegacyWidgetValues(info) {
  const values = info?.widgets_values;
  if (!Array.isArray(values) || values.length !== OLD_WIDGET_COUNT) return;
  if (!(["PNG", "JPG"].includes(values[0]) && FOLDER_MODES.has(values[3]))) return;

  // 新“文件名前缀”插在旧名称控件之后；补空值，避免后续控件整体错位。
  values.splice(2, 0, "");
  if (values.length !== NEW_WIDGET_COUNT) values.length = NEW_WIDGET_COUNT;
}

const EXTENSION_GUARD = "__myComfnodeImageSaverRegisteredV2";

if (!globalThis[EXTENSION_GUARD]) {
  globalThis[EXTENSION_GUARD] = true;
  app.registerExtension({
    name: "MyComfnode.ImageSaver.V2",
    async beforeRegisterNodeDef(nodeType, nodeData) {
      if (nodeData.name !== NODE_CLASS) return;

      const originalConfigured = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function(info) {
        migrateLegacyWidgetValues(info);
        return originalConfigured?.apply(this, arguments);
      };
    },
  });
}
