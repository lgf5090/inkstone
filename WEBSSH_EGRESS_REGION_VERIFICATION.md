# WebSSH 出口区域：能力边界与部署后验证清单

## 1. 这个功能解决什么

浏览器开着代理时，请求落到哪个 Cloudflare 边缘/机房会变化，Durable Object 首次创建的位置也随之变化，出网路径因此漂移。本功能给 WebSSH 会话的 Durable Object 指定一个 `locationHint`，让出网区域尽量固定，而不是跟着浏览器落点漂移。

## 2. 能力边界（必须如实理解）

- `DurableObjectNamespace.get(id, { locationHint })` 只在**该 DO id 第一次 `get()`** 时生效。
- 官方原文：Hints are a best effort and not a guarantee。平台会“在靠近提示区域的数据中心”创建，不保证精确落在提示值。
- 官方原文：Durable Objects do not currently change locations after they are created。**已经创建的 DO 不能换区**。
- 因此“失败换区”必须**新建 session（新 sessionId → 新 DO id）**，旧连接先关闭；本实现只自动换区一次。
- `sam`、`afr`、`me` 当前不会在这些位置创建 DO，会落到附近区域；`apac-ne` / `apac-se` 是 `apac` 的子区域（2026-06-19 新增）。
- 区域变化改变的是 DO 所在数据中心，从而可能改变出网路径；**不能保证目标一定放行**。
- **Cloudflare Worker 无法连到用户本机的 v2rayN / 本地代理。** 本功能不会、也不能借用浏览器本地代理；出网永远是 Worker/DO 侧。

## 3. 本地能验什么、不能验什么

本地 `wrangler dev` / `vite` 只有一个本地实例，`locationHint` 不会真正改变出网位置。

本地可以验证：

- `POST /api/webssh/sessions` 解析出的 `region` 正确落库；
- `GET /sessions/:id/ws` 首次 `get()` 确实带上了 `locationHint`；
- 审计里 `session_create.region`、`connect.region`、`connect_error.region` 正确；
- 失败换区状态机：`retryable`、`retryRegion`、客户端只换一次；
- 区域记忆 `regionResolved` 的成功/连续失败重置；
- `egress-test` 多区域探测的请求编排、审计落库；
- 现有转发复用同一 session 出口。

本地不能验证：

- 不同区域真实出网 IP 是否变化；
- 目标是否只放行某些区域；
- `locationHint` 是否被平台“就近选择”到预期位置。

这些必须在部署后验证。

## 4. 部署后验证清单（按顺序）

1. **部署与迁移**
   - 部署本分支；确认迁移 318（`webssh_hosts.egress`）和 319（`webssh_sessions.region`）已执行。
   - 打开 WebSSH → 会话设置，确认“默认出口区域”“候选区域顺序”可见且能保存。
   - 确认跳板 / SOCKS5 / HTTP CONNECT 入口不可用，并显示“需要中转节点”的说明。

2. **单区域基线**
   - 新建一台测试主机，区域选“手动指定”，例如 `apac`。
   - 打开终端；在审计里确认：
     - `session_create.metadata.region = "apac"`
     - `connect.metadata.region = "apac"`
   - 记录目标是否可达。若可达，说明该区域可用。

3. **多区域探测**
   - 在主机编辑弹窗点击“探测区域”（默认探测 `apac`、`weur`、`enam`）。
   - 查看每个区域的步骤耗时和失败阶段；确认审计出现 `egress_test` 事件，metadata 包含 `region`、`ok`、`phase`、`elapsedMs`。
   - 点击某个成功结果的“使用此区域”，保存主机。

4. **自动模式与换区**
   - 把主机区域改为“自动选择”，候选顺序设为例如 `apac, weur, enam`。
   - 让主区域失败（例如目标只对某区域放行，或人为选一个不可达主区域）。
   - 观察：
     - 第一个 session 的 `connect_error`：`region` 为主区域，`retryable = true`，`retryRegion` 为下一个候选；
     - 新 session 的 `session_create`：`region` 为 `retryRegion`；
     - 审计出现 `egress_fallback`，metadata 为 `{ reason: "region", from: "...", to: "..." }`；
     - 终端出现“已切换到 … 重试”的提示。
   - 只应换区一次；第二次失败不再自动换区。

5. **区域记忆**
   - 某区域连接成功后，审计 `connect.region` 命中；
   - 重新打开主机，表单显示“上次成功：…”，自动模式优先使用它；
   - 同一区域连续失败两次后，`webssh_hosts.egress.regionResolved` 被清除；
   - 手动修改主机区域会清除旧记忆。

6. **转发**
   - 打开文件/转发面板，创建一条转发规则（默认只允许 loopback）。
   - 在 `egress-test` 结果里确认有 `forward` 步骤：
     - 有规则时显示“转发验证”；
     - 无规则时显示“未配置转发规则”；
   - 审计 `forward_create` / `forward_stop` / `forward_blocked` 的 metadata 应带 `region`。

## 5. 怎么判断“区域问题”还是“目标段封禁”

看 `connect_error` / `session_error` 的字段：

- `phase = "dns"`：域名解析失败，先查 DNS/DoH，不是区域问题。
- `phase = "connect"` 且多个区域都失败、`message` 类似连接被拒/超时：
  - 如果目标从非 Cloudflare 主机可连，而所有 Cloudflare 区域都不可连，优先怀疑**目标封禁 Cloudflare 出网段**；换区通常无效。
  - 如果只有部分区域失败，换区可能有效。
- `phase = "handshake"`：TCP 通了，但 SSH 版本/KEX/主机密钥失败；不是出口区域问题。
- `phase = "auth"`：凭据或主机密钥被拒；换区无效。
- `retryable = false`：凭据、主机密钥、协议错误，不应换区。
- `retryable = true` 且有 `retryRegion`：自动模式允许一次换区。

如果所有区域都在 `connect` 阶段失败，且目标从其他网络可达，当前没有 VPS / 公网中转节点时**无法靠区域固定解决**；需要用户提供真实跳板或公网 SOCKS5/HTTP CONNECT 节点，届时再启用已保留的 relay 配置。

## 6. 审计字段速查

`connect`：

```json
{
  "port": 22,
  "address": "203.0.113.10",
  "family": 4,
  "devOverride": false,
  "mode": "direct",
  "region": "apac"
}
```

`connect_error`：

```json
{
  "name": "Error",
  "message": "proxy request failed, cannot connect to the specified address",
  "phase": "connect",
  "address": "203.0.113.10",
  "port": 22,
  "elapsedMs": 1234,
  "mode": "direct",
  "region": "apac",
  "retryable": true,
  "retryRegion": "weur"
}
```

`egress_fallback`：

```json
{ "reason": "region", "from": "apac", "to": "weur" }
```

`egress_test`：

```json
{ "region": "apac", "ok": true, "phase": "forward", "elapsedMs": 3456 }
```

## 7. 明确限制

- 本功能不读取、不使用用户浏览器侧的代理；Worker 无法访问用户本机 `127.0.0.1` 上的 v2rayN。
- 跳板 / SOCKS5 / HTTP CONNECT 当前只保留配置与后端拒绝码 `egress_mode_unavailable`，UI 默认隐藏/置灰；需要真实中转节点后再启用。
- `locationHint` 不是 SLA；不要把“指定区域成功”理解为“该区域一定稳定”。
- 本地 `wrangler dev` 不会真正换区；只验证传参、计划和审计。
