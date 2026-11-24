import "./my_texture.js?v=11";
import "./okaypixels_texture_editor_v2.js?v=10";
import { registerImageMaskBrushExtension } from "./image_mask_brush.js?v=14";

registerImageMaskBrushExtension({
  nodeClass: "MyComfnodeImageMaskBrushV2",
  variant: "v2",
});
