# 变更日志

本文档记录 `model-optimizer` 的版本变更。

## [0.3.0] - 2026-09-10

### 新增

- 支持标准 3D Tiles 资源图优化，自动发现 tileset、glTF/GLB、缓冲区、纹理及 schema 资源。
- 支持标准 3D Tiles LOD 构建，按原型生成连续的 LOD 候选，并输出对应清单和报告。
- 新增共享几何缓冲归集、Meshopt 无损编码及 BasisU/KTX2 纹理压缩。
- 新增 Web 资源优化 worker 与可复现发行包，提供 `model-lod-worker` 和 `model-opt-worker` 两个 CLI。

### 优化

- 优化过程中保留 scene、object、component 和 part 身份，以及组件索引、目录和发布引用。
- 支持压缩 GLB 读取和校验，保持节点变换、顶点/索引数据及未知 glTF 扩展的兼容性。
- 规范 lod-input 到 model-optimizer 的交接协议，校验 LOD 路径、资源闭包、路径安全和文件哈希。
- 保持 LOD 层级连续；某个原型的 LOD 生成失败时仅保留已成功的前缀，不影响其他原型。

### 修复

- 修复纹理编码替换后 codec 引用及声明未同步更新的问题。
- 修复 CLI 通过 npm bin links 启动时的解析问题。
- 修复 Windows 环境下发行打包脚本无法启动 `npm pack` 的问题。
