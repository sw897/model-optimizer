# 变更日志

本文档记录 `model-optimizer` 的版本变更。

## [Unreleased] - 0.4.0

- 补齐 npm 10 / Node.js 22 安装所需的可选 esbuild peer 依赖锁定记录。
- 将提供 macOS/Linux 编码器的 npm 包装器列为可选依赖，Windows 使用随包 Release 编码器；安装包冒烟验证覆盖移除 `cpu-features` 后的完整压缩流程。
- 使用无命名空间的 `model-optimizer` 包名，输入要求集中在独立输入规范中。
- **格式变更：**采用 `model-optimizer.*` 清单标识、`model_features_v2` 元数据及 `model_components` / `prototype_parts` 类；既有输入需按规范转换标识并重新计算文件摘要。
- LOD 中断恢复目录采用 `.lod-work` 后缀；此前版本的工作目录需重新生成。

- 修复审查发现的便携验证遗漏：强制要求双启动器与 CLI 入口，逐项验证应用文件、包身份、许可证清单和授权文本哈希。
- 随便携包保存实际 Go 工具链许可、Sharp/libvips 源码与构建资料、匹配 SDK 的头文件及导入库，明确记录未完成的源码闭包与原生 Windows 替换验证；增加严格发行就绪检查。
- 修复编码器重建在含空格/中文路径下的 CMake 参数处理，完整重建复现原审查二进制哈希。

- 采用 Apache-2.0，补齐 NOTICE、第三方依赖说明、贡献指南、安全报告与发行准备文档。
- 增加英文入口、中文使用指南、程序生成的 GLB、3D Tiles 和 LOD 输入样例。
- 更新 Sharp 至 0.35.5、Vitest 至 4.1.12，并更新存在安全公告的间接开发依赖。
- 用跨平台 Node.js 脚本执行构建后的权限设置与清理，运行时最低版本对齐为 Node.js 20.9.0。
- CLI 版本从 package.json 读取，校验工具链与锁文件一致性；发布身份和纹理缓存纳入直接依赖版本。
- 增加安装 tarball 后的双 CLI 冒烟检查，以及跨平台 CI 配置。
- Windows 改用锁定源码及编译器构建的 CPU-only Release 编码器，关闭 OpenCL/SSE4.1、静态链接 C++ 运行库，保留完整构建来源、哈希和许可。
- 便携包支持跨平台组装，锁定 Windows Node.js 24.22.3 和目标平台依赖，校验普通/延迟 DLL 导入和 ZIP 解压后完整性，拒绝隐藏调试运行库引用。
- 扩展便携包验证，覆盖空 PATH、Unicode/空格路径、几何精度、KTX2、目录/瓦片/真实 LOD 和编码器篡改；区分原生 Windows、Wine 与未执行状态。
- 补充 macOS/Linux 本地 Wine 验证镜像准备脚本；ARM 主机锁定 QEMU 10.0.13 和 CPU 配置，记录镜像身份并限制验证容器资源。
- 保留 npm 发布锁，当前仅生成本地产物。公开便携发行仍需完整第三方源码交付及原生 Windows 验收复核。

## [0.3.2] - 2026-09-21

- LOD 支持按 primitive 保留原型 part 身份、属性表与材质边界，不支持的布局保留 base-only。
- 发布索引按对象边界及体积预算重新分片，运行时 JSON 紧凑序列化并更新摘要链。

## [0.3.1] - 2026-09-12

### 优化

- 相同源缓冲跨文件名共享编码和资源 URL；按字节及编码布局复用区间，保留独立的 accessor 语义。
- 预索引 accessor 与索引视图，消除大模型 bufferView 编码过程中的重复全表扫描。
- 重复 Meshopt 区间共用虚拟解码空间，GLB 封装不再重复嵌入相同物理缓冲。
- 保持 GLB 自包含和现有 Meshopt/KTX2 策略，不改变组件身份、几何精度或 LOD。

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
