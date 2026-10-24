# sub2api 余额哨兵

监控指定的 sub2api 用户，当余额低于阈值时自动充值固定额度，并完整记录**加额前余额**和**加额后余额**，供后续对账收款。

## 它做了什么

```
每 N 秒轮询
   ↓
读取白名单用户的实时余额
   ↓
余额 < 阈值 ? ── 否 ──> 什么也不做
   │是
   ↓
检查安全护栏（单笔上限 / 每日次数 / 每日总额 / 熔断 / 急停）
   ↓
POST /api/v1/admin/users/:id/balance  { operation: "add", balance: 100 }
   ↓
回读余额 → 写入流水（before / after / 金额 / 时间 / 状态）
   ↓
在「对账收款」页汇总：每个人欠你多少，导出 CSV 去收款
```

## 快速开始

按使用场景选择完整操作文档：

- [本地启动（不使用 Docker）](docs/local-start.md)：Node.js 安装、配置、密码生成、单进程启动、热更新及模拟服务。
- [Docker 部署](docs/docker-deploy.md)：服务器构建、Secret、上游网络、HTTPS 代理、数据卷备份及更新。

```bash
npm install
cp .env.example .env
chmod 600 .env          # 重要：这里存的是管理员 Key
# 编辑 .env，填入 SUB2API_BASE_URL、SUB2API_ADMIN_API_KEY、SENTINEL_ADMIN_USERNAME
# 以及密码哈希（不要把明文密码写入 .env）：
#   read -r -s -p 'Sentinel password: ' SENTINEL_PASSWORD; printf '\n'
#   printf '%s' "$SENTINEL_PASSWORD" | node server/src/hash-password.js; unset SENTINEL_PASSWORD
# 把输出复制到 SENTINEL_ADMIN_PASSWORD_HASH
# 默认 AUTH_REQUIRE_TOTP=false，仅用用户名和密码登录，无需动态码或账户加密密钥
```

### 需要提供什么给哨兵

当前实现**不需要 Sub2API 数据库连接**：哨兵通过 Sub2API 管理 API 读取余额并调用原子 `operation: "add"`，
自己的对账流水保存在独立的 SQLite volume。部署时只需要在服务器的 `.env` / Secret 中配置：

1. `SUB2API_BASE_URL`（最好是同一台服务器的私网 HTTPS/容器网络地址）。
2. `SUB2API_ADMIN_API_KEY`（这是 Sub2API 的全局管理员密钥，权限很高；不要粘贴到聊天、工单或日志。可以用环境变量或 Secret 文件注入）。
3. 哨兵自己的 `SENTINEL_ADMIN_USERNAME` 与 `SENTINEL_ADMIN_PASSWORD_HASH`；默认不需要动态码。

如果要核对接口版本，再提供 Sub2API 版本号或管理 API 文档即可；不要直接给数据库密码。管理员 API Key
仅应通过服务器上的权限为 `600` 的 `.env` 或外部 Secret 注入，使用完毕后可在 Sub2API 后台轮换。无需给哨兵数据库配置，也不要把密钥发在聊天中。

#### Secret 文件注入

对 Docker/Kubernetes 部署，建议将秘密挂载成只读文件，而不是放进容器环境变量。每个秘密必须且只能配置一种来源：普通变量或对应的 `_FILE` 变量；两者同时非空会拒绝启动。

```ini
SUB2API_ADMIN_API_KEY=
SUB2API_ADMIN_API_KEY_FILE=/run/secrets/sub2api_admin_api_key
SENTINEL_ADMIN_PASSWORD_HASH=
SENTINEL_ADMIN_PASSWORD_HASH_FILE=/run/secrets/sentinel_admin_password_hash
```

Docker Compose 不会因为设置了 `_FILE` 就自动挂载主机文件；需在 Compose 中用 Docker Secret 或只读 bind mount 把文件挂到对应容器路径。镜像以 UID 1000 的 `node` 用户运行，请确保该 UID 可读秘密文件，同时不要为了方便把凭据设成全局可读。缺失或不可读的文件会导致配置失败；文件末尾的换行会被忽略。

**第一次务必先只观察**，保持 `.env` 中的 `AUTO_TOPUP_ENABLED=false`，启动后确认识别到的余额正确、不会误判，再由人工改回 `true`：

```bash
npm run build:web   # 构建前端（只需一次，改动前端后再跑）
npm start           # 打开 http://127.0.0.1:7788
```

启动后使用用户名和密码登录哨兵账号，默认 `AUTH_REQUIRE_TOTP=false`，不需要动态验证码。
首次由配置式初始管理员登录。登录密码使用 Node `scrypt` 哈希；登录失败同时按来源 IP 和账号限流，防止跨 IP 猜密码。
浏览器使用 `HttpOnly`、
`SameSite=Strict` 会话 Cookie，并对所有写操作要求 CSRF Token。
正式 HTTPS 反向代理部署时将 `AUTH_SECURE_COOKIES=true`，并设置 `ALLOWED_HOSTS` 为代理实际使用的 Host。

## 账户管理与权限

`SENTINEL_ADMIN_*` 定义的是**配置式初始管理员 / 恢复入口**。它不在业务账号表中，不能被 Web 页面停用或覆盖。
额外账户在「账户管理」中邀请开通，每人独立设置密码。默认不需要认证器，也不需要生成账户加密密钥。

| 角色 | 权限 |
| --- | --- |
| 管理员 `admin` | 所有业务操作、邀请账户、改角色、启停、重置凭据 |
| 操作员 `operator` | 监控规则、审批 / 手动加额、急停、上游核验及收款登记；不能管理账户 |
| 只读审计员 `auditor` | 查看及导出监控 / 流水 / 核验凭据 / 日志；不能触发巡检、修改规则、加额或登记收款 |

权限在服务端检查，不依赖按钮隐藏。角色变更、停用、改密、重置凭据都会撤销该账户旧会话；实际加额发出前还会再次检查操作者是否仍有权限。
已发出的上游请求无法撤回。自动巡检以 `system` 身份运行，停用某个操作员不等于关闭自动加额；如需停止全部加额，应启用全局急停。
正常前端不会从非本机的明文 HTTP 页面提交密码、验证码或邀请 Token；反向代理仍必须强制 HTTPS 并配置 HSTS，不能把前端检查当作传输加密。

### 默认密码登录与多账户

仅需配置初始管理员用户名、密码哈希及 Sub2API 接入信息，使用基础 Compose 即可启动和邀请额外账户：

```bash
docker compose config --quiet
docker compose up -d --build
```

账户管理操作和自己改密仍要求重新输入当前密码，不要求动态码。关闭 MFA 后不读取旧的 TOTP / 账户加密密钥文件配置，
无需为了启动而删除旧文件或恢复材料。密码登录比双因素认证少一道防线，远程部署必须使用 HTTPS，并优先叠加 VPN / 来源限制。

### 可选启用 TOTP

只有主动设置 `AUTH_REQUIRE_TOTP=true` 才会要求动态码；默认关闭。启用时需要为初始管理员生成
`SENTINEL_ADMIN_TOTP_SECRET`，并加入验证器。此模式下额外账户还需要加密密钥：

额外账户的 TOTP 密钥用 AES-256-GCM 加密，且密文绑定账户 ID。密钥必须独立于 SQLite 数据库保管：

```bash
node server/src/generate-account-key.js --output ./secrets/account-key
```

生成器不打印密钥、不覆盖已有文件，新目录 / 文件权限为 `700` / `600`。`secrets/` 已排除 Git 和 Docker 构建上下文。
本地运行时，将 `.env` 中的 `SENTINEL_ACCOUNT_KEY_FILE` 设为该文件路径；不要同时填写 `SENTINEL_ACCOUNT_KEY`。
仅在启用 TOTP 时，没有该密钥会阻止创建或重置额外账户；系统不会退化成明文保存 MFA。

Docker 可使用附加配置挂载密钥：

```bash
docker compose -f docker-compose.yml -f docker-compose.accounts.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.accounts.yml up -d --build
```

默认读取宿主机的 `./secrets/account-key`，可用 `SENTINEL_ACCOUNT_KEY_PATH` 指定其他路径。挂载为只读，文件不存在时拒绝自动创建目录。
**Linux 部署主机须预先确保 UID 1000 可以读取该文件**；可由运维调整文件属主与权限，不能改成全局可读来绕过问题。
反向代理网络附加文件可以继续叠加使用。

请保留独立的受保护备份，记录与数据库的对应关系。不要随意重新生成 / 替换密钥：旧密钥丢失时，已有额外账户的 MFA 无法解密，
只能由初始管理员逐个重置凭据、重新开通。初始管理员的密码和可选 MFA 仍由外部 Secret 管理。
从密码模式切换到 TOTP 后，尚未设置 MFA 的额外账户会被拒绝登录，需要管理员重新邀请；不会自动绕过动态码。
更改认证模式并重启会撤销所有旧会话。旧的 MFA 账户在密码模式下可正常用密码登录，但不会删除原 MFA 密文或重放计数器。

### 邀请、改密与重置

1. 管理员创建邀请时，重新输入自己的当前密码；只有主动启用 TOTP 时才需要未使用过的新动态码。
2. 邀请链接仅在创建 / 重置操作后显示一次，30 分钟有效。它是开通账户的高权限凭据，只能通过可信渠道交给账号本人。
3. 链接使用 URL fragment，页面取出后立即从地址栏移除，不经查询串发给服务器，也不保存在浏览器本地存储中。
4. 受邀者自己设置至少 12 字符的密码后即可开通。仅启用 TOTP 时额外要求加入认证器并验证动态码；未完成开通的账号不能直接启用。
5. 邀请被消费、过期、停用或设置发生变化后不能继续使用。重新邀请会清空旧密码 / MFA、撤销旧会话并作废旧链接。

普通账户可在「账户安全」修改自己的密码，需要旧密码；只有启用 TOTP 时才还需要新动态码。成功后所有旧会话退出。
管理员不能在当前会话里停用、降权或重置自己，应由另一位管理员或初始管理员处理。
用户名不可改名、账户只停用不物理删除，以保留历史操作者身份。管理操作带版本检查，旧页面不能覆盖其他管理员的新改动。

邀请、开通、角色变更、停用、凭据重置、改密等都有审计记录。密码模式下，同一账号的密码尝试共享跨 IP 上限。
启用 TOTP 后，每个账户的 MFA 重放计数器独立持久化；已通过密码验证的 MFA 尝试也有账号级的跨 IP 上限。

### Docker 部署

先按上面的步骤填写 `.env`，再启动：

```bash
docker compose config --quiet
docker compose up -d --build
docker compose logs -f sentinel
```

默认只把服务发布在服务器的 `127.0.0.1:7788`，数据保存在 Docker volume `sentinel-data`；
不要把映射地址改成 `0.0.0.0` 后直接暴露公网。远程访问应走 HTTPS 反向代理或 VPN，
设置 `AUTH_SECURE_COOKIES=true` 并把代理发送的 Host 精确加入 `ALLOWED_HOSTS`。

正常停止或重建使用 `docker compose stop` / `docker compose up -d --build`，不要把强制结束进程作为常规重启方式。
收到 `SIGTERM` / `SIGINT` 后，服务关闭 HTTP 新连接、取消首次与周期巡检，并阻止尚未发出的加额；
已发出的请求会继续回读、完成记账及通知，再关闭 SQLite。默认等待窗口为 45 秒，随 `REQUEST_TIMEOUT_MS`
自动调整，范围 30 至 255 秒；Compose 预留 5 分钟停止宽限期，避免默认 10 秒过早强杀。
超过应用等待窗口时以非零状态退出，不提前关闭仍有异步写入者的账本。强杀、主机故障、网络超时仍可能产生
`pending` / `unknown`；重启后必须按上游历史核实，不能为了恢复运行直接补发。

若 Nginx Proxy Manager 等反向代理也运行在 Docker 中，可通过额外的 Compose 网络配置接入：

```bash
SENTINEL_PROXY_NETWORK=npm_default docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build
```

把 `SENTINEL_PROXY_NETWORK` 替换成代理容器和哨兵都能加入的既有网络，并将代理上游设为 `sentinel:7788`；
不要在代理配置中覆盖原始 `Host`。若 Sub2API 也只在同一个受信任 Docker 私网提供 HTTP 服务，才设置
`ALLOW_INSECURE_SUB2API_HTTP=true`。

开发模式（前端热更新）：`PUBLISHED_PORTS=5173 npm run dev:server` + `npm run dev:web`（<http://127.0.0.1:5173>）。
前者让后端接受开发网页的 loopback Host；后端保留 `PORT=7788`，两条命令分别在两个终端执行。

## 没有真实 sub2api 也可以先试

内置了一个模拟 sub2api，用来把整条链路跑通：

```bash
node scripts/mock-sub2api.js          # 监听 :8080，含 3 个测试用户
```

`.env` 填写：

```ini
SUB2API_BASE_URL=http://127.0.0.1:8080
SUB2API_ADMIN_API_KEY=admin-mock-key-for-local-testing
# 同时保留上面登录配置中的 SENTINEL_ADMIN_USERNAME / SENTINEL_ADMIN_PASSWORD_HASH
```

建议使用独立测试账本 `SENTINEL_DB_PATH=./data/mock-sentinel.db`，避免与真实流水混用。
先保持 `AUTO_TOPUP_ENABLED=false`，在页面里添加用户 `1` 并巡检，只查询余额、不加额。
只有确认连接的是本机模拟服务后，才开启写开关并重启，再以阈值 `10`、金额 `100` 和「需审批」模式巡检并批准，
可以看到模拟余额从 5 变成 105 并生成流水。完整步骤见 [本地启动文档](docs/local-start.md#6-没有真实-sub2api用本机模拟服务)。

## 为什么用 `operation: "add"` 而不是 "set"

本项目只发送增量 `add`，不采用“读余额、计算新值、再 set”的方式，避免覆盖读取之后发生的消费。
已检查的本地 Sub2API 源码版本为 `378984d87`：`UpdateUserBalance` 对 `add` 调用 `AdjustBalance`，
使用原子 `UPDATE users SET balance = balance + $1`；HTTP 接口返回用户 DTO，而不是独立交易凭证。
我们另外回读一次余额，因此 `balance_before` / `balance_after` 是两个时点的余额快照；期间可能存在消费或其他充值，
不能用它们的差值证明本笔到账金额。服务器实际部署版本仍需确认，不能把本地源码检查当作真实接入验证。

## 防重复充值

每一笔充值都先持久化唯一的 `Idempotency-Key`（`sentinel-<uid>-<时间戳>-<随机>`），再发起请求。
该 ID 也写入 Sub2API 调账备注的 `sentinel_id=` 字段，便于与余额历史交叉核对。

本地源码的余额 handler 使用 `RequireKey: true`；`ObserveOnly=true` 只放行未提供 Key 的旧请求，
提供非空 Key 时仍进入去重流程。但幂等 coordinator 未配置时，handler 会直接执行，
**仅发送这个 Header 不等于上游一定去重**。正式启用前必须确认服务器的实际版本、幂等配置及持久化行为。
哨兵自身使用内存队列、跨进程 SQLite 锁，以及持久化的 `pending` / `unknown` 拦截，不会自动重试结果不明的写入。
收到 `X-Idempotency-Replayed: true` 时会保留重放标记。

添加与编辑监控规则互相独立：重复添加返回 `409`，不会覆盖原来的停用、审批模式或备注。
编辑和删除都必须提交从监控列表取得的 `rule_revision`（请求字段为 `ruleRevision`）；旧版本返回 `409`，需刷新后重新确认。
在上游用户校验返回后，保存事务内还会重新核对操作者会话、角色和凭据版本，停用 / 降权 / 重置中的旧请求不能继续保存。

每次保存监控设置都会产生新的规则版本，并使旧的待审批提议过期。最后一次余额读取之后，哨兵在同一 SQLite
写事务内重新检查实例绑定、白名单、启停、模式、规则版本、急停、熔断、未决流水、锁归属及每日限额，再预约 `pending` 流水。
这也适用于 Web 与 CLI 共用账本的情况。**事务提交后本笔即进入执行阶段；急停不能撤回已经发出的请求**。
手动加额允许操作者明确指定不同金额、忽略余额阈值，但不能绕过白名单、停用状态和全局护栏。

## 账本与实例绑定

一个 SQLite 账本只能对应一个 Sub2API 实例。全新空库会在首次启动时绑定规范化后的**完整** `SUB2API_BASE_URL`
（保留 `/base/path`，忽略末尾斜杠 / 默认端口等等价差异）以及可选的 `SENTINEL_INSTANCE_ID`。
轮换管理员 Key 不改变绑定；更换域名、端口、基础路径或实例 ID 会被拦截，不会自动更新绑定。
此时面板仍能读取原有账本，顶部显示阻断原因，但自动 / 手动加额、审批、余额查询、身份同步、规则新增 / 编辑 / 删除
和连接测试均不会操作新实例；核验只记录实例不匹配，不会查询错误站点。

**升级前已有数据但没有绑定的旧账本不会静默绑定。** 操作者需要核实账本确实属于当前站点，并按以下流程在可信本地终端确认：

1. 暂停所有使用该账本的 Web / CLI 进程，备份账本；不要用删除数据绕过阻断。
2. 保留原来的完整 `SUB2API_BASE_URL`，设置 `AUTO_TOPUP_ENABLED=false`。若需要实例 ID，应现在配置并记录它。
3. 本地执行命令，`--confirm` 必须等于规范化后的完整基础地址（无末尾斜杠）；不会发出任何上游请求：

```bash
node server/src/cli.js bind-instance --confirm=https://sub2api.example.com/base/path
```

Docker 部署可在同一配置 / 账本 volume 下使用 `docker compose run --rm --no-deps -e AUTO_TOPUP_ENABLED=false sentinel node server/src/cli.js bind-instance --confirm=https://sub2api.example.com/base/path`。
命令只在未绑定账本上执行；已经绑定但不匹配的账本无法重新绑定。历史流水保存的地址不同会拒绝确认；
旧版只有 origin 或没有地址的流水无法证明基础路径或实例归属，必须由操作者独立核实，不能把命令成功当作归属证明。
确认后先以观察模式恢复服务，再核对监控名单和未决流水，最后决定是否恢复写入。

如果确实迁移到不同 Sub2API，应建立独立新账本并重新审查用户名单，旧账本留在原实例上核验 / 收款，不能直接沿用同 ID 白名单。
**无法自动发现同一 URL 上重建的新实例。** 建议为每次部署配置不同的非秘密 `SENTINEL_INSTANCE_ID`；
该 ID 由运维维护，不是上游自动提供的认证指纹。已经绑定的账本不能在事后添加 / 更换 ID 而继续写入。

## 状态说明（重要）

| status | 含义 | 你需要做什么 |
| --- | --- | --- |
| `success` | 加额响应可信且已回读，或已按匹配的上游调账凭据人工确认到账 | 核对凭据后收款；人工恢复的旧流水可能没有历史 `balance_after` |
| `pending` | 已预约请求，但尚未持久化最终结果；进程可能在发送前或发送后中断 | 核对上游调账历史及审计记录，不能只看当前余额 |
| `unknown` | **可能已经加上了，但没拿到可信确认**（超时 / 5xx / 409 / 429 / 异常成功响应） | **必须人工核对**。不会自动重试 |
| `failed` | 收到符合协议的明确拒绝，例如认证或参数错误 | 检查配置及拒绝原因 |

`unknown` 是关键设计：把"不确定"当成"失败"去重试，会造成重复加钱。本项目宁可停下来等人，也不猜。

## 安全模型（请务必读完）

已检查版本中的管理员系统 Key 通过完整的 admin 认证路径，没有“只能读取 / 只能给白名单用户加额”的权限范围。
应把它视为整站高权限凭据，而不是普通用户调用模型的 API Key。其他版本或分支是否支持受限凭据，需另行核实。

因此本项目按"进程被攻破即整站失守"来设计：

1. **Key 只通过受保护的 `.env` 或只读 Secret 文件注入，永不写入数据库、永不打印、永不返回给前端。**
   `/api/config` 只返回是否已配置，不返回 Key 掩码或后缀。
2. **默认只发布到 `127.0.0.1`**。远程访问使用 HTTPS 反向代理，优先叠加 VPN / IP 白名单。
   内置密码登录和可选 TOTP 不应代替网络隔离，更不能承诺“绝对安全”。
3. **CSRF / DNS-rebinding 防护**：所有写操作要求同源 + `X-Sentinel: 1` 头，并校验 `Host` 头。
4. **出站地址锁定**：Key 只会发往 `SUB2API_BASE_URL` 的 origin，代码层面拒绝跳转到其他域名。
5. **白名单**：只有你在页面里显式添加的用户会被加余额。代码不会遍历全站用户。
6. **硬性护栏**（`.env` 可调，但始终生效）：
   - 单笔上限 `GUARD_MAX_TOPUP_PER_EVENT=100`
   - 每用户每日次数 `GUARD_MAX_TOPUPS_PER_USER_PER_DAY=5`
   - 每用户每日金额 `GUARD_MAX_TOPUP_TOTAL_PER_DAY=1000`
   - 连续失败 `GUARD_CIRCUIT_BREAKER_FAILURES=3` 次后熔断，停止写入，需人工重置
7. **急停开关**：页面右上角一键暂停自动加额，状态存在数据库里，重启后依然有效。

### 轮换 Key

如果 Key 曾经出现在聊天记录、截图、日志里，请立刻到 sub2api 后台 **设置 → 管理员 API Key → 重新生成**，然后更新 `.env` 并重启本服务。旧 Key 不会自动失效，必须手动重新生成。

## 两种模式：自动 / 需审批

每个用户可以单独选：

- **自动**：余额低于阈值 → 立即加额；在新增表单中需要主动选择。
- **需审批**：余额低于阈值 → 只在「待审批」页生成一条提议，**不动余额**，点「批准并加额」才真正写入。

页面新增默认选择「需审批」。为兼容现有调用，API / CLI 不传 `mode` 时仍使用 `auto`，自动化客户端应始终明确提交模式。

建议对不熟悉的客户先用「需审批」跑一段时间。审批时有几层保护：

- 同一用户不会堆积多条待审批（重复巡检只保留一条）。
- 批准前会**重新读一次实时余额**；如果用户已经自己充值、余额回到阈值以上，这条提议会自动变为 `expired`，不会重复加钱。
- 一条提议只能被批准一次（并发批准会被拒绝）；用户被停用、删除或设置改变时，旧提议不能继续执行。
- 若进程在审批执行时崩溃，提议保留在 `processing`，不会允许再次批准；请查流水及 Sub2API 后台后人工处理。
- 用户余额自行恢复时，待审批条目会自动关闭，队列不会积压。

## 通知（可选）

配置 `NOTIFY_WEBHOOK_URL` 后，这些事件会推送到企业微信 / 飞书 / 钉钉 / Slack：

| 事件 | 什么时候 |
| --- | --- |
| `topup` | 加额成功（含加额前后余额） |
| `unknown` | 结果未知，需要人工核对（最重要的一条） |
| `failure` | 明确失败，或被安全护栏拦截 |
| `circuit` | 触发熔断 |
| `proposal` | 需审批模式下产生了新的待批提议 |

用 `NOTIFY_FORMAT` 选 `wecom` / `feishu` / `dingtalk` / `slack` / `generic`，用 `NOTIFY_ON` 控制推送哪些。
配置好后点页面右上角「测试通知」即可验证。

通知是**完全不阻塞金钱流程**的：发送失败只会记一条日志，绝不会影响加额本身（有专门测试覆盖）。
企业微信 / 钉钉要求响应明确包含数值 `errcode: 0`；飞书要求数值 `code: 0` 或旧版 `StatusCode: 0`，存在多个字段时必须均为成功。
Slack 要求纯文本 `ok`；上述渠道空响应、畸形或缺少成功字段都会被拒绝。`generic` 仅判断 HTTP 2xx，不承诺对方业务处理结果。
失败日志使用固定脱敏信息，连续同类失败去重，成功恢复后允许再次记录失败。本轮不增加通知重试 / outbox，更不会为了通知重试加额。

## 命令行 / 定时任务

不想常驻服务，也可以用 CLI + cron：

```bash
node server/src/cli.js tick --dry-run    # 只看会发生什么，不写
node server/src/cli.js tick             # 跑一轮
node server/src/cli.js owed              # 谁欠你多少
node server/src/cli.js proposals         # 待审批
node server/src/cli.js approve <id>
node server/src/cli.js verify <topupId>  # 只查询上游调账历史并保存核验结果，不加额
node server/src/cli.js checks <topupId>  # 查看保存的核验凭据
node server/src/cli.js resolve-applied <topupId> --confirm=<topupId>
```

`add <id> <threshold> <amount> --mode=approval` 只创建，不再覆盖已有规则；修改规则请使用页面或带 `ruleRevision` 的 PATCH API。
`users` 列表提供 `REVISION`，CLI 删除必须指定 `remove <id> --revision=<rule_revision>`，旧版本删除不会生效。

cron 示例（每 5 分钟）：

```cron
*/5 * * * * cd /path/to/sub2api-balance-sentinel && /usr/bin/node server/src/cli.js tick >> data/tick.log 2>&1
```

退出码：`0` 正常，`2` 需要人工处理（结果未知 / 被护栏拦截），`3` 加额失败。

## 对账收款流程

系统将两件事分开：**上游加额核对**确认哪一笔调账对应哪次请求；**收款确认**记录客户实际付了多少钱。
标记已收款不会把上游差异改成匹配，核对匹配也不会自动标记客户已付款。目前不接入银行流水或支付平台。

### 逐笔核对 Sub2API

1. 在「加额流水」中点击「核对上游」。只请求该用户的 `balance-history`，不会调用任何余额写接口。
2. 用调账备注中完整的 `sentinel_id=<本地流水 ID>` 精确关联，并核对用户 ID、金额、`admin_balance` 类型、`used` 状态及有效到账时间。
3. 只允许**唯一匹配**。金额不同、用户不同、多个同 ID 记录等会标记 `mismatch`；查无记录为 `not_found`，分页不完整为 `incomplete`，查询异常为 `error`。
4. 每次核对都会追加保存操作者、时间、原流水状态、候选调账凭据、扫描范围及证据 JSON 的 SHA-256，可查看并导出完整核验 CSV。

新版加额流水的 `provider_origin` 保存完整规范化基础地址（包含路径）；旧版只保存 origin 的流水仍可兼容。
账本实例绑定会在上游查询前校验，更换站点或路径不能用新站历史确认旧站加额。旧流水没有地址时，核验凭据会明确将原地址记为空；
只有账本已正确绑定时才允许查询，归属未知的旧账本必须先按「账本与实例绑定」进行本地确认。

一次最多扫描 10 页、每页 100 条。扫描超限、分页总数变化或记录重叠时，即使已找到候选，也不会标记为匹配。
`not_found` **不表示未到账**：已检查的 Sub2API 实现可能在加额成功后写调账历史失败，历史也可能被管理员删除。
旧版哨兵没有在备注中写 `sentinel_id` 的流水，不会按金额相似或余额差进行猜测匹配。

### 未决流水确认到账

对于 `pending` / `unknown` / `failed` 流水，找到唯一匹配后可以点击「确认已到账」：

- 服务器持有与加额共用的跨进程锁，**重新查询**上游，而不是相信浏览器传来的旧核验结果或上游交易 ID。
- 仅凭新查到的唯一匹配凭据，将本地流水改为 `success` 并写入独立的确认记录，不会再次发出加额请求。
- 保留原来的 HTTP 状态、错误、操作者和金额；不知道历史加后余额时保持为空，不把现在的余额伪装成当时余额。
- 新版审批流水保留提议 ID，确认到账会一并结束对应的 `processing` 提议；旧流水缺少关联时不会猜测关联关系。
- 该流水不再属于未决状态后，若没有其他未决流水，该用户可能在下一次巡检恢复正常加额；全局急停、熔断和每日护栏仍有效。

**不提供“一键认定未到账并重试”**。查无记录、金额不符、扫描不完整或请求仍在执行时，均保持原状态及拦截。
这类情况必须通过上游审计 / 数据库只读核查等独立证据处理，不能通过删除流水或重建数据库绕过。
账本内的核验记录有防修改 / 防删除触发器；SHA-256 用于核对导出内容，不是上游签名，也不能抵御拥有数据库文件控制权的人篡改。

### 收款登记

1. 「对账收款」页看到每个用户累计应收取多少、对应哪几笔流水。
2. 收款后点「确认已收款」，或点「导出 CSV」留档。
3. 已对账的流水不会再次计入待收金额，但记录永久保留，可随时查。

流水包含：用户 ID、邮箱、加额前余额、加额金额、加额后余额、触发时的阈值、来源（自动/手动）、
操作者、sub2api HTTP 状态、可获得的上游交易 ID、是否重放、创建时间、对账人、对账状态。CSV 会对文本字段做公式注入转义。

未确认的 `unknown` / `pending` 不进入应收汇总，也不能直接标记已收款；它们会继续阻止该用户的新加额。
「未决处理」独立查询这两种状态，不会因超过 200 条更新的成功流水而丢失入口；它与「加额流水」均支持按用户、状态及分页查阅，页数来自后端总数。
「确认已收款」属于操作者对实际收款的登记，不等于支付平台回执或银行到账证明。

## 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUB2API_BASE_URL` | — | 必填，sub2api 地址 |
| `SENTINEL_INSTANCE_ID` | 空 | 可选非秘密实例标识，最长 200 位字母 / 数字 / `._:-`；必须在首次绑定前确定，同 URL 重建时应使用不同 ID |
| `SUB2API_ADMIN_API_KEY` / `SUB2API_ADMIN_API_KEY_FILE` | — | 必填，管理员 Key；环境变量与 Secret 文件路径二选一 |
| `ALLOW_INSECURE_SUB2API_HTTP` | `false` | 非 loopback 的 HTTP 仅可在受信任隔离网络中显式开启 |
| `SENTINEL_ADMIN_USERNAME` | — | 必填，哨兵登录用户名 |
| `SENTINEL_ADMIN_PASSWORD_HASH` / `SENTINEL_ADMIN_PASSWORD_HASH_FILE` | — | 必填，scrypt 哈希或其 Secret 文件路径，禁止填写明文密码 |
| `AUTH_REQUIRE_TOTP` | `false` | 默认只用密码登录；显式为 `true` 时才要求 TOTP，重启生效 |
| `SENTINEL_ADMIN_TOTP_SECRET` / `SENTINEL_ADMIN_TOTP_SECRET_FILE` | — | 仅启用 TOTP 时必填，Base32 MFA 密钥或其 Secret 文件路径 |
| `SENTINEL_ACCOUNT_KEY` / `SENTINEL_ACCOUNT_KEY_FILE` | — | 仅启用 TOTP 时用于额外账户 MFA 的 32 字节加密密钥，64 位十六进制字符串；明文值与文件路径二选一 |
| `SENTINEL_ACCOUNT_KEY_PATH` | `./secrets/account-key` | 仅 Compose 账户附加配置使用的宿主机密钥文件路径，不是密钥内容 |
| `AUTH_SECURE_COOKIES` | `false` | HTTPS 反向代理必须设为 `true` |
| `AUTH_SESSION_TTL_MS` / `AUTH_IDLE_TIMEOUT_MS` | 8h / 1h | 会话最长寿命 / 空闲超时 |
| `SENTINEL_DB_PATH` | `./data/sentinel.db` | SQLite 流水库位置 |
| `HOST` / `PORT` | `127.0.0.1` / `7788` | 监听地址 |
| `MONITOR_INTERVAL_MS` | `60000` | 后台余额查询间隔，范围 10000 至 86400000；修改后重启 |
| `AUTO_TOPUP_ENABLED` | `false` | `false` = 只观察不写入；确认无误后才改为 `true` |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_URL_FILE` | — | 通知 webhook 或其 Secret 文件路径，留空则关闭 |
| `NOTIFY_FORMAT` | `generic` | `wecom` / `feishu` / `dingtalk` / `slack` / `generic` |
| `NOTIFY_ON` | 见 `.env.example` | 推送哪些事件 |
| `GUARD_*` | 见 `.env.example` | 安全护栏；每日窗口按 UTC 计算 |

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 运行状态（仅返回 Key 是否已配置，不返回 Key 本身或掩码） |
| POST | `/api/auth/login` | 使用 `{username,password}` 创建 HttpOnly 会话 Cookie；仅启用 TOTP 时还需 `otp` |
| POST | `/api/auth/logout` | 撤销当前会话 |
| GET | `/api/auth/session` | 检查登录状态并刷新 CSRF Cookie |
| POST | `/api/auth/enroll/start` | 使用邀请 Token 获取本人的账户开通信息；默认不返回 MFA 密钥，不要求已有会话 |
| POST | `/api/auth/enroll/finish` | `{token,password,otp}` 完成开通；邀请一次性消费，不自动创建登录会话 |
| POST | `/api/auth/password` | 自己改密；`{currentPassword,newPassword,otp}`，撤销所有旧会话 |
| GET | `/api/accounts` | 管理员查看账号元数据，不返回密码哈希、邀请 Token 或 MFA 密文 |
| POST | `/api/accounts` | 管理员邀请 `{username,role,currentPassword,otp}` |
| PATCH | `/api/accounts/:id` | 管理员更新 `{role?,enabled?,version,currentPassword,otp}` |
| POST | `/api/accounts/:id/reinvite` | 管理员重置凭据并重新邀请 `{version,currentPassword,otp}` |
| GET | `/api/users` | 监控列表 + 最近查询余额、时间、过期标记；页面刷新不触发额外上游查询 |
| POST | `/api/users` | 添加监控 `{userId, threshold, amount, mode}`；重复返回 `409`，绝不覆盖 |
| PATCH | `/api/users/:id` | 修改阈值/金额/启停/模式；必须含 `ruleRevision`，冲突 `409` |
| DELETE | `/api/users/:id` | 请求体必须含 `ruleRevision`；停止监控且保留历史流水，冲突 `409` |
| POST | `/api/users/:id/topup` | 手动加额 `{amount}` |
| GET | `/api/proposals` | 待审批列表 |
| POST | `/api/proposals/:id/approve` | 批准并加额 |
| POST | `/api/proposals/:id/reject` | 拒绝 |
| POST | `/api/notify/test` | 发送测试通知 |
| GET | `/api/records` | `{items,total,limit,offset}`；支持 `userId,status,limit,offset`，`status=unresolved` 查询 pending / unknown |
| GET | `/api/records.csv` | 导出完整加额流水（含失败/未知/对账字段） |
| POST | `/api/records/:id/verify` | 查询上游余额历史，追加核验凭据，不改变加额状态 |
| GET | `/api/records/:id/checks` | 查看最近 100 条核验 / 确认凭据 |
| GET | `/api/records/:id/checks.csv` | 导出该流水的全部核验凭据 |
| POST | `/api/records/:id/resolve` | `{decision:"applied",confirmation:"流水 ID"}`；重新核验匹配后确认到账，绝不补发 |
| POST | `/api/records/:id/reconcile` | 人工标记实际收款；不会改变上游核验结果 |
| GET | `/api/reconciliation` | 待收款汇总 |
| GET | `/api/reconciliation.csv` | 导出 CSV |
| GET | `/api/events` | 运行日志 |
| POST | `/api/kill-switch` | 急停 `{on}` |
| POST | `/api/circuit-breaker/reset` | 重置熔断 |
| POST | `/api/tick` | 立即巡检一次 |

除登录及基于能力 Token 的开通接口外，写操作还必须携带有效登录会话、`X-Sentinel: 1` 和会话绑定的 `X-CSRF-Token`。
账户管理写操作和自己改密还需要当前密码；仅启用 TOTP 时才还需要未使用的新动态码。审计员不能执行任何业务写操作。

## 测试

```bash
npm test
```

测试覆盖：登录与 CSRF、Secret 文件配置、阈值边界与浮点噪声、白名单隔离、重复巡检不重复加钱、每日上限、
`unknown` 状态不被自动重试、熔断与急停、对账结清、4xx/5xx/超时/429 的错误分类、
审批模式不写余额、提议不可重复批准、过期提议不执行、通知失败不影响加额、旧库自动迁移，
以及等待期间跨连接停用 / 删除 / 改规则 / 急停 / 熔断、锁被回收、HTTP 200 异常内容不产生应收。
逐笔对账测试覆盖标记精确匹配、金额 / 用户 / 类型差异、重复凭据、分页变动 / 截断、证据持久化与防改、
并发确认、旧结果失效、未决流水确认不补发、原始错误保留及审批提议关联。
账户测试覆盖一次性邀请、加密密钥与账户绑定、邀请到期 / 取消 / 并发消费、直接 HTTP 权限矩阵、二次认证、
默认密码登录 / 无 MFA 密钥开通、跨 IP 密码限流、并发邀请消费，以及可选 TOTP 的防重放与失败关闭；
还覆盖改密 / 降权 / 停用撤销、认证等待期间停用、重启保留 MFA 重放状态，以及等待上游期间撤权不再加额。

### 真实源码隔离联调

`npm test` 默认不会连接任何真实服务。另有显式运行的集成工具，需要 Python 3.12+、已安装项目依赖的 Node 和 Docker：

```bash
python3 -B -m unittest discover -s scripts/integration -p '*_test.py' -v
python3 scripts/integration/run-real-sub2api.py \
  --source /path/to/local/sub2api \
  --ref 378984d87 \
  --report /tmp/sub2api-integration-result.json
```

工具只从指定 Git 提交归档受跟踪的 `backend` 源码，不复制上游工作区的 `.env` 或运行数据，也不启动上游现有 Compose。
首次运行会下载编译工具链 / 依赖并构建 API 专用镜像；Go 编译并发限制为 2，包编译串行，仍需要足够的 Docker 磁盘和内存。
运行阶段创建独立的内部网络、PostgreSQL、Redis 和 Sub2API，**不发布任何测试端口**。
引导请求与哨兵探针在当前项目镜像内运行，仅共享本次新建 API 的网络命名空间，通过容器内 loopback 访问。
探针只挂载不含 `.env` 的临时源码副本，数据库与管理员凭据全部随机生成，不会写进报告。
数据库 / API 启动配置经权限为 `600` 的临时文件注入；引导请求与探针的密码 / Token 仅从标准输入传入，
这两个任务关闭容器日志驱动，不把请求凭据放进命令参数或普通任务日志。

对于已检查版本的管理员合规门控，工具先验证 HTTP 423 拒绝，再仅在新建的测试数据库中注入明确标记为
`SYNTHETIC TEST FIXTURE` 的虚构管理员状态；**这不是用户签署协议，也不会替真实管理员接受任何条款**。
生产门控必须由部署者阅读并自行处理。

探针验证自动固定加额、白名单、审批与重复批准、同 Key 重放、真实余额历史逐笔匹配、本地收款记账，
以及代理在上游完成加额后丢弃响应时的 `unknown` 拦截与“不补发”的人工核实流程。
结束时删除本次创建的容器、数据卷、网络和临时凭据；构建镜像保留供复查。JSON 报告记录实际提交、镜像 ID、
断言及清理结果，不覆盖已有报告。集成工具不会打包进生产镜像。

2026-10-22 已对本地 Sub2API 源码 `378984d87f2b68db15626ae8f18b9e923ab82b85` 完成上述隔离联调，
使用 PostgreSQL 18、Redis 8 和当前哨兵 Node 22 镜像。7 组业务断言及合规门控检查通过，临时运行资源已清理。
默认改为密码登录后又完成一次同版本联调，可审查证据为 `scripts/integration/real-sub2api-result-2026-10-22-password-only.json`，其中记录实际镜像 ID。
前两次工具运行分别遇到 Docker 内部网络不发布端口、PostgreSQL 临时初始化 socket 就绪过早的问题；对应失败报告仍保留，
工具现已改为无端口的容器内部探测并等待数据库 TCP 就绪。**这些结果不代表你的既有服务器已验证或已部署**。

逐项需求验收和部署边界见 `docs/acceptance.md`。停止流程回归另外覆盖首次定时器取消、停止后不再加额 / 创建审批、
排队请求取消、已发出请求完成回读、延后启动的通知、关闭数据库的顺序与截止时间，以及真实子进程接收重复 `SIGTERM`。

## 已知限制

- 角色是整个哨兵范围内的权限划分，不支持租户隔离或“只管理指定客户”的细粒度授权。操作员属于有财务权限的可信人员。
- 配置式初始管理员的密码重置仍通过替换 `SENTINEL_ADMIN_PASSWORD_HASH` 并重启完成；普通账户使用页面改密或管理员重新邀请。
- 账户邀请和重置需要受邀者自行保管认证器；目前不提供邮件发送、SMS、SSO 或一次性恢复码。请保留初始管理员的受保护恢复材料。
- 轮询间隔决定了最坏延迟：用户可能在两次轮询之间把余额花成负数（sub2api 允许余额为负时限额）。
  如果需要更实时，可调小 `MONITOR_INTERVAL_MS`。
- 页面每 15 秒刷新本地状态，不会因此额外查询 Sub2API。添加用户校验、手动巡检、连接测试和实际加额前后的安全复查属于显式操作，会额外查询。
  余额缓存仅存于内存，重启后等待首次巡检；失败时保留上次成功时间并标记过期，不把旧值冒充实时余额。
- 单元测试使用 HTTP mock；另已通过指定源码版本的隔离真实 API 联调，尚未连接用户现有 Sub2API 部署、进行生产部署或完成独立安全审计。
- 依赖 sub2api 的 `POST /api/v1/admin/users/:id/balance` 接口；升级后先关闭自动加额，再以测试用户验证实际接口、幂等与历史记录。
  `npm test` 只能验证本地实现，不等于服务器兼容性验证。
