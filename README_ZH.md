<p align="center">
  <img src="./public/inkstone-logo.svg" width="112" height="112" alt="Inkstone 项目 Logo" />
</p>

<h1 align="center">Inkstone</h1>

<p align="center">
  一套用于写作、整理、同步和备份个人知识的自托管 Markdown 笔记应用。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./CONTRIBUTING.md">参与开发</a> ·
  <a href="./LICENSE">AGPL-3.0-only</a> ·
  <a href="https://inkstone-demo.pages.dev/">在线体验</a>
</p>

## 项目简介

Inkstone 是运行在 Cloudflare Workers 上的浏览器笔记本。笔记始终是普通 Markdown 文本；在此基础上，应用提供专注写作、实时预览、关键词与可选语义搜索、双链导航、离线编辑、多设备同步、私有 AI 接入、公开分享和异地备份。

它是一套需要自行部署的完整应用，数据库、附件和运行环境都由部署者掌控。

每个新账号都会自动获得中文版和英文版两篇标准起始笔记。纯前端体验版复用同一份笔记内容，刷新页面后恢复为这两篇起始笔记，不会另外维护一套示例数据。


## 主要功能

| 范围 | 已实现能力 |
| --- | --- |
| 写作 | CodeMirror 6 编辑器、可独立编辑的笔记标题、**桌面双笔记窗格**、各窗格独立的编辑/分栏/预览布局、双向滚动、大纲、**专注模式**、**打字机模式**、**自动保存**、**版本历史** |
| Markdown | GFM 表格与任务列表、脚注、Obsidian 风格注释、WikiLink、嵌入、块 ID、Callout、折叠块、标签页、**数学公式**、**Mermaid**、**PrismJS 代码高亮**、**Front Matter** |
| 整理 | 支持拖拽排序的多级文件夹、正文标签、收藏、置顶、归档、回收站、**Wiki 双链**、反向链接、块引用、笔记嵌入、关系图谱 |
| 搜索 | 基于 D1 FTS5 的全**文搜索**、中文索引、条件筛选、最近笔记、命令面板，以及由 Workers AI 提供的可选私有**语义/混合搜索** |
| **MCP** | 私有远程 MCP、带 PKCE 的 OAuth 2.1、可撤销的 `ink_...` API Key、标准 `search`/`fetch`、分段读取、版本安全写入、独立回收站权限和账号级授权管理 |
| 可靠性 | 可安装 PWA、离线启动、浏览器本地缓存、**离线写入队列与乐观并发控制**、常用操作立即本地生效并可失败回滚、过期同步保护、冲突副本、实时通知和主标签页轮询降级 |
| 邮箱 | 仅站长可用的邮箱应用（位于待办之后）：多级文件夹与标签、会话线程、读取状态过滤、搜索与保存搜索、侧栏联系人与群组（自定义图标、收藏、置顶、相关邮件）、30 天回收站、批量操作、稍后处理、定时发送与撤销、规则、屏蔽发件人、模板、多签名、休假自动回复、重点收件箱、复用笔记格式工具栏的 Markdown 撰写器、内嵌图片、走共享附件中心的附件、可检查并修改邮箱全部内容的邮件助手（发送、定时发送与永久删除需一次确认）、页内邮箱管理与设置/规则/模板/统计浮层、可拖动宽度的侧栏与邮件列表，以及按需开启的 MCP 邮件工具 |
| 分享 | 可设置访问口令和有效期的公开笔记链接 |
| 可迁移性 | JSON 与 ZIP 导出、可直接阅读的 **Markdown**、附件导出、**手动或定时 WebDAV/S3 备份** |
| 界面 | **桌面与移动布局**、**深浅主题**、强调色、简体中文和英文，以及仅站长可见的版本更新提醒 |
| 查询 | **Dataview** 的 `dataview` / `dataviewjs` 代码块支持 DQL 与内联属性，**Tasks** 的 `tasks` 代码块查询库内每一个复选框，分组排序后可在列表里直接勾选或编辑 |
| 模板 | **模板引擎**在沙箱里运行 `<% … %>`，支持 `tp.*` 模块、用户脚本、预览里的 `<%+ … %>` 动态命令、模板快捷键、按文件夹与按路径正则的新文件触发、启动模板、应用内语法参考，以及一个按只读口径运行的社区模板库 |

## 模板引擎

模板就是代码。`<% … %>` 在模块 worker 里的 QuickJS wasm 中运行，带时间与内存预算；它读的、写的、创建的每一篇笔记，问的每一个问题，请求的每一个地址，都要回到页面这一道能力判定上。

````markdown
---
title: <% tp.file.title %>
day: <% tp.date.now("YYYY-MM-DD") %>
---

<%*
const steps = ['把目标写下来', '拆成三步']
tR += steps.map((one, i) => `- [ ] ${i + 1}. ${one}`).join('\n')
%>
````

有三处选择是刻意的，不是顺带的：

- 社区模板库里的模板不会就地运行。默认要求先加入你自己的模板库，而那一步正是你读过它的时刻；允许就地使用是一项需要确认的设置，而且即便允许，社区正文也只按只读运行——它能读的只有它正在应用的那篇笔记。
- 发布一段会执行代码的正文，要你确认它确实会执行，因为只有你说得清它会在别人的设备上做什么。
- 语法着色、模板快捷键、启动模板和用户脚本能不能跑，**按设备**保存，刻意不随账号同步——换一台机器登录，不会在那里开始运行代码。

## 任务查询

`tasks` 代码块把同一个问题问遍库里的每个复选框，答案是实时的：在列表里勾一下，写回的是它出身的那篇笔记。

````markdown
```tasks
not done
due before 2026-11-01
group by folder
sort by urgency
hide edit button
```
````

**字段一律写在描述之后**，顺序固定：标识、依赖、优先级、重复、完成时、创建、开始、计划、到期、取消、完成。放在别处也读得出来，但会被按这个顺序重写——正是这个稳定顺序，让一次勾选只改一个字段而不惊动邻居。

每个字段一个符号；Inkstone 读得懂它历史上接受过的每种写法，写入时只用你在**设置 → 查询 → 完成标记**里选定的那一种：

| 字段 | 写入 | 也能读出 |
| --- | --- | --- |
| 优先级 | `🔺` `⏫` `🔼` `🔽` `⏬` | 无标记，以及 `[priority:: high]` |
| 创建 | `➕` | `✕`、`[created:: …]` |
| 开始 | `🛫` | `[start:: …]` |
| 计划 | `⏳` | `⌛` `🕐`、`[scheduled:: …]` |
| 到期 | `📅` | `📆` `🗓`、`[due:: …]` |
| 取消 | `❌` | `[cancelled:: …]` |
| 完成 | `✅` | `[done:: …]` |
| 重复 | `🔁 every week` | `[repeat:: …]` |
| 完成时 | `🏁 keep` / `🏁 delete` | `[onCompletion:: …]` |
| 标识 / 依赖 | `🆔 abc` `⛔ def` | `[id:: …]` `[dependsOn:: …]` |

**设置 → 任务 → 全局过滤器**里填的那个词，决定一个复选框算不算任务；想让某个块看见所有方框，就在那个块里写 `ignore global query`。勾选一个重复任务会终结这一次，并按规则写出下一次，日期一并落好。

## 数据存放位置

| 组件 | 用途 |
| --- | --- |
| Cloudflare D1 | 账号、笔记、文件夹、标签、设置、版本、分享、关键词索引、按账号隔离的 AI 向量和后台索引队列 |
| Cloudflare R2 或 Workers KV | 通过 `FILES` 或 `FILES_KV` 绑定存放附件及上传头像的二进制 |
| Workers KV `OAUTH_KV` | OAuth 客户端注册、授权码、访问令牌、刷新令牌和授权记录；不存放笔记正文 |
| Workers AI `AI` 绑定 | 可选生成语义搜索向量；未配置时继续使用关键词搜索 |
| QuickJS（WebAssembly） | 助手 `code_execute` 工具背后的解释器，随 Worker 一起打包、部署时编译；没有绑定、没有网络、没有定时器、没有 import，超过应用自己的时限即被中断 |
| 浏览器 IndexedDB | 本地缓存与尚未上传的离线写入 |
| 邮箱 D1 表 | 邮箱账号、自动草稿任务和附件元数据（`email_*`） |
| `EmailMailbox` Durable Object | 每个账号一个 SQLite 邮箱：文件夹、邮件、线程、入站去重与幂等发送操作 |
| Cloudflare Email Routing / Email Service | 入站投递到 Worker，以及可选的 `EMAIL` 发信绑定；邮箱仅站长可用 |
| `SyncHub` Durable Object | 在线客户端之间的实时变更通知 |
| `CredentialVault` Durable Object | 隔离保存用于加密备份凭据的密钥 |
| WebDAV 或 S3 存储 | 用户自行配置的异地备份 |

## 部署教程

1. Fork Inkstone 仓库到自己的 GitHub 账号
2. 进入 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)
3. 选择 Continue with GitHub 并选择你的仓库
4. 使用 R2 时，构建命令填 `npm run build`，部署命令填 `npm run deploy`
   - 如果你打算用 KV 模式，构建命令改成 `npm run build:kv`，部署命令改成 `npm run deploy:kv`。
     KV 模式会部署成另一个 Worker（`inkstone-kv`）；若你把已有部署切过去，需要把自定义域名
     和路由重新挂到这个 Worker 上
5. 先在你的账号里创建 D1 数据库（KV 模式还要创建 KV 命名空间），把它们的 id 填进对应的、纳入版本管理的
   配置：R2 模式改 `wrangler.toml` 里的 `[[d1_databases]] … database_id = "<id>"`，KV 模式改
   `wrangler.kv.toml` 里的 `[[kv_namespaces]] … id = "<id>"`。`dist/` 下的部署配置每次构建都会重写，
   只有纳入版本管理的文件能保住这些 id。部署前先用 `npm run deploy:check` 检查一遍。
6. 打开生成的 Workers 域名之前，先决定谁能认领这个实例：全新部署没有任何账号，第一个完成注册的
   人就是站长。只要 URL 能被公网访问（包括你挂域名之前拿到的 `*.workers.dev` 地址），就先把初始化
   密钥设上：

   ```bash
   npx wrangler secret put SETUP_TOKEN   # 至少 16 个字符
   npx wrangler secret put DO_AUTH_KEY   # 可选：给两个 Durable Object 加内部鉴权
   ```

   之后再注册，登录页会要求填写初始化令牌。其余部署注意事项见 `SECURITY.md`；更新自托管实例前请先备份。

7. Web Push 在部署配好自己的密钥对之前一直是关着的。生成一对，把两半都作为 secret 存进去——不要写进
   `wrangler.toml`，私钥也从不离开 Worker：

   ```bash
   npx wrangler secret put VAPID_PUBLIC_KEY    # 未压缩 P-256 点的 base64url（65 字节，以 0x04 开头）
   npx wrangler secret put VAPID_PRIVATE_KEY   # 私钥 JWK：{"kty":"EC","crv":"P-256","d":…,"x":…,"y":…}
   npx wrangler secret put VAPID_SUBJECT       # 可选：给推送服务的联系地址，mailto: 或 https:
   ```

   下面这一条命令会一次打印出两半，按提示粘贴进上面两次 `secret put` 即可：

   ```bash
   node --input-type=module -e 'const k=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign"]);const j=await crypto.subtle.exportKey("jwk",k.privateKey);const r=new Uint8Array(await crypto.subtle.exportKey("raw",k.publicKey));console.log("VAPID_PUBLIC_KEY="+Buffer.from(r).toString("base64url"));console.log(`VAPID_PRIVATE_KEY=${JSON.stringify({kty:j.kty,crv:j.crv,d:j.d,x:j.x,y:j.y})}`)'
   ```

   前两个变量只要有一个没配，推送接口就如实回答"服务端未配置推送密钥"：不发任何东西，也不假装发过。
   读者订阅的设备信息不进任何导出与备份——一条订阅就是往那台设备塞通知的能力。

8. 没有邮箱域名时邮箱应用不会出现。先为该域名启用 Email Routing，把 catch-all 或专用地址指向这个
   Worker，并在纳入版本管理的 Wrangler 配置里设置普通变量 `MAIL_DOMAIN`（必填）、`EMAIL_DOMAINS`
   （可选白名单）和 `EMAIL_ADDRESSES`（可选固定地址）。目标必须是本项目部署出的 Worker——名字是
   `wrangler.toml` 的 `name`，默认 `inkstone`；指向别的邮件 Worker 时本应用收不到消息。发信使用
   `[[send_email]]` 绑定；移除该绑定后，接口会如实回答"发信不可用"，不会假装邮件已发出。只有站长
   能打开邮箱或调用其接口。KV 模式没有 R2 存储桶，因此邮件附件会显示为不可用，纯文本邮件仍可正常收发。
9. 邮件默认保持私密：每个邮箱的自动草稿默认开启，新邮件正文会发往助手配置的 AI 供应商（可在邮箱设置
   里关闭）；只有附上上下文芯片时助手才会读到当前邮件；MCP 的邮箱访问默认关闭，需站长在 MCP 设置里
   开启，且通过 MCP 发信必须显式确认。邮件助手可以直接整理和修改邮箱数据；发送、定时发送与永久删除会先
   请你确认一次。收到的邮件默认加载远程图片，这会让发件人知道邮件已被打开。

现有数据库会在每次启动时以幂等方式补上新增的表与索引。自托管实例更新前仍建议保留一份最新备份；发现新的稳定版本时，只有站长会收到专门的更新提醒，不会打扰普通成员。

## 导出与备份

- JSON 导出保留可重新导入的旧版结构化笔记数据。
- ZIP 导出与远程备份使用同一套可校验的 Markdown 快照，包含可读正文、归档笔记、回收站笔记、附件和完整性标记。
- 远程备份支持 WebDAV 与 S3 兼容存储，同一快照内内容相同的附件只保存一份。
- 大型备份可直接选择备份文件夹分批恢复，不必把整包一次装入内存。
- 可以配置多个目标，并选择手动执行或定时运行。
- 邮箱以独立归档进入快照，包含正文、文件夹、标记和附件元数据；附件字节默认不包含，可按备份目标显式开启；单个邮箱可从其设置页导出。
- 登录密码、活动会话、分享口令和备份服务凭据不会进入导出文件。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动本地 Worker 和前端 |
| `npm run dev:kv` | 使用 KV 附件配置启动本地环境 |
| `npm run dev:demo` | 启动刷新即重置的纯前端体验版 |
| `npm run typecheck` | 执行 TypeScript 项目检查 |
| `npm run test:unit` | 运行 Vitest 单元测试 |
| `npm run i18n:check` | 检查中英文资源键是否完整一致 |
| `npm run comments:check` | 检查源码注释规范 |
| `npm run build` | 类型检查并生成生产构建 |
| `npm run deploy:kv` | 使用 `wrangler.kv.toml` 构建并部署 |
| `npm run deploy:demo` | 构建并部署纯静态体验版 |
| `npm run test:e2e` | 对正在运行的临时本地实例执行 API 端到端测试 |

端到端脚本会在 `http://localhost:7712` 创建、修改并删除数据，只能对专门用于测试的全新本地状态运行。

## 目录结构

```text
src/
├── client/   React 界面、编辑器、预览和本地状态
├── shared/   共享类型、限制、语言资源和 Markdown 工具
└── worker/   Hono API、认证、D1 访问、同步、分享和备份
public/       静态资源
scripts/      仓库检查与端到端验证脚本
tests/        跨模块回归测试
```

## 安全与参与开发

报告安全问题前请阅读 [`SECURITY.md`](./SECURITY.md)。开发环境和贡献要求见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

Inkstone 使用 [GNU Affero General Public License v3.0 only](./LICENSE)，SPDX 标识为 `AGPL-3.0-only`。

Inkstone 以网络服务的形式提供，因此该许可证第 13 条适用于所有通过网络与其交互的使用者：他们必须能取得对应源码，包括为该部署所做的修改。参考源码即本仓库；自行改动代码的部署实例，必须向自己的用户暴露其对应源码。派生自其他 AGPL-3.0-only 项目的部分见 [`NOTICE`](./NOTICE)。
