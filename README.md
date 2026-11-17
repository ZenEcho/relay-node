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

控制台节点列表的“日志”支持查询、组合筛选、导出和清空本节点日志。节点会上报启动/停止、连接异常与恢复、运行环境异常与恢复，并为订单任务的接收、结束和中断保留原执行租约。脱敏记录先进入本地加密队列，断网后可重启补传，保留 72 小时；正常心跳和空轮询不逐次记录。执行详情的“导出订单日志”会汇总同一订单各次执行的控制台与节点日志，通用节点运行事件不混入订单。

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

独立节点通过纯 HTTP 创建 confirmation token，并确认原结账和原 PaymentIntent。令牌请求参数参考 oa-pay-protocol-go，包含 Stripe.js 兼容元数据；此路径不加载 Stripe.js、不启动浏览器。卡片资料仅在节点内存和本单冻结代理的 HTTPS 请求中使用，使用后清空，不进入检查点或日志。付款开关、逐次派发授权与付款结果核对仍由原执行流程处理。

工作流的 `checkoutMode` 可选 `custom`（默认，oaics_ / ChatGPT）或 `hosted`（cs_live_ / Stripe）。Hosted 通过 payment_pages 初始化、HTTP 令牌、原结账确认及商户审批处理；两条路径不自动互换。日志和执行检查点携带实际链接类型，恢复只查询原结账或原 Intent，不重放付款。商户明确返回 `subscription_limit` 且没有 Intent 时先只读核对原结账与账号，确认失败后结束本次尝试；控制台按最多三张不同卡的规则重试，第三张预留新开卡。付款结果未知时只核对原付款，不换卡。

SDK 的 `createBrowserSentinelAuthorizer(execute)` 可配合现有可信扩展，在匹配本单账号、设备和页面的真实登录文档中调用官方 Sentinel SDK。主令牌和 SO 的 flow 分开处理，保持 SDK 原始值；运行期间身份改变、SDK 未就绪或超时会停止。该模块不创建浏览器、不导入登录凭证、不模拟设备或求解挑战；`execute` 需由已有授权运行时提供。默认节点不注入浏览器 StripeTokenProvider；付款后收尾按需启动本单临时浏览器，显式配置 `sentinel.mode: "official"` 时 Sentinel 也使用该浏览器。在实例 config.json 的 officialSdk 中可指定 executablePath 和 headless。

Custom 流程先读取地区报价，再在建单、更新税费和商户付款确认前分别获取授权；选卡与 Stripe 卡片令牌创建不额外刷新 Sentinel。每次授权仅供对应阶段的一次写请求使用，GET 和 Stripe 请求不携带 Sentinel，检查点不能恢复旧授权。发送前再次核对本地新鲜度期限、原账号、凭证及冻结环境；该期限不代表上游确认的有效期。授权日志和对应写请求通过 `grantId` 关联，日志保留运行模式、参考 SDK 版本和环境绑定校验结果。环境配置一致不保证动态代理实际出口相同。

后续授权日志属于建单或付款阶段，进度不会跳回账号检查。合并相邻的重复阶段检查点，授权开始、就绪通过日志记录，不再分别等待检查点请求；原结账、税费、Elements、卡片令牌和 Intent 等恢复数据仍同步保存。首次 HTTP 传输共用派发前的执行检查，重试退避后重新检查。取卡请求使用独立的 180 秒期限，取消信号仍即时生效，不自动重放请求。

明确拒付换卡和已建单后的派发前失败保留原账号、冻结环境、结账、税费与 Elements，新的执行记录从选卡阶段继续。换卡重新生成确认令牌；已有原 Intent 时先只读确认仍为 requires_payment_method、金额和币种未变，再用新卡确认原 Intent，不重新建单或重复商户确认。原付款状态变化时暂停换卡，保留观察结果供核对。

参考桥错误只记录固定的脱敏分类；仅已识别的临时网络错误在当前阶段重试一次，身份、flow、令牌格式和证明校验失败不进行阶段重试。

## 后端 Sentinel 参考运行时

节点默认使用 [gpt-subscribe-studio-1](https://github.com/crhywun/gpt-subscribe-studio-1/tree/adccdfc993e368f2c09bad7081885c6daff2d320) 的 Node VM、浏览器环境 shim 和 PoW 方案。Sentinel 由后端 reference 桥签发，Stripe 令牌通过 HTTP API 创建。正式节点包与 SDK 已包含固定校验的参考桥及 undici；新安装节点自动配置 `reference`，未配置 Sentinel 的旧节点更新后使用新版随包参考桥。安装和更新无需系统 npm。参考桥失败或缺失会停止，不会自动切换模式、代理或账号。

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

新环境固定使用原生组件支持的 Chrome 146 TLS/UA，已有订单的环境不改写。reference 模式签发 Sentinel 无需 Chrome/Chromium；浏览器收尾和 official Sentinel 模式需要 Chrome/Chromium，可通过 officialSdk.executablePath 指定可执行文件。原付款核对不依赖浏览器就绪；收尾失败保留付款成功。收尾先强制刷新 Session 并验证原账号，再完成原登记、取消续费和获取账单；浏览器轮换后的 Cookie 整体保存，防止混入旧登录分片。刷新失败不继续使用旧 Token，明确的 401 仅在重新刷新后重试一次。

付款前的只读请求明确返回 `401 / token_expired` 时，使用本单 Session Cookie 读取并强制刷新 accessToken，核对原账号与原用户后重试原查询一次。正式节点复用本单代理下的临时浏览器；SDK 未注入浏览器通道时使用原 HTTP 会话。刷新成功后同步轮换 Cookie 到 HTTP 传输并保存检查点；身份不符、无登录 Cookie、响应仍为旧 Token 或刷新失败时停止。普通 401/403 不触发此恢复，结账创建及付款 POST 不自动重放；accessToken 过期也不直接等同于登录 Session 过期。

独立预检默认只核对原账号并签发两个 flow；可用 `--sdk-root` 指定安装节点。额外传 `--verify-checkout` 才创建一个未付款 Plus 结账并核验商户接受情况，始终不取卡、不确认付款：

```sh
node scripts/probe-reference-sentinel.mjs --session-file /private/session.json --bridge /absolute/path/reference-sentinel/sentinel_bridge.js --transport /absolute/path/bin/relay-transport --proxy http://127.0.0.1:10809 --report /private/sentinel-report.json
```

`--cookie-file` 可指定原账号的 Cookie 导出；`--reference-warmup` 对照上游的首页 metadata/建单字段。报告仅保存状态及未付款 checkout ID，不保存 Token 或响应秘密。签发成功与商户接受分别报告。
