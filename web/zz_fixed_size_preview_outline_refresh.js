const OUTLINE_PREVIEW_VERSION = "2026-06-15-no-border-preview";

if (window.__mycomfnodeFixedSizeCropPreviewOutlineVersion !== OUTLINE_PREVIEW_VERSION) {
  window.__mycomfnodeFixedSizeCropPreviewOutlineVersion = OUTLINE_PREVIEW_VERSION;
  window.__mycomfnodeFixedSizeCropPreviewRegistered = false;
  import(`./fixed_size_crop_preview.js?v=${OUTLINE_PREVIEW_VERSION}`);
}
