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
npm run check
npm run native:build
```

`VERSION` 和 package.json 使用同一语义版本。推送 `vX.Y.Z` 标签后 CI 验证四个平台并创建正式 Release。平台包、SDK 和 SHA256SUMS 齐备后才公开版本；节点更新只接受本仓库正式发布的匹配平台包。

控制台通过固定 Release URL 引用 `relay-node-sdk-X.Y.Z.tgz`，SDK 提供执行器、传输组件、公共类型及工具；不要求在旁边检出节点源码。发布包使用白名单，不包含凭证、环境配置或本地数据。
