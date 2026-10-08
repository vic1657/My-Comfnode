# My-Comfnode

一套面向人像精修 / 打光 / 抠图 / 绿幕抠像 / AI 换装工作流的 ComfyUI 自定义节点合集，全部节点界面与输入输出均为中文。

## 安装

### 方式一：ComfyUI-Manager（推荐）

1. 将本仓库下载或 `git clone` 到 `ComfyUI/custom_nodes/` 目录下：
   ```
   cd ComfyUI/custom_nodes
   git clone https://github.com/<你的用户名>/My-Comfnode.git
   ```
2. 重启 ComfyUI，ComfyUI-Manager 会自动读取 `requirements.txt` 并安装依赖。
   如果没有自动安装，在 Manager 里点「安装缺失依赖」即可。

### 方式二：手动安装

1. 下载仓库压缩包并解压到 `ComfyUI/custom_nodes/My-Comfnode`（解压后请确保 `__init__.py` 直接位于该目录下）。
2. 双击运行插件目录里的 `install.bat`（便携版会自动使用 `python_embeded`），或手动执行：
   ```
   python_embeded\python.exe -m pip install -r custom_nodes\My-Comfnode\requirements.txt
   ```
3. 重启 ComfyUI。

### 依赖说明

ComfyUI 本身已带 `torch`、`torchvision`、`numpy`、`pillow` 等，本插件额外需要：

| 依赖 | 用途 | 引入时机 |
|---|---|---|
| opencv-python | 图像对齐、抠像、纹理处理 | 启动即需要 |
| einops / timm | BEN2 模型结构 | 启动即需要 |
| transformers | ViTMatte / BiRefNet / SegFormer 抠图 | 使用对应节点时加载 |
| mediapipe | 精细抠图（matte refine） | 使用对应节点时加载 |
| rembg / pymatting | 通用抠图与前景提取 | 使用对应节点时加载 |
| transparent-background | InSPyReNet 透明背景抠图 | 使用对应节点时加载 |
| scipy / huggingface_hub | 深度差分遮罩 / 模型下载 | 使用对应节点时加载 |

## 节点说明

### My原色保光

独立的逐像素颜色恢复节点。请先在工作流中将原图与 AI 打光图对齐，再连接到本节点。打光图是最终底片，其亮度、阴影、对比度、纹理、清晰度和输出尺寸全部保持不变；原图只提供颜色，不参与细节或光照重建。

节点提供 `color_restore_strength` 和 `color_saturation` 两个滑块。前者控制使用多少原图颜色，后者控制颜色浓度；两者都不调整打光图亮度。超出 RGB 色域的强高光只压缩色度，不压缩亮度。

### My细节光影保留

用于原图与 AI 打光图已由前置节点对齐后的细节恢复。打光图始终是最终底片，节点只从原图迁移缺失的亮度微纹理，不迁移原图颜色、低频明暗或结构轮廓。

节点会自动判断两图局部结构是否一致，并保护新生成的轮廓光、投影边缘、人物外轮廓和错位区域。仅需调节 `detail_restore_strength`；可选的 `detail_restore_mask` 输入中，白色区域恢复细节、黑色区域保持打光图、灰色区域按比例过渡。

### My光影高保真细节还原

独立的原图底片版本。输出的五官、肤色、发丝、衣料、背景纹理、尺寸和透明通道全部来自原图。打光图经过双向光流对齐后只用于提取低频明暗、严格平滑并限幅的光色，以及可信的新高光和阴影边界。

`detail_restore_strength` 为 `0` 时逐像素返回原图，为 `1` 时在原图质量上应用完整光影。

### My保存JPG

将 IMAGE 输出保存为 JPEG。默认品质为 `95`、色度采样为 `4:4:4`，用于在保留细节和颜色的同时显著降低全分辨率成片体积；透明区域会在白色背景上合成。

### My光的救赎

使用原图作为最终高分辨率底片，从较低分辨率的 AI 打光图中反求多尺度曝光、硬光边界和光色，再在原图像素上重建光照。默认参数适合先直接使用，局部杂边可提高 `杂边抑制`，弱光缺失可提高 `光影细节` 或 `闭环校准`。

### Nano banana2 API

标准工作流节点。左侧提供 `图像1` 到 `图像14` 共 14 个可选参考图输入口；点击 ComfyUI 顶部运行后调用接口，并从右侧输出 `生成图片`、`任务状态` 和 `任务ID`。支持默认、0.5K、1K、2K、4K 分辨率以及自动和常用宽高比。

### 遮罩先后判断

提供自动增长的遮罩输入接口。默认显示 `mask0`，连接当前最后一个接口后会自动出现下一个，最多支持 50 个。节点按数字顺序选择第一个包含实际白色区域的遮罩。未连接的动态接口和空白遮罩不会报错。

### 图像遮罩画笔

保留常用加载图像节点的图片选择、上传、`IMAGE` 和 `MASK` 输出，并允许直接在节点预览图上绘制遮罩。每次落笔后遮罩会自动保存到 ComfyUI 输入目录的 `my-mask-brush` 子目录，重新打开工作流时会恢复已经绘制的遮罩。

### My自定义光源渲染

保留 Sphere Light Render 的球体、地面与实时阴影组件，全部控制放在预览下方，拖动过程中逐帧更新。输出 1024 x 1024 的 `渲染图`，并通过独立的 `颜色信息` 字符串输出标准 `rgba(r, g, b, a)` 文本。

### My Paint Tool（My画笔工具）

集成画布绘制节点，输出：

- `painted_image`
- `mask`
- `preview`

### Fixed Size Image Nodes

固定尺寸裁切、固定尺寸补边、背景边缘裁切等节点，位于 `My-Comfnode/图像` 分类下。

### 其他节点

另含绿幕溢色去除、色度键抠像（含预览）、服装差异遮罩、深度差分遮罩、雾效遮罩、元素分离遮罩、阴影材质重建、顺序队列、批次排序、视频帧处理、3D 参考图（Three.js 预览）等节点，可在节点搜索中以 `My` 前缀快速查找。

## 目录结构

```
My-Comfnode/
├── __init__.py        # 节点加载入口
├── *.py               # 各节点实现
├── web/               # 前端 JS（预览、画笔、3D 查看器等）
├── tests/             # 单元测试
├── requirements.txt   # 依赖清单
├── install.bat        # Windows 一键安装依赖
└── pyproject.toml
```

## License

MIT
