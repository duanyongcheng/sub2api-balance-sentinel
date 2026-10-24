# Docker 部署

这份文档用于将余额哨兵部署到服务器；本机直接运行、不使用 Docker，见 [本地启动文档](local-start.md)。

基础 Compose 只运行哨兵一个容器，不会部署 Sub2API，也不会启动 PostgreSQL 或 Redis。哨兵通过管理 API 访问已有 Sub2API，自己的账本保存在独立 SQLite 数据卷。

## 1. 前置条件和文件

- 服务器安装 Docker Engine 和 Docker Compose v2，`docker compose version` 可用。
- 准备本项目完整源码，包含 `package-lock.json`、`Dockerfile`、Compose 文件、`server/`、`web/` 和 `shared/`。
- 准备可从容器访问的 Sub2API 根地址、管理员系统 API Key，以及哨兵自己的管理员密码。
- 确定访问方式：宿主机本地访问 / SSH 隧道，或 HTTPS 反向代理。不要直接将高权限管理页面发布到公网。

项目自带配置：

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | Node.js 22 多阶段构建，构建前端并保留生产依赖，以 UID 1000 的 `node` 用户运行 |
| `docker-compose.yml` | 基础部署，loopback 发布、账本卷、健康检查、日志轮转及安全限制 |
| `docker-compose.proxy.yml` | 可选，将哨兵接入已有反向代理 Docker 网络 |
| `docker-compose.accounts.yml` | 仅启用 TOTP 时，可选挂载额外账户的 MFA 加密密钥；密码模式不需要 |

以下命令均从服务器的项目根目录执行，例如：

```bash
cd /opt/sub2api-balance-sentinel
docker version
docker compose version
```

把示例源码目录、域名和网络名替换为实际值。镜像在服务器构建，不要求在宿主机安装 Node.js 或 npm，也不用先在宿主机构建网页。

## 2. 配置 `.env`

```bash
test -f .env || cp .env.example .env
chmod 600 .env
```

已有 `.env` 不要覆盖。固定 Compose 项目名有助于保持卷名称稳定，建议在首次部署的 `.env` 中设置 `COMPOSE_PROJECT_NAME=sub2api-balance-sentinel`；已经部署过的实例应沿用原项目名，不能直接改名。

需要附加文件时，用 `.env` 中的 `COMPOSE_FILE` 固定完整文件列表，Linux / macOS 使用冒号 `:` 分隔。后续 `config`、`build`、`up`、`stop`、`run`、备份和恢复均沿用这套配置；不要只在某一次 `up` 临时加 `-f`，后续却遗漏 Secret / 网络 / 卷配置。终端已导出的同名变量优先于 `.env`，也需要核实。

最小配置示意：

```ini
COMPOSE_PROJECT_NAME=sub2api-balance-sentinel
SENTINEL_PORT=7788

SUB2API_BASE_URL=https://sub2api.example.com
SUB2API_ADMIN_API_KEY='替换为 Sub2API 管理员 API Key'
SUB2API_ADMIN_API_KEY_FILE=
ALLOW_INSECURE_SUB2API_HTTP=false
SENTINEL_INSTANCE_ID=sub2api-prod-1

SENTINEL_ADMIN_USERNAME=admin
SENTINEL_ADMIN_PASSWORD_HASH='替换为生成器输出的完整 scrypt 哈希'
SENTINEL_ADMIN_PASSWORD_HASH_FILE=
AUTH_REQUIRE_TOTP=false
AUTH_SECURE_COOKIES=false
ALLOWED_HOSTS=

AUTO_TOPUP_ENABLED=false
MONITOR_INTERVAL_MS=60000
```

这里的 `AUTH_SECURE_COOKIES=false` 仅用于本机 HTTP / SSH 隧道访问。配置 HTTPS 代理时按第 4 节改为 `true` 并填写域名。

`SUB2API_BASE_URL` 是完整部署基础地址，子路径部署必须保留 `/base/path`；不要附加 `/api/v1/admin`、凭据、查询参数或 fragment。全新空账本会绑定规范化后的完整地址及可选实例 ID，基础路径不会被丢弃；默认端口、末尾斜杠等价差异不影响绑定。

`SENTINEL_INSTANCE_ID` 是运维维护的非秘密标识，示例值应替换为实际值，推荐首次部署就设置并记录，也可在首次绑定前留空。已绑定后不能添加 / 更换 ID。更换域名、端口、路径或实例 ID 会阻止上游操作，而轮换管理员 Key 不改变绑定。**同 URL 上重建的新实例无法自动识别**；重建时应换 ID 和独立新账本，重新审查用户，不能沿用旧站同 ID 白名单。旧库升级见第 6 节。

### 生成哨兵密码哈希

在可信电脑上，使用至少 12 字符的密码运行 [本地文档中的密码生成命令](local-start.md#22-生成密码哈希)，然后通过受保护方式将完整哈希写入服务器 `.env`。禁止在命令参数中直接放明文密码。

如果服务器只有 Docker，也可以先构建镜像，再利用独立容器里的生成器；它不会启动哨兵、挂载生产账本或读取宿主机 `.env`。Dockerfile 声明了 `/data` 的 `VOLUME`，此命令可能创建匿名临时卷，但不会打开账本，容器退出时 `--rm` 会一并清理该匿名卷：

```bash
docker build -t sub2api-balance-sentinel:latest .
bash -c 'IFS= read -r -s -p "Sentinel password: " password; printf "\n"; printf "%s" "$password" | docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint node sub2api-balance-sentinel:latest server/src/hash-password.js'
```

默认 `AUTH_REQUIRE_TOTP=false`，不需要动态码或账户加密密钥，基础 Compose 即可创建额外账户。

### 容器里的上游地址

**`127.0.0.1` 在容器里表示哨兵容器自身，不是宿主机，也不是其他容器。** 不要直接沿用 `.env.example` 中的本机模拟地址。

| Sub2API 在哪里 | 哨兵应使用的地址 |
| --- | --- |
| 已有 HTTPS 部署 | `https://sub2api.example.com`，确保容器 DNS、网络和证书可用 |
| 同一受信任 Docker 网络 | `http://sub2api:8080` 等实际服务名和容器内部端口，哨兵必须加入该网络；仅隔离私网 HTTP 才开启 `ALLOW_INSECURE_SUB2API_HTTP=true` |
| Docker Desktop 宿主机 | `host.docker.internal` 可用于访问宿主机，但需确认监听地址可达；生产优先使用 HTTPS |
| Linux 宿主机 | 不保证内置 `host.docker.internal`，需要自定义 `extra_hosts: ["host.docker.internal:host-gateway"]` 并确认上游监听 / 防火墙，或直接使用可达 HTTPS 地址 |

仅绑定宿主机 `127.0.0.1` 的上游，通常不能从 Linux bridge 容器访问。不要为了绕过地址问题随意改成 host 网络或向公网开放 Sub2API 管理端口。

若 Sub2API 已加入隔离 Docker 网络，可创建不含秘密的 `docker-compose.sub2api.local.yml`，将哨兵加入**同一个既有网络**：

```yaml
services:
  sentinel:
    networks:
      - default
      - sub2api

networks:
  sub2api:
    external: true
    name: ${SENTINEL_SUB2API_NETWORK}
```

核实上游容器实际加入的网络、该网络里的 DNS 服务名及容器内部端口，再填写 `.env`，例如：

```ini
SENTINEL_SUB2API_NETWORK=sub2api_private
COMPOSE_FILE=docker-compose.yml:docker-compose.sub2api.local.yml
SUB2API_BASE_URL=http://sub2api:8080
ALLOW_INSECURE_SUB2API_HTTP=true
```

`sub2api_private`、`sub2api`、`8080` 均是示例，不是项目保证的名称。可用 `docker network inspect sub2api_private --format '{{.Name}}'` 只核实网络存在；还需确认上游已在其中。配置为 `external: true`，不要凭空创建同名网络来绕过不存在的报错。已有 Secret / 代理附加文件时，保留它们并在完整 `COMPOSE_FILE` 列表中追加本文件。

### Secret 文件可选方案

简单部署可使用权限 `600` 的 `.env`。这种方式会把秘密作为容器环境变量注入，能管理 Docker daemon 的用户可以查看，应严格限制 Docker 权限。

若使用 `_FILE`，需自行添加 Secret 或只读挂载；只填路径不会自动挂载文件。例：新建不含秘密值的 `docker-compose.secrets.local.yml`：

```yaml
services:
  sentinel:
    environment:
      SUB2API_ADMIN_API_KEY: ""
      SUB2API_ADMIN_API_KEY_FILE: /run/secrets/sub2api-admin-key
      SENTINEL_ADMIN_PASSWORD_HASH: ""
      SENTINEL_ADMIN_PASSWORD_HASH_FILE: /run/secrets/sentinel-password-hash
    volumes:
      - type: bind
        source: ./secrets/sub2api-admin-key
        target: /run/secrets/sub2api-admin-key
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ./secrets/sentinel-password-hash
        target: /run/secrets/sentinel-password-hash
        read_only: true
        bind:
          create_host_path: false
```

部署者提前通过受保护方式创建两个文件，分别写入 Key、完整密码哈希；不要把秘密直接写在命令参数中。Linux 上需让容器内 UID 1000 能读取文件、遍历挂载路径的父目录。可由运维先核对这些确切路径，再调整**仅这些 Secret** 的属主和权限，不要递归修改项目或数据目录：

```bash
# 先确认两个普通文件确实存在且不是符号链接，不打印文件内容。
test -d secrets && test ! -L secrets &&
  test -f secrets/sub2api-admin-key && test ! -L secrets/sub2api-admin-key &&
  test -f secrets/sentinel-password-hash && test ! -L secrets/sentinel-password-hash &&
  sudo chown 1000:1000 secrets secrets/sub2api-admin-key secrets/sentinel-password-hash &&
  sudo chmod 700 secrets &&
  sudo chmod 600 secrets/sub2api-admin-key secrets/sentinel-password-hash
```

这会把 `secrets/` 交给 UID 1000；宿主机当前登录用户若不是该 UID，后续安全编辑 / 轮换需由运维执行。不要用 `chmod 644` 绕过读取失败。Docker Desktop、rootless Docker、user namespace 映射或 SELinux 主机需按实际映射 / 挂载策略核验，不能机械套用宿主 UID。

`.env` 中对应的明文变量保持为空，添加 `COMPOSE_FILE=docker-compose.yml:docker-compose.secrets.local.yml`。本文针对 Linux / macOS，多个 Compose 文件使用 `:` 分隔。后续所有 `docker compose` 命令会自动加载这套配置；需要代理或 MFA 时继续追加对应文件。

镜像已构建后，可以用同一组 Compose 配置检查容器实际身份和文件可读性，不读取 / 打印内容，也不启动哨兵或访问上游：

```bash
docker compose run --rm --no-deps -T --entrypoint node sentinel -e 'const fs=require("node:fs"); for (const p of ["/run/secrets/sub2api-admin-key", "/run/secrets/sentinel-password-hash"]) fs.accessSync(p, fs.constants.R_OK); console.log("Secret files readable; uid="+process.getuid());'
```

这个 helper 沿用服务挂载，包括账本卷，但不会打开数据库。文件缺失或不可读会非零退出，需修正后再启动；只通过配置结构校验不能证明 Secret 可读。

Secret 挂载只减少秘密进入容器环境变量的暴露面，不隔离 Docker 管理员，也不保证容器被攻破后秘密仍安全。`secrets/` 和 `.env` 已从 Git 和 Docker 构建上下文排除，不要放进其他目录随镜像打包。

## 3. 校验、构建和启动

```bash
# 只校验；不启动容器，不完整输出包含秘密的配置。
docker compose config --quiet

# 仅构建，Dockerfile 会自动安装依赖并构建前端。
docker compose build sentinel

# 启动；不重新构建。
docker compose up -d sentinel

docker compose ps
docker compose logs --tail=100 sentinel
curl --fail --silent --show-error http://127.0.0.1:7788/healthz
```

需要一条命令构建并启动时，可以改用 `docker compose up -d --build sentinel`。`config --quiet` 验证 Compose 结构，不验证 Key、应用密码哈希或上游连通性；应用配置错误会在启动日志中体现。

默认宿主机映射为 `127.0.0.1:7788:7788`，账本为 `/data/sentinel.db`。容器内 `HOST=0.0.0.0` 是端口映射所需，宿主机 loopback 发布才是外部访问边界。Compose 会覆盖 `.env` 的 `HOST`、`PORT` 和 `SENTINEL_DB_PATH`，无需修改它们。

需要更改宿主机端口时设置 `SENTINEL_PORT=7799` 并重建容器，访问和健康检查 URL 相应改为 7799；容器内仍是 7788，Compose 会自动补充允许的本机 Host 端口。

镜像内置健康检查约每 30 秒一次，启动后等待 `docker compose ps` 显示健康。健康检查只验证哨兵存活，**不等于上游 API 接入成功或生产验收通过**。

旧库未绑定或绑定与配置不匹配时，容器仍可以健康、登录并查看本地账本，顶部显示阻断原因；连接测试、余额查询、身份同步、规则新增 / 编辑 / 删除和所有加额都被禁止，核验不会访问错误站点。`AUTO_TOPUP_ENABLED=false` 也不会绕过实例检查；不要删除数据库消除提示，先按第 6 节核实归属。

Docker 默认使用非 root、只读根文件系统、独立 `/tmp`、移除全部 capabilities、`no-new-privileges`、256 MB 内存限制和日志轮转。除非有明确原因，不要为排错取消这些限制。

## 4. 访问方式与 HTTPS 代理

### 临时管理：SSH 隧道

没有域名时，可从自己的电脑连接服务器，保留 loopback 发布：

```bash
ssh -N -L 7788:127.0.0.1:7788 your-user@your-server
```

浏览器访问自己电脑的 <http://127.0.0.1:7788>；服务器不需要向公网放行 7788。此方式保留 `AUTH_SECURE_COOKIES=false` 和空 `ALLOWED_HOSTS`。如果本机 7788 已被占用，换本机端口时还需让哨兵允许对应 loopback Host，例如通过 `.env` 的 `SENTINEL_PORT` 协调端口，不要关闭 Host 检查。

### 长期使用：HTTPS 反向代理

将 `.env` 修改为：

```ini
AUTH_SECURE_COOKIES=true
ALLOWED_HOSTS=sentinel.example.com
```

域名填浏览器实际访问的 `host[:port]`，不带协议、路径或通配符；多个值用逗号分隔，非标准 HTTPS 端口也要包含。上游 `SUB2API_BASE_URL` 和哨兵访问域名是两个不同配置，不要混淆。

- 宿主机 Nginx：上游设 `http://127.0.0.1:7788`，保留原始 `Host`，例如 `proxy_set_header Host $http_host;`。
- Docker 中的 Nginx Proxy Manager / Nginx：不能把代理容器的 `127.0.0.1` 当成哨兵；按下面方式加入已有共享网络，上游设 `http://sentinel:7788`。
- 代理应强制 HTTPS、配置证书和 HSTS，推荐再加 VPN / 来源 IP 限制。不要覆盖浏览器的原始 Host / Origin，也不要在代理或日志里公开秘密。

使用 Docker 代理时，在 `.env` 中填写：

```ini
SENTINEL_PROXY_NETWORK=npm_default
COMPOSE_FILE=docker-compose.yml:docker-compose.proxy.yml
```

`npm_default` 是示例，必须改为代理已加入的实际 Docker 网络。先核实网络存在，再校验并启动：

```bash
docker network inspect npm_default --format '{{.Name}}'
docker compose config --quiet
docker compose up -d --build sentinel
```

代理上游使用服务名 `sentinel`、容器端口 `7788`，并透传访问域名。附加网络是 `external: true`，Compose 不会自动创建它；不要凭空创建同名网络后就认为代理已接入。该配置不会自动把哨兵加入另一个 Sub2API 网络，需要部署者另行核实。

如果第 2 节已启用 Secret 配置，保留它：`COMPOSE_FILE=docker-compose.yml:docker-compose.secrets.local.yml:docker-compose.proxy.yml`。首次选择配置后，校验、启动、停止、备份都沿用同一组文件。

Secure Cookie 开启后，应通过 HTTPS 域名登录，不要用直接 HTTP 测试登录成败。localhost 健康检查仍可使用，但不能代替实际域名和证书的验证。

## 5. 上线前验证

1. 始终先保持 `AUTO_TOPUP_ENABLED=false`，确认实例绑定通过，登录并添加一个经确认的测试用户，核对身份、余额与查询时间。网页新增默认「需人工审批」，选择自动模式属于明确授权；已有用户直接编辑，重复添加不会覆盖停用状态、模式或备注。
2. 确认服务器实际 Sub2API 版本、管理 Key 权限、原子增量 `add`、幂等配置及余额历史。发送幂等 Header 本身不证明上游一定去重。
3. 检查域名 HTTPS、Host / Origin、Cookie、权限、数据持久化和备份；需要通知时再配置 webhook 并测试。
4. 设置合理的单笔 / 每日护栏。默认每 60 秒巡检；`MONITOR_INTERVAL_MS` 支持 10000 至 86400000 毫秒，修改后需重建容器。
5. 只有准备好真实写入时，才把写开关改为 `true`，执行 `docker compose up -d --force-recreate sentinel`，先用测试用户和「需审批」模式完成一次真实加额及历史核验。

写开关开启后，既有自动模式的低余额用户可能在首次巡检时立即加额。配置关闭时，手动和审批也不能绕过写开关。确认全部规则后才开放自动模式，不要用关闭某个操作员账号代替停止系统自动加额。

规则编辑 / 启停 / 切换模式 / 删除带版本检查；出现 `409` 时刷新列表、核对当前设置再提交，不要重发旧版本。规则变化会使旧提议过期，需要重新巡检。「加额流水」可按用户 ID / 状态筛选和分页；「未决处理」独立列出所有 `pending` / `unknown`，不受近期成功流水数量影响。核对上游、查看证据后才能确认已到账，此操作不会补发；解除未决拦截后可能恢复该用户自动加额，处理时先关闭写开关或启用全局急停。

通知格式与配置见 [README 的通知说明](../README.md#通知可选)。服务商格式按其业务响应校验；`generic` 只表示 HTTP 成功，不证明接收端完成业务处理。通知失败不回滚已发出的加额，也不会触发补发；上线前单独验证关键告警渠道，到账仍以上游凭据为准。

## 6. 运行、更新与秘密轮换

```bash
docker compose logs -f --tail=100 sentinel
docker compose stop sentinel
docker compose up -d sentinel
```

`Ctrl+C` 退出日志跟随不会停止容器。正常停止使用 `docker compose stop`；Compose 预留 5 分钟宽限期，应用会等待已发出的请求回读和记账，不要常规使用 `docker kill`。

更新源码或依赖：先关闭写开关、重建使它生效、正常停止并按第 7 节备份，再更新源码、执行 `docker compose config --quiet` 和 `docker compose up -d --build sentinel`。核验实际镜像、页面、上游兼容性和旧账本后才恢复写入。

### 已有未绑定账本的升级确认

1. 停止使用同一账本的**所有** Web / CLI / 定时任务，防止备份 / 确认期间被重新启动；按第 7 节备份原账本。保留原来的完整 `SUB2API_BASE_URL`，将 `.env` 中 `AUTO_TOPUP_ENABLED=false`。尚未绑定时才可首次设置并记录实例 ID，已绑定实例不要补改 ID。
2. 更新源码、校验并构建新镜像，沿用原 Compose 项目名、完整 `COMPOSE_FILE` 和账本卷，不要因换目录建立空库。必要时先以观察模式启动检查本地账本；未绑定提示是安全阻断，不是启动失败。
3. 正常停止哨兵，确保其他使用者仍已停止。核实账本确实属于配置站点后，在服务器可信终端运行本地绑定命令：

```bash
docker compose stop sentinel
docker compose run --rm --no-deps -T -e AUTO_TOPUP_ENABLED=false sentinel node server/src/cli.js bind-instance --confirm=https://sub2api.example.com/base/path
```

`--confirm` 必须替换为规范化后的**完整**基础地址，不带末尾斜杠。这条 CLI 使用相同配置 / 数据卷，只写本地绑定，不发送上游请求。历史流水地址不同会拒绝；旧流水只有 origin 或没有地址时，必须独立确认基础路径和归属，命令成功并不是来源证明。它不能重新绑定已绑定但不匹配的库。

4. `docker compose up -d sentinel` 恢复观察模式，核对用户身份、余额、所有旧规则及「未决处理」，最后才决定是否恢复写入。确实迁移到新站点时应建立独立账本并重新审查名单，旧账本留给原实例核验 / 收款，不要修改数据库设置绕过拦截。

修改 `.env`、密码哈希、Key、查询频率，或替换 Secret 文件后：

```bash
docker compose config --quiet
docker compose up -d --force-recreate sentinel
```

`docker compose restart` 不会重新注入 `.env`，不能当作环境配置更新方式。Secret 内容也在应用启动时读取；挂载文件被原子替换时，重建容器还可以确保重新挂载新文件。

泄露的管理员 Key 需要先在 Sub2API 后台轮换 / 撤销旧凭据，再安全更新哨兵。不要把完整 `docker inspect`、`docker compose config` 或环境变量输出贴到工单或聊天。

正常 Key 轮换不会改变账本绑定；保持完整基础地址和实例 ID 不变即可。上游实例重建不是 Key 轮换，需要独立账本与新的实例 ID。

## 7. 数据持久化、备份和恢复

基础 Compose 声明的逻辑卷名为 `sentinel-data`，实际名字通常包含 Compose 项目前缀，不一定就是 `sentinel-data`。可只查看挂载信息：

```bash
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' sub2api-balance-sentinel
```

日常 `stop`、容器重建和 `down`（不带 `-v`）会保留命名卷。**不要执行 `docker compose down -v`、删除该数据卷或清理所有卷**，这会丢失流水和未决拦截，可能导致重复加额。换目录 / Compose 项目名后出现空账本，先检查卷是否换了，不能当作旧数据已删除。

简单的一致性备份要求停止所有账本使用者，包括共享同一卷的 CLI / 定时任务，并暂停自动拉起机制。`docker compose stop sentinel` 只停止这个服务，不会停止独立 CLI / 其他项目的容器。以下命令在确认所有写入者已停止后，用一次性 helper 容器读取同一个数据卷，不启动哨兵：

```bash
docker compose stop sentinel
(
  set -e
  umask 077
  backup_dir="$HOME/sentinel-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$HOME/sentinel-backups"
  mkdir "$backup_dir"
  chmod 700 "$backup_dir"
  docker compose run --rm --no-deps -T --entrypoint tar sentinel -C /data -czf - . > "$backup_dir/sentinel-data.tar.gz"
  # 先确认 tar 成功且归档可读；部分写入的文件不能当作成功备份。
  tar -tzf "$backup_dir/sentinel-data.tar.gz" > /dev/null
  cp -p .env "$backup_dir/.env"
  printf 'Backup completed: %s\n' "$backup_dir"
)
```

子进程的 `set -e` 会在失败时停止，不会因为归档文件存在就继续。只有显示完成并妥善保存备份后，才按实际维护计划运行 `docker compose up -d sentinel`；若用于升级 / 恢复，保持写开关关闭。备份整个 `/data`，包括可能存在的 WAL / SHM，运行中只复制主数据库可能漏数据。

备份放在项目外，防止进入后续镜像构建上下文；按安全要求加密并复制到受保护的独立位置。额外保管自定义 Compose、所有 Secret 与恢复材料；启用 TOTP 时，账户加密密钥必须与数据库对应，并另行保护备份。

### 恢复到新的数据卷

1. 保留原卷和故障现场，不删除原库。关闭写开关、停止所有账本使用者及自动任务。只用自己制作、完整且可信的归档；审查归档内容应是 `/data` 下的相对路径，不含绝对路径或 `..`，不要解压未知来源文件。
2. 新建不含秘密的 `docker-compose.restore.local.yml`，按 `/data` 挂载目标替换为新逻辑卷，避免覆盖原卷：

```yaml
services:
  sentinel:
    volumes:
      - type: volume
        source: sentinel-restore-data
        target: /data

volumes:
  sentinel-restore-data:
```

在 `.env` 的完整 `COMPOSE_FILE` **末尾追加**本文件；仅基础配置时为 `docker-compose.yml:docker-compose.restore.local.yml`，已有 Secret / 上游 / 代理 / TOTP 附加文件必须全部保留。明确设置 `AUTO_TOPUP_ENABLED=false`，基础地址和实例 ID 必须与备份一致；不要直接恢复旧 `.env` 中可能开启的写开关。保持原项目名。新卷真实名称仍含项目名前缀，此逻辑名若已被使用，请换新名，不能直接覆盖。

3. 校验配置，确认新目标卷为空后才解压；两步用 `&&` 相连，空卷检查失败就不会覆盖。helper 不启动哨兵，也不访问上游：

```bash
docker compose config --quiet
# 替换为已核实的可信归档；所有命令沿用已追加恢复配置的 COMPOSE_FILE。
docker compose run --rm --no-deps -T --entrypoint node sentinel -e 'if(require("node:fs").readdirSync("/data").length) throw new Error("Restore target is not empty");' &&
  docker compose run --rm --no-deps -T --entrypoint tar sentinel -C /data --no-same-owner -xzf - < /protected/backup/sentinel-data.tar.gz
```

4. 仅在解压成功后，用只读 SQLite 检查恢复文件，不读取秘密，也不访问上游：

```bash
docker compose run --rm --no-deps -T --entrypoint node sentinel -e 'const Database=require("better-sqlite3"); const db=new Database("/data/sentinel.db", {readonly:true, fileMustExist:true}); try { if(db.pragma("integrity_check", {simple:true})!=="ok") throw new Error("SQLite integrity check failed"); console.log("SQLite integrity OK"); } finally { db.close(); }'
```

5. 保持写开关关闭，用 `docker compose up -d --force-recreate sentinel` 挂载恢复卷；确认挂载指向新卷，检查账户、规则、流水及「未决处理」。未绑定旧快照按第 6 节确认。恢复后继续保留恢复附加文件，否则后续维护会意外切回原卷；需回退时先正常停止、核对两套账本与上游状态，不要在开启写入的情况下来回切换。

**恢复旧备份不会回滚上游余额。** 备份之后的加额可能已到账却不在恢复账本中，必须独立核对快照之后的全部上游加额、未决请求及收款，并保留缺失流水的对账材料；不能仅因未决页为空立即开启自动模式，也不能用补发或「标记已收」代替恢复丢失账本。完整性检查只证明数据库可读，不证明账本完整 / 实例归属；没有完成对账前保持写开关关闭。

## 8. 可选 TOTP 与排错

默认密码登录不需要 `docker-compose.accounts.yml`。只有主动设置 `AUTH_REQUIRE_TOTP=true` 时，初始管理员需要 TOTP Secret，额外账户创建 / 重置需要独立账户加密密钥。

生成和保管流程见 [README 的可选 TOTP 说明](../README.md#可选启用-totp)。将已安全生成的密钥文件放在默认 `./secrets/account-key`，或通过 `SENTINEL_ACCOUNT_KEY_PATH` 指定宿主机路径，确保容器 UID 1000 可读。添加 `docker-compose.accounts.yml` 到现有 `COMPOSE_FILE`，校验并重建；不要丢弃已有 Secret / 代理配置。

不要重新生成密钥来解决解密失败。密钥丢失后旧 MFA 无法解密，只能按恢复流程重新邀请；切换认证模式会撤销旧会话，尚未设置 MFA 的额外账户需重新开通。

| 现象 | 检查方向 |
| --- | --- |
| 容器反复退出 | `logs --tail=100` 中的配置校验、Key、哈希、HTTP 限制、Secret 路径及权限 |
| `_FILE could not be read` | 文件是否实际挂载、容器路径是否正确、UID 1000 是否能读、明文值是否同时非空 |
| 页面或 API 报 `Unexpected Host header` | 代理保留原始 Host，`ALLOWED_HOSTS` 精确匹配域名和端口，不要关闭安全检查 |
| 本机健康但无法远程访问 | 默认不向公网发布；检查代理网络、上游 `sentinel:7788`、域名证书、防火墙和访问控制 |
| HTTPS 登录后仍未登录 | 检查 Secure Cookie、实际 HTTPS 和 Host / Origin；不要用非本机明文 HTTP 测试密码 |
| 上游拒绝连接 | 不要使用指向容器自身的 `127.0.0.1`；核实网络、实际内部端口和上游监听地址 |
| 容器健康但顶部实例绑定阻断 | 核实完整基础地址、原实例 ID 和实际数据卷；旧库按第 6 节确认，已绑定但不匹配不能改绑 |
| 重复添加 / 编辑返回 `409` | 已有用户直接编辑；规则版本已改变时刷新列表、重新确认，不要重发旧请求 |
| 修改 `.env` 未生效 | 使用 `up -d --force-recreate`；`restart` 不会更新容器环境 |
| 重建后看起来数据为空 | 检查 Compose 项目名和实际卷名；不要初始化后重新加额掩盖卷挂载错误 |
| 出现 `pending` / `unknown` | 从「未决处理」按用户筛选和分页查看，核对上游历史及证据，不要清空未决状态、自动重试或直接补发 |

这里描述的是部署操作，不代表已经构建 / 运行容器、完成备份恢复演练、连接你的真实 Sub2API、配置反向代理或完成生产上线。`config --quiet` 通过与 Docker daemon 可用、镜像构建成功、服务运行健康是不同层面的证据；实际部署和恢复仍需在你的环境验证。既有测试证据与边界见 [验收记录](acceptance.md)。
