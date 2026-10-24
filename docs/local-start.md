# 本地启动（不使用 Docker）

这份文档用于在自己的电脑上直接运行余额哨兵。只需要 Node.js 和 npm，不需要 Docker、PostgreSQL、Redis，也不需要连接 Sub2API 的数据库。

运行结构：浏览器访问本地哨兵 → 哨兵调用 Sub2API 管理 API → 哨兵将账户、规则、流水和核验记录保存在本地 SQLite。

服务器容器部署见 [Docker 部署文档](docker-deploy.md)；账户权限、可选 TOTP 和对账规则见 [README](../README.md)。

## 1. 准备环境

- 推荐 Node.js 22，与项目 Docker 镜像的运行版本一致；npm 随 Node.js 安装。
- 准备一个可访问的 Sub2API 地址和管理员 API Key；没有真实服务时可以用第 6 节的模拟服务。
- 管理员 Key 是 Sub2API 的高权限凭据，不是普通用户调用模型的 API Key。只在自己电脑上的受保护文件中填写，不要发送到聊天或提交到 Git。

在项目根目录执行：

```bash
cd /Users/bary/code/tools/sub2api-balance-sentinel
node --version
npm --version
npm ci --include=dev
```

其他电脑将 `cd` 路径替换为实际源码目录。`npm ci` 按锁文件安装依赖，也会重新生成 `node_modules`；不需要在 `server/`、`web/` 中分别安装。

`better-sqlite3` 包含原生模块。只有安装时提示缺少编译工具，才补装工具后重试：macOS 使用 `xcode-select --install`；Debian / Ubuntu 使用 `sudo apt-get install python3 make g++`。不要用 `sudo npm ci`。

## 2. 创建配置与登录密码

### 2.1 创建 `.env`

```bash
# 已有 .env 时不会覆盖；后续直接编辑原文件。
test -f .env || cp .env.example .env
chmod 600 .env
```

后端会自动读取项目根目录的 `.env`，不需要执行 `source .env` 或安装 dotenv。已有同名进程环境变量优先于 `.env`；如果改了文件却未生效，检查启动终端是否曾 `export` 同名变量。

### 2.2 生成密码哈希

运行下面的命令，输入自己的哨兵登录密码，至少 12 个字符。输入不回显，明文密码不会写入命令历史；整个命令在 Bash 子进程中执行，因此也适用于 macOS 默认的 zsh：

```bash
bash -c 'IFS= read -r -s -p "Sentinel password: " password; printf "\n"; printf "%s" "$password" | node server/src/hash-password.js'
```

把输出的完整 `scrypt:...` 字符串填入 `SENTINEL_ADMIN_PASSWORD_HASH`。不要填明文密码，也不要只复制其中一段。这个账号是哨兵自己的初始管理员，不是 Sub2API 登录账号。

### 2.3 编辑 `.env`

以下是连接真实 Sub2API 的最小配置示意；替换地址、Key 和哈希，不要直接保留占位内容：

```ini
SUB2API_BASE_URL=https://sub2api.example.com
SUB2API_ADMIN_API_KEY='替换为 Sub2API 管理员 API Key'
SUB2API_ADMIN_API_KEY_FILE=
ALLOW_INSECURE_SUB2API_HTTP=false
SENTINEL_INSTANCE_ID=sub2api-prod-1

SENTINEL_ADMIN_USERNAME=admin
SENTINEL_ADMIN_PASSWORD_HASH='替换为刚生成的完整 scrypt 哈希'
SENTINEL_ADMIN_PASSWORD_HASH_FILE=
AUTH_REQUIRE_TOTP=false
AUTH_SECURE_COOKIES=false
ALLOWED_HOSTS=

HOST=127.0.0.1
PORT=7788
SENTINEL_DB_PATH=./data/sentinel.db
MONITOR_INTERVAL_MS=60000
AUTO_TOPUP_ENABLED=false
```

- `SUB2API_BASE_URL` 填完整部署基础地址；部署在子路径时保留它，例如 `https://sub2api.example.com/base/path`。不要额外附加 `/api/v1/admin`、登录凭据、查询参数或 fragment。上游 API 路径由哨兵补上。
- `SENTINEL_INSTANCE_ID` 是运维自己维护的非秘密实例标识，示例值应替换为实际值；也可以在首次绑定前留空。推荐首次部署就设置并记录它，绑定后不能再添加 / 修改；轮换管理员 Key 不需要修改它。
- HTTPS 是首选；电脑本机的 `http://127.0.0.1:8080` 不需要开启不安全 HTTP。只有受信任、隔离私网的非本机 HTTP，才显式设置 `ALLOW_INSECURE_SUB2API_HTTP=true`，不要用于公网。
- 本机 HTTP 保持 `AUTH_SECURE_COOKIES=false`、`ALLOWED_HOSTS=` 和 loopback 监听。不要为了在局域网登录把 `HOST` 改为 `0.0.0.0`。
- 默认不需要动态码，也不需要生成账户加密密钥；只有主动启用 TOTP 才需要额外配置。
- 普通秘密变量和对应的 `_FILE` 路径只能二选一。旧配置如果已有 `_FILE`，不要同时再填明文值。

可先执行不访问上游、不打开数据库的配置校验：

```bash
node --input-type=module -e "import { assertConfigured } from './server/src/config.js'; assertConfigured(); console.log('Configuration OK');"
```

### 2.4 账本与上游实例必须对应

全新空库会绑定规范化后的**完整**基础地址和实例 ID：保留基础路径，忽略末尾斜杠及默认端口等价差异。更换域名、端口、路径或实例 ID，不会自动改绑旧账本。即使两个站点存在相同用户 ID，也不能共用原监控白名单。

实例不匹配或旧库未绑定时，哨兵仍可启动、登录和查看本地账本，但会显示阻断提示；余额查询、连接测试、身份同步、规则新增 / 编辑 / 删除，以及自动 / 手动 / 审批加额均被禁止。核验也不会查询错误站点。不要删除数据库或直接修改绑定设置来消除提示；旧库升级按第 4.1 节确认。

绑定不是上游认证指纹，**无法自动识别同一 URL 上重建的另一个实例**。上游重建时应换实例 ID 并使用独立新账本，重新审查用户；旧账本保留用于原实例对账。已绑定的旧账本不能改 ID 后继续写入。

## 3. 构建并启动

```bash
npm run build:web
npm start
```

保持这个终端运行，然后打开 <http://127.0.0.1:7788>，使用刚配置的用户名和原始密码登录，不是输入密码哈希。

这是一个后端进程同时提供 API 和构建好的网页，不用再启动前端服务。`npm start` 不会自动构建前端；首次运行、拉取前端更新或修改前端后，需要重新运行 `npm run build:web`。

另开终端检查进程存活：

```bash
curl --fail --silent --show-error http://127.0.0.1:7788/healthz
```

应返回包含 `"ok":true` 的 JSON。这个接口只说明哨兵 HTTP 进程可响应，不证明 Sub2API 可访问、Key 有效或余额查询正确。

首次登录后的检查顺序：

1. 保持 `AUTO_TOPUP_ENABLED=false`，此时包括手动和审批在内的加额都被配置开关阻止。
2. 在监控页面添加一个自己确认过的测试用户 ID，核对用户名和邮箱，设置阈值、固定加额及模式；网页新增默认「需人工审批」。已有用户请直接编辑，重复添加返回 `409`，不会恢复停用状态或覆盖审批模式、备注。
3. 点「立即巡检」，核对查询余额和时间；后台默认每 60 秒查询一次，网页刷新只读取缓存。
4. 确认上游实际 API、幂等去重、余额历史和金额单位符合预期，再考虑开放加额。
5. 只有明确准备好执行真实余额写入时，才把 `.env` 中的 `AUTO_TOPUP_ENABLED` 改为 `true` 并重启。先以测试用户和「需审批」模式验证，再按需切换自动模式。

即使用户规则为自动模式，配置写开关关闭时也不会加额。配置写开关开启后，低余额的自动模式用户可能在启动后首次巡检时就被加额；不要用真实用户做不受控演示。

编辑、启停、切换模式和删除带规则版本检查；旧页面遇到 `409` 时，刷新监控列表、核对当前设置后重新编辑，不要不断重发旧请求。规则修改会使旧待审批提议过期，需要重新巡检。操作员在上游身份查询等待期间被停用 / 降权 / 重置后，旧请求也不能继续保存。

「加额流水」支持按用户 ID、状态筛选及分页；已移除监控的用户也能按 ID 找到历史。「未决处理」单独列出全部 `pending` / `unknown`，不会被最近 200 条成功记录挤掉。先点「核对上游」、查看 / 导出「证据」，只有新鲜且唯一匹配的凭据才能「确认已到账」。该操作只修正本地账本，不会补发加额；解除未决拦截后可能恢复该用户自动加额，处理前先保持写开关关闭或启用全局急停。

通知可按 [README 的通知配置](../README.md#通知可选) 设置 `NOTIFY_FORMAT` 和 webhook；默认 URL 为空，不发送通知。服务商格式会校验其成功响应；`generic` 只说明 HTTP 请求成功，不证明接收端完成业务处理。通知失败不会回滚 / 补发加额，不能把消息有无当作余额到账凭据。

## 4. 停止、重启和保存数据

- 停止：在 `npm start` 终端按 `Ctrl+C`，等待进程退出。
- 重启：正常停止后，再执行 `npm start`。修改 `.env`、查询频率或初始管理员密码哈希都需要重启。
- 更新源码：先关闭写开关并停止，更新后运行 `npm ci --include=dev`、`npm run build:web`，再启动并核验。
- 数据：默认保存为项目根目录的 `data/sentinel.db`，目录和数据库自动创建；不需要手工初始化 SQL。

不要删除 `data/` 来解决登录或启动问题，其中不仅有流水，还包含监控规则、额外账户、核验与收款记录，以及防重复加额所需的未决状态。

### 4.1 升级已有未绑定账本

先正常停止使用同一账本的**全部**进程，包括后端、开发模式的 watch 进程、CLI、cron / systemd / launchd 等定时任务；按第 4.2 节备份。保留原完整基础地址，设置 `AUTO_TOPUP_ENABLED=false`；只有尚未绑定的旧库，才可在此时首次设置实例 ID。

更新依赖和前端后，在可信本地终端执行以下命令。`--confirm` 替换为规范化后的完整基础地址，不带末尾斜杠；命令只确认本地绑定，不发送上游请求：

```bash
AUTO_TOPUP_ENABLED=false node server/src/cli.js bind-instance --confirm=https://sub2api.example.com/base/path
```

命令使用当前 `.env` 与 `SENTINEL_DB_PATH`，不会要求输入网页密码。它不能重新绑定已绑定但不匹配的库；历史流水记录了另一地址时也会拒绝。旧流水仅有 origin 或没有地址时，命令无法证明基础路径 / 实例归属，必须自行核实来源，不能把成功输出当作归属证明。

确认后先观察模式 `npm start`，核对名单、余额与未决流水，再决定是否恢复写入。确实迁移到新站点时，另建独立账本并重新审查用户，不要对原账本运行改绑操作。

### 4.2 停机备份

简单备份时，先停止后端以及所有使用同一个账本的 CLI / 定时任务，防止备份期间被自动拉起，再复制整个 `data/` 目录到受保护位置，例如：

```bash
# 仅在所有账本使用者已正常停止后执行。
(
  set -e
  umask 077
  backup_dir="$HOME/sentinel-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$HOME/sentinel-backups"
  mkdir "$backup_dir"
  chmod 700 "$backup_dir"
  cp -pR data "$backup_dir/data"
  cp -p .env "$backup_dir/.env"
  printf 'Backup completed: %s\n' "$backup_dir"
)
```

子进程在复制失败时会停止；只有显示完成且已核验文件完整才认为备份成功。如果自定义了 `SENTINEL_DB_PATH`，改为备份对应数据库目录。SQLite 使用 WAL，运行中只复制 `sentinel.db` 可能漏数据；不要将这种复制当作一致性备份。启用 TOTP 时，账户加密密钥也需另行保护备份。

正常停止会等待已发出的请求完成回读和记账；默认等待窗口为 45 秒，并随 `REQUEST_TIMEOUT_MS` 调整。不要常规使用 `kill -9`。断电、强杀或网络超时后出现 `pending` / `unknown`，要先核对上游历史，不能直接重新加额。

### 4.3 恢复到独立目录

1. 保留当前账本 / 故障现场，关闭写开关并停止全部账本使用者及定时任务。确认备份来自目标实例、完整且可信；不要在运行中覆盖 SQLite。
2. 将备份复制到**新的空目录**，保留原目录用于回退。下面示例针对默认 `data/sentinel.db`，自定义路径需相应调整：

```bash
# 替换为已核实的备份目录；不要直接整段恢复旧 .env。
backup_dir=/protected/sentinel-backup
restore_dir="$HOME/sentinel-restore/$(date +%Y%m%d-%H%M%S)"
umask 077
test -f "$backup_dir/data/sentinel.db" &&
  mkdir -p "$HOME/sentinel-restore" &&
  chmod 700 "$HOME/sentinel-restore" &&
  mkdir "$restore_dir" &&
  chmod 700 "$restore_dir" &&
  cp -pR "$backup_dir/data" "$restore_dir/data"
```

示例仅给恢复父目录使用 `mkdir -p`；创建实际目标的 `mkdir` 刻意不使用 `-p`，目标已经存在就停止，避免覆盖。只有复制成功才继续。

3. 编辑当前 `.env`：将 `SENTINEL_DB_PATH` 设为恢复数据库的**实际绝对路径**，保留与备份相同的完整基础地址 / 实例 ID，明确设置 `AUTO_TOPUP_ENABLED=false`。不要直接恢复旧 `.env` 中可能为 `true` 的写开关。需要恢复秘密时通过受保护方式取回；TOTP 加密密钥必须与数据库匹配。
4. 可以只对恢复文件做 SQLite 完整性检查，不启动哨兵、不访问上游：

```bash
node --input-type=module - "$restore_dir/data/sentinel.db" <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
  const result = db.pragma('integrity_check', { simple: true });
  if (result !== 'ok') throw new Error('SQLite integrity check failed');
  console.log('SQLite integrity OK');
} finally {
  db.close();
}
NODE
```

5. 检查配置后以观察模式启动，核对账户、监控规则、流水和「未决处理」。未绑定的旧快照按第 4.1 节确认归属。完整性检查只说明数据库可读，不证明账本完整或属于该实例。

**恢复旧快照不会回滚上游余额。** 必须独立核对快照之后的全部上游加额、未决请求和收款，保留缺失流水的对账材料；不能仅因未决页为空就重新开放写入，也不能用补发或「标记已收」补齐丢失账本。尚未完成对账时，保持写开关关闭。

## 5. 开发模式：前端热更新

只有需要修改网页时才使用两个终端；只是使用哨兵时，第 3 节的单进程方式更简单。

终端 A，在项目根目录：

```bash
PUBLISHED_PORTS=5173 npm run dev:server
```

终端 B，在同一目录：

```bash
npm run dev:web
```

打开 <http://127.0.0.1:5173>。Vite 把 `/api` 代理到 `http://127.0.0.1:7788`，因此开发模式下后端保留 `PORT=7788`。

这里的 `PUBLISHED_PORTS=5173` 用于让后端接受开发网页的 loopback Host，不会发布额外端口。不要用 `ALLOWED_HOSTS=127.0.0.1:5173` 代替：该配置用于远程 HTTPS，会要求 Secure Cookie。若 5173 被占用，应先释放它，避免 Vite 切到一个尚未允许的端口。

开发模式仍使用当前 `.env`、数据库和真实上游，热更新不等于沙盒。保持写开关关闭，或按下一节切换到模拟服务与独立测试账本。

## 6. 没有真实 Sub2API：用本机模拟服务

先正常停止哨兵，备份当前 `.env` 的接入配置；演示用独立账本，避免把真实流水和模拟流水混在一起。

终端 A，在项目根目录启动模拟服务：

```bash
node scripts/mock-sub2api.js
```

默认只监听本机 8080，提供 3 个虚构用户：用户 1 / alice 余额 5、用户 2 / bob 余额 88、用户 3 / carol 余额 0。测试 Key 固定为 `admin-mock-key-for-local-testing`，不可作为真实服务凭据。

在 `.env` 中替换以下配置，保留第 2 节生成的哨兵账号和密码哈希：

```ini
SUB2API_BASE_URL=http://127.0.0.1:8080
SUB2API_ADMIN_API_KEY=admin-mock-key-for-local-testing
SUB2API_ADMIN_API_KEY_FILE=
ALLOW_INSECURE_SUB2API_HTTP=false
SENTINEL_INSTANCE_ID=local-mock-1
SENTINEL_DB_PATH=./data/mock-sentinel.db
AUTO_TOPUP_ENABLED=false
NOTIFY_WEBHOOK_URL=
NOTIFY_WEBHOOK_URL_FILE=
```

终端 B 执行 `npm run build:web`、`npm start`，登录后添加用户 `1`，设阈值 `10`、固定加额 `100`、模式「需审批」。先巡检并确认余额是 `5`，写开关关闭时不会加额。

只有要验证模拟加额时，将 `AUTO_TOPUP_ENABLED=true`，重启哨兵并巡检，然后在「待审批」批准一次。模拟余额应从 `5` 变为 `105`，流水页产生记录；「核对上游」可以查询模拟调账历史。这不是对真实 Sub2API 的接入验证。

演示结束后停止两个进程，恢复真实地址、Key、**原实例 ID**、数据库路径及通知配置，并把 `AUTO_TOPUP_ENABLED=false` 恢复后再启动。模拟余额和调账历史只保存在模拟进程内存里，重启模拟服务会重置；测试 SQLite 则会保留旧记录，因此跨模拟重启的流水不一定还能匹配。新一轮演示应同时使用新的测试账本路径与实例 ID，例如 `./data/mock-sentinel-2.db` 和 `local-mock-2`，不要删除旧流水解除未决拦截。

如果 8080 已被占用，可以使用 `PORT=9099 node scripts/mock-sub2api.js`，并相应修改 `SUB2API_BASE_URL`；不要改变哨兵自己的 `PORT`。

## 7. 常见问题

| 现象 | 检查方向 |
| --- | --- |
| 启动提示 `Invalid configuration` | Key、完整密码哈希、秘密来源冲突、HTTP / HTTPS、用户名；按错误逐项检查，不要贴出真实秘密 |
| 访问 7788 没有页面，但健康检查正常 | 先执行 `npm run build:web`；`web/dist` 未生成时后端只提供 API |
| 登录或写操作被拒绝 | 本机用 `127.0.0.1`；检查 Secure Cookie、Host / Origin、旧 Cookie 和当前认证模式 |
| 开发页面 API 返回 `Unexpected Host header` | 后端使用 `PUBLISHED_PORTS=5173 npm run dev:server`，并确认 Vite 没有换端口 |
| `EADDRINUSE` | 已有进程占用端口；先识别并正常停止，不要盲目强杀。单进程模式可以改 `PORT` 并重启 |
| `better-sqlite3` 加载 / ABI 错误 | 切换 Node.js 版本后在该版本下重新运行 `npm ci --include=dev`；必要时补齐原生编译工具 |
| 查询失败、401 / 403 | 确认部署根地址和管理员系统 Key，而不是普通用户 Key；不要据此重发加额 |
| 顶部实例绑定阻断 / `Ledger is unbound` | 核实完整基础地址、原实例 ID 和账本路径；旧库按第 4.1 节本地确认，已绑定但不匹配不能改绑 |
| 重复添加 / 编辑返回 `409` | 已有用户直接编辑；规则已变化时先刷新列表再确认，不要重发旧版本 |
| 低余额却没有加额 | 检查写开关、用户是否启用、模式、阈值、单笔 / 每日护栏、急停、熔断及未决流水 |
| `unknown` / `pending` | 进入「未决处理」，按用户筛选并翻页核对上游及凭据；不能只看当前余额，也不能删除流水或直接补发 |

代码回归可运行 `npm test`；默认测试不连接真实 Sub2API。它不能代替实际部署版本的接口兼容性核验。这份文档中的启动、备份与恢复是操作流程，不表示已经在你的电脑 / 真实服务上执行或演练成功。
