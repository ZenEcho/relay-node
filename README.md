# Relay Node

Relay 独立执行节点与 SDK。控制台负责账号、订单调度及付款授权；节点只执行被分配的原订单，不需要控制台源码、数据库或 CDK 管理员 Token。

## 安装

支持 Linux（systemd / glibc）、macOS（当前用户 launchd），amd64 / arm64。

```sh
curl -fsSL https://raw.githubusercontent.com/ZenEcho/relay-node/main/install.sh -o install.sh
sh install.sh
```

Linux 请以 root 执行；也可 `sudo -E sh install.sh`。按提示输入实例名称、控制台可访问的地址和控制台签发的完整节点凭证。使用前台生成的一键安装命令时无需逐项填写。公开仓库下载不需要 GitHub Token。

安装包自带固定的 Node.js 运行时、原生 HTTP 组件及菜单，无需安装 pnpm、Node.js 或 Go。macOS 菜单位于 `~/.local/bin/relay-node`，请确保该目录在 PATH 中。

```sh
relay-node
relay-node --instance main status
relay-node --instance main pause
relay-node --instance main resume
relay-node --instance main check_update
```

菜单支持新增/切换实例、对接、开始、暂停、状态、日志、更新及取消等待更新。Linux 菜单请用 sudo 运行，以管理各独立服务账号的实例。配置和凭证文件权限为 0600，实例互不共用凭证、状态或日志。

暂停只停接新单，原订单及其验证、核对、重试、收尾继续进行。更新只由菜单或控制台手动触发：停止新单 → 等待全部原订单结束 → 检查 GitHub 正式 Release → 校验并安装 → 自动恢复运行/暂停状态。不会定时升级。新版启动验证 60 秒内失败会回滚。配置、加密日志队列留在版本目录之外。

macOS LaunchAgent 在当前用户登录后运行；Linux systemd 服务随系统启动。节点只主动连接控制台，不开放公网管理端口，本地菜单通过 0600 Unix socket 管理。

## 开发与发布

```sh
npm ci
npm run sentinel:prepare
npm run check
npm run native:build
```

`VERSION` 和 package.json 使用同一语义版本。推送 `vX.Y.Z` 标签后 CI 验证四个平台并创建正式 Release。平台包、SDK 和 SHA256SUMS 齐备后才公开版本；节点更新只接受本仓库正式发布的匹配平台包。

控制台通过固定 Release URL 引用 `relay-node-sdk-X.Y.Z.tgz`，SDK 提供执行器、传输组件、公共类型及工具；不要求在旁边检出节点源码。发布包使用白名单，不包含凭证、环境配置或本地数据。

SDK 只公开四个入口：`@relay/node` 为 Node 执行运行时，`@relay/node/contracts` 为执行与节点控制协议，`@relay/node/rules` 为共享纯规则，`@relay/node/browser` 为无外部依赖的浏览器页面动作。控制台持有账号、工作流、订单、卡库存和数据库模型；节点仅接收执行快照。

```ts
import { ProtocolEngine, NativeTransport, createEnvironment } from '@relay/node';
import type { ExecutionAssignment } from '@relay/node/contracts';
import { createBrowserSentinelAuthorizer } from '@relay/node/browser';
```

源码按 `execution/`、`browser/`、`transport/`、`runtime/` 分工，命令行与安装入口保留在 worker 根目录。`packages/contracts`、`packages/rules`、`packages/runtime` 分别提供协议、纯函数和 Node 基础设施；测试按相同职责分组，开发探针集中在 `scripts/probes/`。开发依赖使用 npm 与唯一的 package-lock.json。

SDK 的 `createBrowserSentinelAuthorizer(execute)` 可配合现有可信扩展，在匹配本单账号、设备和页面的真实登录文档中调用官方 Sentinel SDK。主令牌和 SO 的 flow 分开处理，保持 SDK 原始值；运行期间身份改变、SDK 未就绪或超时会停止。该模块不创建浏览器、不导入登录凭证、不模拟设备或求解挑战；`execute` 需由已有授权运行时提供。独立节点默认使用下述 reference Sentinel；Chrome/Chromium 仅在 Stripe 官方组件需要时按单启动，结束或进入 CDK 验证等待后关闭。原单只读核对和收尾不启动浏览器。可在实例 config.json 的 officialSdk 中指定浏览器 executablePath 和 headless，默认 Linux 无界面、macOS 临时有界面。显式配置 `sentinel.mode: "official"` 时保留原官方登录页 SDK 路径；后端 HTTP 引擎继续负责付款确认和收尾。

## 后端 Sentinel 参考运行时

节点默认使用 [gpt-subscribe-studio-1](https://github.com/crhywun/gpt-subscribe-studio-1/tree/adccdfc993e368f2c09bad7081885c6daff2d320) 的 Node VM、浏览器环境 shim 和 PoW 方案。Sentinel 由后端 reference 桥签发，浏览器仅在需要 Stripe 官方组件时启动。正式节点包与 SDK 已包含固定校验的参考桥及 undici；新安装节点自动配置 `reference`，未配置 Sentinel 的旧节点更新后使用新版随包参考桥。安装和更新无需系统 npm。参考桥失败或缺失会停止，不会自动切换模式、代理或账号。

如需指定独立参考运行时，可用系统 Node.js 24 和 npm 安装：

```sh
node scripts/install-reference-sentinel.mjs --directory /absolute/path/reference-sentinel
```

发布准备与独立安装器固定上游提交、四个文件的 SHA-256 和 undici 版本，下载校验后安装，生成 `source.json`。独立安装器不覆盖现有目录；需要覆盖默认路径时，在实例 `config.json` 中添加，保留已有对接信息：

```json
{
  "sentinel": {
    "mode": "reference",
    "bridgePath": "/absolute/path/reference-sentinel/sentinel_bridge.js"
  }
}
```

暂停并排空原任务后重启节点服务，使配置生效。外部桥是本机明确选择的可信程序，适配器通过 stdin 传入本单 UA、设备、Cookie、代理、页面和 flow；核对输出绑定，限制时间/输出，回收子进程，不记录授权内容。SO 可空，参考桥的 SO 使用当前主 flow；浏览器适配器仍使用官方 SDK 自己返回的 flow。参考 SDK 是固定版本，站点协议改变时需要更新并重新验收。

新环境固定使用原生组件支持的 Chrome 146 TLS/UA，避免随机旧 Chrome 档案触发站点 challenge。已有订单的环境不改写。节点仍需 Chrome 供 Stripe 使用，管理器同时检查浏览器与参考桥可读性。

独立预检默认只核对原账号并签发两个 flow；可用 `--sdk-root` 指定安装节点。额外传 `--verify-checkout` 才创建一个未付款 Plus 结账并核验商户接受情况，始终不取卡、不确认付款：

```sh
node scripts/probe-reference-sentinel.mjs --session-file /private/session.json --bridge /absolute/path/reference-sentinel/sentinel_bridge.js --transport /absolute/path/bin/relay-transport --proxy http://127.0.0.1:10809 --report /private/sentinel-report.json
```

`--cookie-file` 可指定原账号的 Cookie 导出；`--reference-warmup` 对照上游的首页 metadata/建单字段。报告仅保存状态及未付款 checkout ID，不保存 Token 或响应秘密。签发成功与商户接受分别报告。
