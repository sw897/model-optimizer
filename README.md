# Model Optimizer


- `model-lod-worker`：读取 lod-input 的 `_build` 构建资料，用 glTF-Transform + MeshoptSimplifier 生成组件 LOD。
- `model-opt-worker`：读取标准 `tileset.json` 资源图，用 Meshopt 无损缓冲压缩和 BasisU/KTX2 优化网络与 GPU 资源。

## 安装与打包

```bash
npm ci
npm run build
npm test
npm run package
```

发行包包含 dist、协议 schema、README 和锁定工具链。安装包后通过两个 bin 命令运行；源码目录可用 `node dist/cli.js` 与 `node dist/opt-cli.js`。

## 基础模型无需 LOD

```bash
model-opt-worker --input ./line-a-build --output ./line-a-web
```


## 构建 LOD

```bash
model-lod-worker --input ./line-a-build --output ./line-a-lod --preset tower-v1 --max-level 2
model-opt-worker --input ./line-a-published --output ./line-a-web
```

`--max-level 0` 仅校验基础资产。默认一级候选；可用 tower-v1、span-v1、base-only preset。每个级别从基础 GLB 独立化简。同一原型遇到质量失败后停止后续级别，仅保留连续成功前缀；首级失败则保持 base-only，其他原型不受影响。线/点图元保持 base-only，不创建原文件复制品作为 LOD。


```text
_build/assets/prototypes/<物理来源>/<模型>.glb
_build/assets/prototypes/<物理来源>/<模型>/lod1.glb
_build/assets/prototypes/<物理来源>/<模型>/lod2.glb
lod-manifest.json
lod-worker-report.json
toolchain.lock.json
```

## 阶段 1 / 2 契约

`_build/build-manifest.json` 使用 `model-optimizer.lod-input` v1：

```json
{
  "schema": "model-optimizer.lod-input",
  "version": 1,
  "sceneId": "line-a",
  "sourceHash": "<source hash>",
  "prototypeManifest": "_build/prototypes.json",
  "instanceManifest": "_build/instances.jsonl",
  "objectIndex": "objects/index.json",
  "layout": "_build/spatial-layout.json",
  "files": [{"path": "tileset.json", "sha256": "<sha256>"}]
}
```

全部路径相对输入根。files 覆盖公开运行资源、构建清单、基础 GLB；不包含 build-manifest 自身及非权威报告。worker 验证资源闭包与每个文件 hash，拒绝路径逃逸和外部 symlink。

prototype 数组保留 prototypeId、prototypeKey、name、assetKey、sourcePath、role；assetPath 为 `_build/assets/prototypes/<assetKey>`，baseGLB 为同名 `.glb`，初始 lods 为空。

阶段 2 输出 `model-optimizer.lod-manifest` v3，使用 baseBuildManifestHash、basePrototypeManifestHash、sceneId 绑定输入；每个原型含 status、可选 reason、baseSha256 和真实 lods。LOD 包含路径、SHA-256、来源 SHA-256、算法/工具版本及米制误差。schema 见 schemas/lod-manifest.schema.json。

## 标准资源图优化

优化器递归读取 external tileset、glTF/GLB、buffer、纹理和 schema。支持输入根内相对 URI 与 glTF data URI；远程资源应先归集。循环引用、损坏范围、外部路径、冲突输出在发布前失败。

共享几何按源资源、缓冲区间、accessor 布局与编码策略归集；不同内容引用同一输出 buffer。首版保持顶点、索引、POSITION、实例和 feature 数据的原始数值/顺序，使用 meshoptimizer bufferView 编码，并逐字节解码回验。没有自行实现减面或压缩算法。

纹理按源内容、颜色用途、编码参数缓存。底色/自发光使用颜色编码，法线/数据使用线性 UASTC。相同图像同时用于颜色和数据时输出不同变体。转换 WebP/AVIF 来源时同步清理已替换的 codec 引用与声明。feature-ID/property 纹理保留原始无损字节及所需 codec，材质纹理独立优化，避免改变对象 ID。

输入 glTF 的 JSON 扩展直接保留，包括 EXT_instance_features 和 EXT_structural_metadata；glTF-Transform 用于解码检查，不通过不了解实例 feature 的读写循环重建这些元数据。


优化输出为 publication：

- 仅保留标准运行资源及发布管理资料，不携带 `_build` 或 LOD hand-off。
- 继承 sceneId/objectKey，重写 catalog、objects 中的内容路径及 release 引用。
- 重新生成资源 hash、optimization-manifest v3 和报告。
- 目录输出新建、通过校验后原子提交；失败不覆盖输入或已有发布成果。
- 已优化输入应从原始构建/发布目录重新加工。

## 验证

`npm run lint`、`npm test`、`npm run build` 覆盖：

- 标准构建 manifest、物理命名、输入 hash、确定性 LOD；
- 不同原型各自的 LOD/base-only 和已有 Draco/Meshopt 解码；
- 两 tile 共享几何、不同实例 feature、POSITION 字节不变；
- 同图像不同色彩用途、无损 feature 纹理；
- metadata 身份、管理路径、资源闭包、循环和 symlink 安全；
- 原子输出失败与可重复优化结果。

