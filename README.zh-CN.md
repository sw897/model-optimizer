# Model Optimizer

面向 GLB 和标准 3D Tiles 的离线优化工具。几何缓冲采用 Meshopt 无损压缩，材质纹理采用 Basis Universal / KTX2 压缩；另提供基于规范原型资产生成 LOD 候选的 CLI。

[English](README.md) · [Apache-2.0](LICENSE) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md)

## 状态与环境

当前 `0.4.0` 是尚未发布的本地准备版本，保留 `private: true` 禁止 npm 发布。运行需要 Node.js ≥20.9.0，开发建议使用维护中的 Node.js LTS。Windows 便携包仍有原生验收和第三方源码交付阻塞，详见[阻塞项记录](docs/release-blockers.md)。

- `model-opt-worker`：接受单个 GLB、普通模型目录或标准 3D Tiles 目录。
- `model-lod-worker`：接受符合[输入规范](docs/input-specification.md)的原型目录，需要 `_build/build-manifest.json`、文件摘要清单和基础原型 GLB。
- 优化结果需要支持 `EXT_meshopt_compression` 与 `KHR_texture_basisu` 的解码环境。

## 构建与样例

```sh
npm ci
npm run build
npm run example
node dist/opt-cli.js -i artifacts/example/model.glb -o artifacts/example/model-web.glb --json
node dist/opt-cli.js -i artifacts/example/tileset -o artifacts/example/tileset-web --json
node dist/cli.js -i artifacts/example/lod-input -o artifacts/example/lod --max-level 1 --json
```

样例程序生成几何、纹理、元数据及所需摘要，无外部模型或业务数据，采用 Apache-2.0。目标目录必须不存在；再次运行可用 `npm run example -- <新目录>` 指定其他位置。详见[样例说明](examples/README.md)。

## 输入与输出

```sh
model-opt-worker -i model.glb -o model-web.glb --json
model-opt-worker -i models -o models-web --json
model-opt-worker -i tileset -o tileset-web --json
model-lod-worker -i lod-input -o lod-output --preset tower-v1 --max-level 2 --json
```

| 输入 | 输出 |
| --- | --- |
| 单个 GLB | 自包含 GLB，允许使用不同文件名 |
| 根目录没有 `tileset.json` 的模型目录 | 递归优化 GLB，保留相对路径，其他普通文件原字节复制 |
| 根目录含 `tileset.json` 的瓦片目录 | 按可达资源图生成完整优化目录，更新已声明的管理索引和摘要 |
| 符合 LOD 输入规范的原型目录 | 基础场景、逐原型 LOD 候选、清单与报告 |

全部数据要求集中在[输入规范](docs/input-specification.md)：包括路径与哈希、原型清单、`model_features_v2` 元数据，以及可选对象/组件索引。输入可由任意工具按规范生成。`0.4.0` 的标识属于格式变更；既有数据需转换标识并重算相关摘要，不提供旧标识别名。

`--help` 列出各 CLI 参数。退出码 0 表示成功，1 表示失败。`--json` 将最终成功报告写入标准输出；错误及可用的失败报告写入标准错误。底层库可能另外输出诊断，目录输出中的报告文件可独立读取。

### 优化行为与限制

- 固定使用 `web-v1`：保持几何数值、顶点/索引顺序、坐标变换和 feature 身份；纹理压缩有损。不减面，也不生成 LOD。
- 单文件和普通目录中的 GLB 输出保持自包含；标准瓦片输出可在输出根目录内共享资源。
- GLB 扩展名大小写不敏感；普通模型目录中的 `.gltf` 作为辅助文件复制。
- 瓦片输入支持 external tileset、glTF/GLB、buffer、纹理、schema，以及 glTF data URI。远程 URI、循环引用、路径逃逸、符号链接及损坏范围会被拒绝。
- 输出文件必须不存在；输出目录必须新建或为空，且不能与输入相交。已优化数据会被拒绝，应保留原始资产。
- `b3dm`、`i3dm`、`pnts` 和 implicit tiling 展开不在已验证的支持范围内。
- 元数据扩展直接保留并验证，不通过丢失未知扩展的模型重写流程重建。几何共享依照字节内容和编码布局归集，feature/property 纹理保留无损数据。

### LOD 行为

预设为 `tower-v1`、`span-v1`、`base-only`。默认生成一级；`--max-level 0` 仅验证基础资产。每级独立从基础 GLB 化简并检查米制误差，同一原型质量失败后停止后续级别，保留连续成功前缀。首级失败或布局不支持时保留 base-only 并记录原因。

输入要求使用规范原型，拒绝已装配的世界组件或 GPU 实例模型。支持的 part 布局保留属性表、part 身份及 primitive/材质边界；混合 part、共享 accessor、动画、缩放节点等布局保留 base-only。LOD 候选不改变基础 tileset 的层级或内容引用。

输出包括 `lod-manifest.json`（`model-optimizer.lod-manifest` v3）、`lod-worker-report.json`、工具链清单和通过质量检查的 LOD GLB。清单绑定输入摘要，记录输出摘要、工具版本与误差。中断后可用 `--resume` 复用验证通过的 `.lod-work` 目录。

## 本地打包与验证

```sh
npm run lint
npm test
npm run audit:dependencies
npm run package
npm run test:package
npm install -g ./artifacts/model-optimizer-0.4.0.tgz
```

`package` 在忽略的 `artifacts/` 中生成 tarball 和 SHA-256，不上传或发布。包内含编译后的 CLI、schema、双语文档、样例及许可证；Node.js 和依赖需另行安装。源码的 `package-lock.json` 锁定完整依赖图，`toolchain.lock.json` 记录直接运行依赖；tarball 安装时仍会解析间接依赖。

`test:package` 在临时目录安装真实 tarball，执行双 CLI、退出码、GLB/目录/瓦片/LOD 和纹理编码检查。CI 配置覆盖 Linux、macOS 和 Windows；配置存在不代表远端检查已执行。

Windows x64 便携包可跨平台组装，使用经审查的 CPU Release 编码器、锁定的 Windows Node.js 和目标平台依赖：

```sh
npm run package:portable
npm run check:portable -- artifacts/model-optimizer-0.4.0-windows-x64.zip
```

Windows 构建机自动执行解压后的冒烟检查。macOS/Linux 可先运行 `npm run prepare:wine`，再用 `npm run package:portable -- --wine-image model-optimizer-wine:local` 补充兼容验证；ARM 主机使用锁定的 QEMU。Wine 结果单独标记，原生 Windows 验收仍需实际完成。详见 [Windows 构建与验证](docs/windows-portable.md)及[发行准备](docs/releasing.md)。

## 许可证

项目代码与生成式样例采用 [Apache-2.0](LICENSE)。第三方依赖保留各自许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [NOTICE](NOTICE)。
