# intelliPaperclip

在 [Paperclip](https://github.com/paperclipai/paperclip) 上扩展部门工作台、中文界面和受限资料检索。本仓库只包含扩展源码；Paperclip 官方程序、实例数据库、凭据、NAS 文件和本机部署记录不在仓库中。

| 模块 | 内容 |
| --- | --- |
| [部门工作台](extensions/paperclip-department-workbench) | 原生侧栏、仪表盘、项目标签和行事历、记事、OKR、里程碑、知识库等视图；作为独立仓库维护。 |
| [中文界面](open-source/paperclip-zh) | 独立于官方安装包的中文入口；作为独立仓库维护。 |
| [NAS Source](extensions/paperclip-department-nas-source) | 小范围只读文件列表、搜索与文档读取插件。 |

前两个模块以 Git 子模块引用各自的公开仓库，避免同一套源码在多个仓库中分叉。克隆时使用：

```sh
git clone --recurse-submodules https://github.com/PIGU-PPPgu/intelliPaperclip.git
```

需要 Node.js 24+ 和与各模块锁定版本兼容的 Paperclip。NAS Source 当前针对 macOS 的 SMB 挂载实现；每个模块的安装和权限边界见其 README。源码检查：

```sh
npm ci --prefix extensions/paperclip-department-nas-source
npm run check --prefix extensions/paperclip-department-nas-source
npm test --prefix extensions/paperclip-department-nas-source

npm ci --prefix extensions/paperclip-department-workbench
npm run typecheck --prefix extensions/paperclip-department-workbench
npm test --prefix extensions/paperclip-department-workbench
npm run build --prefix extensions/paperclip-department-workbench

npm ci --prefix open-source/paperclip-zh/sidecar
npm test --prefix open-source/paperclip-zh
```

NAS Source 的哈希校验快照模式仅用于验证下游流程，不代表实时 SMB 已可用。部署时应选择获准的非敏感目录，并在 Paperclip 中单独配置只读资料源。项目按 [MIT License](LICENSE) 开源；子模块保留各自的许可证。
