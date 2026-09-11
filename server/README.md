# 多人协作服务

协作入口为 `/collaboration`，支持账户登录、邀请注册、实时文本/图片/文件节点，以及只有创建者可以读取和执行的隐私 API 节点。原有 `/canvas` 是本地画布，不会自动上传本地画布、模型配置、Agent 对话或 WebDAV 数据。

## 使用

1. 管理员登录后创建协作画布，在「分享与权限」中选择只读或编辑权限、可选口令和到期时间。
2. 新成员通过分享链接注册；已有账户登录后接受邀请。链接的令牌放在 URL fragment 中，页面读取后立即清除。
3. 普通节点的拖动和输入立即在本地显示，后台每 150 ms 合并提交。状态栏区分连接中、后台同步、已同步、离线及冲突。
4. 点击「隐私节点」，在私有窗口配置 HTTPS API 地址、密钥、请求方法和正文。「服务管理」中需要先批准该 API 域名；允许列表默认为空。
5. 请求结果只回到创建者的私有窗口，不会自动生成公共节点。窗口在断网、切换标签页、离开页面或连接权限失效时关闭；未保存的内容会丢失。

新增协作节点包括文本、共享图片/附件及隐私 API 请求。原本地画布的生成配置、插件、连接编排和 Agent 功能仍走本地流程，不会作为隐藏字段混入协作协议。

## 同步和权限

- Node.js 24、Fastify 和 WebSocket 处理网络连接；SQLite 的读写、事务和本地磁盘同步在独立 Worker 中执行，使用 WAL 和 `synchronous=FULL`。
- 只广播变化的节点。首次连接分帧发送快照；断线后重新鉴权并获取当前快照，客户端保留当前页尚未确认的草稿。
- 节点版本检查拒绝过时写入；一批操作原子提交，冲突不覆盖他人内容。客户端可选择使用服务器内容，或确认把草稿应用到最新版本。
- 操作 UUID 与请求摘要用于去重，数据库提交成功后才确认保存。重试相同操作不会重复创建节点。
- 分享权限为 `viewer` / `editor`，管理权属于画布创建者。分享撤销、权限更改、成员移除、退出登录都会断开对应的在线连接；分享和登录到期也会断开。
- 移除成员后，如果仍允许使用原分享链接，成员可以再次申请加入；需要彻底收回链接授予的权限时，应同时撤销该链接。
- WebSocket 只负责快照、变化通知和在线人数；所有内容修改通过带会话、来源与 CSRF 校验的 HTTP 接口处理。

## 隐私边界

公共数据有严格字段白名单。隐私节点在公共快照、操作回执和广播中仅有固定的「隐私节点」标题、节点 ID、位置、尺寸和版本，不含真实标题、备注、URL、密钥、请求正文或响应。画布所有者也不能经应用接口读取其他成员的隐私节点。

隐私配置和结果使用 AES-256-GCM 加密，密文绑定画布、节点和创建者。云盘文件与数据库备份也加密；主密钥保存在服务器本地独立文件中，不写入云盘备份、Git 或日志。登录密码采用随机盐及 scrypt，登录与分享令牌只存摘要。会话 Cookie 使用 HttpOnly、Secure、SameSite=Strict，敏感响应不缓存。

API 请求仅允许管理员批准的 HTTPS 443 域名。每次请求检查全部 DNS 解析结果，拒绝内网、回环、保留、链路本地和云元数据地址，并将通过校验的地址固定到实际 TLS 连接；不跟随重定向。响应中的当前 API 密钥会脱敏。

这提供协作者之间的隔离和云盘静态数据保护，**不是端到端加密**：服务器需要解密并执行 API 请求，拥有服务器及主密钥的管理员仍具有解密能力。公共内容一旦已发送给别人，就不能远程收回其截图或副本。节点可见性创建后不能通过公共更新改为私有；请从一开始就使用隐私节点保存秘密。删除节点也不会抹除已有加密备份，备份保留与清理需由管理员管理。

协作页不加载分析脚本、第三方节点插件和本地 Agent 面板。服务器部署使用严格 CSP，不允许任意脚本、iframe 或第三方分析代码；本地画布中依赖第三方脚本或浏览器直连 API 的功能不属于该受限协作部署的兼容承诺。

## 已确认的默认配置

| 配置 | 默认值 | 达到限制时 |
| --- | --- | --- |
| 每画布在线连接 | 50 | 拒绝新增连接 |
| 单次同步请求 | 1 MiB | 拒绝，不截断 |
| 单文件 / API 响应 | 20 MiB | 明确失败，不保存截断内容 |
| API 执行时间 | 120 秒 | 中止请求 |
| 会话 / 分享有效期 | 24 小时 / 默认 7 天 | 重新登录或重新授权 |
| 编辑合并间隔 | 150 ms | 本地即时显示，后台发送 |
| API / 文件处理并发 | 2 | API、上传繁忙时返回 429；下载在有界队列中等待，队列上限沿用 50 个连接的容量 |
| 登录速率 / 写入速率 | 每来源 10 次/分钟；每账户 600 次/分钟 | 返回 429 |
| 云盘备份周期 | 60 秒 | 失败会在服务管理中显示 |

参数均在 `.env.example` 中。登录限流仅信任来自回环地址反向代理的转发 IP；后端必须绑定 `127.0.0.1`，网关覆盖传入的 `X-Forwarded-For`。API 与下载处理都不阻塞同步事件循环。

## 服务器存储和部署

本次部署使用 `deploy/compose.yml` 和 `deploy/infinite-canvas.service`：

- 应用代码：`/opt/infinite-canvas`。
- 本地事务数据库和密钥：`/var/lib/infinite-canvas`，容器内 `/data`。
- 文件、备份和挂载标记：`/root/PDSDrive/团队空间/huanxue/infinite-canvas`，容器内 `/storage`。
- `files/*.enc` 为加密文件；`backups/*.sqlite.gz.enc` 为加密压缩备份，对应 JSON 清单标记备份完成并包含 SHA-256。
- FUSE/NFS/SMB 不可用作 SQLite 主库位置。挂载标记不存在或不正确时拒绝画布内容、隐私内容和文件写入，避免悄悄写入系统盘的空目录。
- 60 秒为备份调度间隔；云盘延迟或故障会拉大可恢复时间窗口。系统盘完全丢失时，应以「服务管理」显示的最近成功备份为准。本机正常重启使用已提交事务恢复。
- 应用与云盘挂载服务有启动依赖，开机检查挂载标记后重建应用容器，避免绑定到尚未挂载的空路径。
- 现有 FUSE 只允许 UID 0 访问，所以应用容器使用 UID 0，同时禁用所有 Linux capabilities、禁止新增权限、使用只读根文件系统，仅绑定本项目的数据目录，不挂载 Docker socket。

80 端口跳转至 HTTPS。使用 Let's Encrypt 的 IP 短期证书，不依赖域名；`infinite-canvas-cert-renew.timer` 每天两次触发续期检查，成功后校验并重载 Nginx。证书使用 `shortlived` profile，参见 [Let's Encrypt / Certbot IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。

常用运维命令：

```sh
systemctl status infinite-canvas mountapp
docker logs --tail 100 infinite-canvas-app
systemctl list-timers infinite-canvas-cert-renew.timer
docker exec infinite-canvas-app npm run backup
```

恢复流程应先在新的本地文件中验证，不能直接覆盖正在运行的主库：

```sh
docker exec infinite-canvas-app node scripts/backup.js restore \
  /storage/backups/完整文件名.sqlite.gz.enc /data/recovered.sqlite
```

恢复同时需要对应的 JSON 清单和原始 32 字节主密钥。工具拒绝覆盖现有恢复文件、拒绝校验和不符或认证失败的密文。检查恢复库 `PRAGMA integrity_check`、账户与节点数量后，在维护窗口停止应用，保留当前数据库及 WAL/SHM，再切换到恢复文件并启动。未知数据库版本或丢失密钥会拒绝启动，不会生成替代密钥覆盖旧数据。

账户密码遗失时，在维护窗口停掉应用，通过受保护的标准输入向 `scripts/create-admin.js --reset` 提供 `username` / `password` JSON，然后重新启动；这会使该账户旧会话失效，不改变其身份或节点归属。该命令只能由服务器运维人员执行。主密钥遗失且无离线副本时，无法恢复隐私内容与加密备份。

## 本地开发与验证

```sh
cd server
npm ci
# 按 .env.example 设置环境；开发默认绑定 localhost:8787，前端开发 origin 为 localhost:3000。
# 首次账户：将受保护的 username/password JSON 从标准输入传给 npm run create-admin。
npm start
```

另一个终端在 `web` 运行 `bun install --frozen-lockfile` 和 `bun run dev`。Vite 将 `/api` 和 WebSocket 代理到本地服务。静态生产文件需先在 `web` 执行 `npm run typecheck` 和 `npm run build`，再构建 `server/Dockerfile`。

```sh
cd server
npm test
npm run load-test
npm audit --omit=dev
```

`load-test` 创建隔离的临时数据库，在独立服务进程上使用真实 HTTP / WebSocket 连接、20 个独立账户、100 轮并发编辑，验证 2,000 次写入后的节点收敛、事件版本连续和隐私哨兵不外泄。它不访问生产数据。最新验证记录见 [验收记录](VALIDATION.md)。
