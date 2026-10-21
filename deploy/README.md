# 服务器部署

这套配置面向**一台 Linux 服务器、多人登录、一个 Paperclip 服务进程**。同一 PostgreSQL 18 数据库保存 Paperclip 的组织、任务和工作台插件表；`paperclip-home` 卷保存配置、加密主密钥、上传文件和 Agent 文件。中文入口仅监听服务器的 `127.0.0.1`，由 Tailscale Serve 或 Caddy 提供 HTTPS。数据库端口不映射到主机。官方 Paperclip 镜像固定在与当前插件 SDK 相同的 `2026.916.1` 发布版和 OCI digest；升级前先在测试环境验证。

## 准备

- Linux `amd64` 或 `arm64`、Docker Engine 和 Compose v2、`bash`、`openssl`。
- 私网：服务器和使用者加入同一个 Tailscale 网络，取得 HTTPS 主机名。
- 公网：将域名解析到服务器，让 TCP 80、443 到达 Caddy；登录始终开启。
- 从 GitHub 克隆完整源码：`git clone --recurse-submodules https://github.com/PIGU-PPPgu/intelliPaperclip.git`。

在仓库根目录运行以下其中一组：

```sh
# 集团 VPN / Tailscale 私网
./deploy/init-env.sh private https://paperclip.example.ts.net
./deploy/up.sh
tailscale serve --bg --https=443 http://127.0.0.1:3100

# 或：自有公网域名；不要在已有 deploy/.env 上再次运行 init-env.sh
./deploy/init-env.sh public https://paperclip.example.com
./deploy/up.sh
```

`init-env.sh` 只在第一次运行，创建权限为 `0600` 的 `deploy/.env`，生成 PostgreSQL 密码与三个独立的签名密钥；再次运行会拒绝覆盖。`up.sh` 在公网模式启动 Caddy，在私网模式只启动 PostgreSQL、Paperclip 和中文入口。服务先在本机 `127.0.0.1:3100/_paperclip_zh/health` 检查，再访问 HTTPS 地址。

### 首位管理员与插件

这是一个新的 `authenticated` 实例。私网模式下，首位已登录用户可在浏览器领取实例管理员身份；公网模式按 [Paperclip 官方首位管理员流程](https://docs.paperclip.ing/reference/deploy/deployment-modes/) 生成一次性认领链接，链接只交给实际管理员。之后由管理员邀请其他成员并设置其公司角色。不要把单人 `local_trusted` 模式对外开放。

管理员登录后在 Paperclip 插件管理页从本地路径安装工作台：`/opt/intellipaperclip/plugins/workbench`，核对状态为 `ready`。插件目录随自定义镜像固定存在，重新启动容器不需重新安装；工作台迁移及业务记录保存在同一个 PostgreSQL 数据库中。模型提供商和 Agent 的凭据在 Paperclip 的密钥界面单独配置，不写入 `deploy/.env` 或 Git。

NAS Source 源码也位于镜像的 `/opt/intellipaperclip/plugins/nas-source`，**此 Linux 部署不自动安装或绑定它**。当前只读 SMB 挂载检查针对 macOS；在 Linux 服务器上启用前需要单独实现和验证 Linux 的只读挂载识别、窄目录授权及零写入验收。工作台无需 NAS Source 即可使用。

## 数据库与文件

| 持久化对象 | Docker 卷 | 内容 |
| --- | --- | --- |
| PostgreSQL | `intellipaperclip-pgdata` | Paperclip 核心表和工作台插件表。 |
| Paperclip home | `intellipaperclip-home` | 实例配置、加密主密钥、附件、Agent 指令及工作区。 |
| Caddy（公网） | `intellipaperclip-caddy-data`、`intellipaperclip-caddy-config` | HTTPS 证书与代理状态。 |

官方服务会在空数据库上执行迁移。这里保持单个应用实例：数据库可独立维护，但本地附件、Agent 文件和本地路径插件并非多节点共享。未来若要多台应用服务器，应先改为对象存储、共享 Agent 文件策略和可复现的插件分发，再另行验收。[数据库](https://docs.paperclip.ing/reference/deploy/database/)与[存储](https://docs.paperclip.ing/reference/deploy/storage/)说明了这两个边界。

### 备份与恢复

```sh
./deploy/backup.sh
```

脚本会短暂停止 Paperclip 写入，生成一致的 `database.dump`、`paperclip-home.tar.gz`、`env.backup` 和校验和，然后恢复服务。`env.backup` 与 home 归档含密钥；将整个备份目录加密后存到服务器之外，并定期演练恢复。不要执行 `docker compose down -v`，它会删除持久化卷。

`restore.sh` **只接受本脚本生成的备份**，并在数据库或 home 卷非空、服务仍运行、环境密钥不匹配时拒绝覆盖。恢复到一台新服务器时，先把备份内的 `env.backup` 安装为 `deploy/.env`（保持 `0600`），然后：

```sh
./deploy/restore.sh /absolute/path/to/backup-directory
./deploy/up.sh
```

恢复后核对登录、公司/任务数量、工作台记录、附件、插件状态及 Agent 路径。公网域名若变化，先在隔离测试环境处理旧地址和认证配置，不能把旧 `.env` 直接换成新密钥。

### 从现有 Mac 迁移

不要把 Mac 的数据库或 NAS 文件推到公开 GitHub。当前 Mac 实例使用 PostgreSQL 18；跨机器复制**完整实例**需要 PostgreSQL 18 的逻辑备份、对应的 Paperclip 数据目录与加密主密钥、以及登录签名密钥；单独的 `.sql.gz` 不能恢复附件和已加密凭据。源实例先暂停写入并做完整备份，再在空的 PostgreSQL 18 数据库恢复，最后把 Agent 的 Mac 路径、插件本地路径和 NAS 绑定重设为服务器上的有效路径。旧的 `local_trusted` Board 所有权应按官方认领流程转换。PostgreSQL 18 的官方镜像将数据卷挂载在 `/var/lib/postgresql`；如果已经用旧版部署包创建了 PostgreSQL 17 卷，不要直接替换镜像，应先备份并单独安排数据库大版本迁移。

如果只迁移组织、Agent、项目和任务，可使用 Paperclip 的[公司导出/导入](https://docs.paperclip.ing/guides/power/export-import/)；它不传输密钥值、机器路径或历史审计。**工作台插件自有表和实例加密密钥仍须单独核对**，不能把公司包当作完整数据库备份。当前部署脚本不会自动覆盖现有 Mac 实例，也不会自动导入真实部门资料。

## 更新

修改上游 Paperclip 镜像版本前，先备份并在测试实例确认 Plugin SDK 兼容、数据库迁移、中文入口、登录和 Agent 运行。确认后才调整 `Dockerfile.paperclip` 中的版本与 digest，并重新构建；Git 子模块的更新也应经过各自测试。实例卷、数据库和插件安装记录独立于镜像保留。[官方部署模式](https://docs.paperclip.ing/reference/deploy/deployment-modes/)与[HTTPS 配置](https://docs.paperclip.ing/reference/deploy/https/)是服务器设置依据。
