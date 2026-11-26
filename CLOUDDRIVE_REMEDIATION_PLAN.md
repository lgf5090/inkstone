# CloudDrive 整改计划

> 基准提交：`7592a935aa9777a3d765e9ffcf0ef8d2fdeb467b`  
> 分支：`fix/clouddrive-remediation`  
> 状态：本批次已验证完成；剩余未完成项见下文  
> 规则：每个任务完成后提交原子 commit，并实时更新本文件；未验证项不得标记 DONE。

## 当前批次

- [x] PLAN-00 建立独立 worktree、实时计划文档与验证环境
- [x] SEC-01 分享根按 file_id 解析并处理改名/移动
- [x] SEC-02 重命名/移动迁移 Meta、unlock、请求与同步路径（Key 前缀保持显式）
- [x] SEC-03 ACL 查询绑定 mount_id
- [x] SEC-04 ACL 保存遵守目录锁和隐藏规则
- [x] SEC-05 外部缩略图统一授权、MIME、大小与安全头
- [x] SEC-06 普通分享执行默认/最大有效期策略
- [x] SEC-07 分享预算、Cookie 与路径隐私收口
- [x] SEC-08 公开请求上传流式限长与额度预留
- [x] SEC-09 离线缓存按用户隔离
- [x] SEC-10 WebDAV 覆盖写与分布式 COPY 修复
- [x] SEC-11 文件夹上传父失败时跳过整个子树
- [x] SEC-12 API Key 增加只读 scope
- [x] SEC-13 驱动统一出站 SSRF 护栏
- [x] SEC-14 ACL 用户名枚举与通用错误响应
- [x] LOG-01 客户端正确处理 207 部分成功
- [x] LOG-02 可变内容缓存版本化
- [x] LOG-03 上传 skip 与分布式续传修复
- [ ] LOG-04 分享下载按访客/文件/窗口去重
- [ ] LOG-05 分享、ACL、最近列表游标分页
- [x] LOG-06 清理或接通 allow_list 等死配置
- [x] LOG-07 Jobs 前后端权限契约统一
- [x] LOG-08 外部写入冲突策略与 S3 MOVE 可恢复化
- [ ] LOG-09 父子同选移动保持树结构
- [ ] LOG-10 隐藏项 total 修正
- [x] LOG-11 凭证解密错误带上下文
- [x] PERF-01 前端下载流式落盘
- [x] PERF-02 ZIP 按需打开对象流
- [x] PERF-03 服务端分片流式写入
- [x] PERF-04 单文件分片并发与自动重试
- [x] PERF-05 WebDAV 短期认证会话缓存
- [x] PERF-06 移除每请求主挂载初始化写
- [ ] PERF-07 配额计数表与定时校准
- [ ] PERF-08 URL 上传超时、限流与流式限长
- [x] UX-01 公开页接入统一 API 服务层
- [x] UX-02 跨 feature 引用改公开入口
- [x] UX-03 设置、最近、分享浏览补齐错误三态
- [x] UX-04 移动端 Inspector 改 Drawer/dialog
- [x] UX-05 表单错误 ARIA 关联与键盘路径
- [x] UX-06 设计令牌、i18n 与死代码清理
- [ ] UX-07 拆分 FilesPage 与 store-files 职责
- [x] UX-08 文件列表工具栏、列与搜索体验
- [x] UX-09 补齐 lint、测试、build、a11y 门禁
- [ ] FEAT-01 跨挂载复制/移动/迁移
- [ ] FEAT-02 跨盘全局搜索与 FTS5
- [ ] FEAT-03 公开分享转存到我的网盘
- [ ] FEAT-04 文件夹分享打包下载
- [ ] FEAT-05 ACL 权限分级与到期授权
- [ ] FEAT-06 SHA-256 秒传与内容去重
- [ ] FEAT-07 文件活动审计与异常提醒
- [x] FEAT-08 元数据与配置备份导出
- [ ] FEAT-09 自动备份与后台同步
- [ ] FEAT-10 整盘快照与时间点恢复
- [ ] FEAT-11 私密保险箱
- [x] FEAT-12 文件评论与 @提及
- [ ] FEAT-13 媒体增强：HEIC、续播、转码评估
- [ ] FEAT-14 大列表虚拟滚动
- [x] QA-01 单元、类型、静态门禁与构建
- [x] QA-02 外部浏览器关键链路验收
- [ ] QA-03 真实外部驱动冒烟与性能基线

## 任务记录

| ID | 状态 | Commit | 验证证据 |
|---|---|---|---|
| PLAN-00 | DONE | 9df6f675 | worktree 已创建；`npm ci` 成功；计划文档纳入版本控制 |
| PERF-02 | DONE | cfa0bfb7 + 991fc70b | ZIP 往返与有界预取测试通过；最多 8 个对象预取 |
| PERF-06 | DONE | 9d283ddf | `clouddrive-files` + `clouddrive-mounts` 47 项通过；主挂载仅缺失时写 |
| SEC-13 | DONE | 5301e9a9 | Google Drive、Dropbox、AutoIndex、external drivers 44 项通过 |
| LOG-11 | DONE | 2b790bf3 | OAuth tokens + driver resolver 17 项通过；解密失败显式报错 |
| LOG-07 | DONE | 81521917 | 新增 `clouddrive-jobs.test.ts` 2 项通过；owner 200/member 403 |
| FEAT-08 | DONE | f5de7cf1 + 05e2192d | 后端脱敏导出与设置页入口完成；浏览器端点 200 |
| FEAT-13 | IN PROGRESS | 16cd1663 | 音视频续播与账号隔离已实现；HEIC/转码仍待评估 |
| FEAT-06 | IN PROGRESS | 75215bf8 | 增量 SHA-256 工具与测试通过；上传去重协议待接 |
| FEAT-14 | IN PROGRESS | 8b35bf97 | 列表/网格/相册启用 content-visibility；大列表性能实测待做 |
| UX-01～06 | DONE | 05e2192d | 7 文件 16 项 UX 测试、i18n、ESLint、Stylelint 通过；构建通过 |
| UX-09 | DONE | 84248129 + 62ca1759 + 7d9b3e14 | typecheck/tests、i18n、comments、hooks、a11y、ESLint、Stylelint 全通过 |
| QA-02 | DONE | dcda3227 | 有头 Chrome：上传→列表、配置导出、分享改名、评论发布、列菜单、移动端 Inspector/ESC/焦点归还通过 |
| SEC-01～07 | DONE | ba025d0c | 分享/Meta/ACL/缩略图 87 项回归通过；Key 前缀不随挂载路径漂移 |
| SEC-14 | DONE | ba025d0c | ACL 用户名探测 5 次后 429 |
| SEC-08 | DONE | dc694940 | 公开请求 5 项通过；未知长度有界缓冲、已知长度 FixedLengthStream、额度预留与原子退款 |
| SEC-09 | DONE | 1d3f3c4 | 离线 store 8 项通过；同入口 ID 在不同账号数据库间隔离 |
| SEC-10 | DONE | 6f52d3ab | WebDAV 覆盖保持 ID/标签/收藏/ACL/分享并生成版本；分布式 COPY 501 |
| SEC-12 | DONE | 97b6acc0 + 6f52d3ab | 只读 Key PROPFIND 200、PUT 401；写 Key PUT 201 |
| SEC-11 | DONE | e308019e | 文件夹上传 6 项通过；父失败时后代不落根目录 |
| LOG-03 | DONE | e308019e | skip 不访问 session；分布式续传读取 part_objects |
| PERF-03 | DONE | e308019e | R2 direct/multipart/驱动/远程任务使用已知长度流 |
| PERF-04 | DONE | e308019e | 分片并发受全局信号量限制并支持指数退避重试 |
| LOG-01 | DONE | c8fc7aff | 207 仅移除成功项，部分失败可见 |
| LOG-02 | DONE | c8fc7aff | 实时内容 no-store，匹配 modifiedAt 的版本 URL 使用 immutable |
| LOG-08 | DONE | c8fc7aff | 外部 rename/skip/overwrite 与 S3 复制失败回滚测试通过 |
| FEAT-12 | DONE | 91819265 | 评论 5 项通过；owner/ACL/目录锁隔离、@提及与通知记录可用 |
| LOG-06 | DONE | f06c1e0f | allowList 创建/PATCH/返回/公开列表拒绝已接通 |
| UX-08 | DONE | f06c1e0f | 工具栏分组、列显隐、搜索范围说明与条目状态徽标已接入 |
| PERF-01 | DONE | 13018245 | File System Access 流式写盘；无 picker 时交给浏览器下载管理器 |
| PERF-05 | DONE | 13018245 | DAV 认证缓存 3 项通过；密码轮换立即失效 |
| PERF-08 | IN PROGRESS | 13018245 | 超时/限长代码已接入，专项超时测试未保留，需后续补验 |
| QA-01 | DONE | 本次提交 | 全量 2196 文件/26692 项通过；生产构建通过 |

## 剩余未完成项

以下任务未标记 DONE，不能在本次合并中表述为已完成：

- LOG-04、LOG-05、LOG-09、LOG-10：分享下载去重、列表分页、父子树归并、隐藏项总数。
- PERF-07、PERF-08：配额计数表；URL 上传超时/限长专项验证。
- UX-07：FilesPage 与 store-files 职责拆分。
- FEAT-01～05：跨挂载迁移、全局搜索、公开分享转存、文件夹分享 ZIP、ACL 角色/到期。
- FEAT-06、FEAT-07：秒传去重协议、文件活动审计。
- FEAT-09～11：自动备份、整盘快照、私密保险箱。
- FEAT-13～14：HEIC/转码评估、大列表性能基线。
- QA-03：真实外部驱动冒烟。

这些项目需要独立批次继续，不能通过删除测试或修改状态伪装完成。

## 验证命令

```bash
npm run typecheck
npm run typecheck:tests
npm run test:file -- <related tests>
npm run i18n:check
npm run comments:check
npm run a11y:check
npm run build
```

## 浏览器验收矩阵

- 文件：创建、上传、改名、移动、复制、删除、恢复、同名冲突。
- 安全：分享改名/移动、目录锁、ACL、公开上传、离线跨账号。
- 传输：分片上传、续传、下载、文件夹 ZIP。
- WebDAV：PUT 覆盖、COPY、LOCK、GET Range。
- UX：桌面与移动、键盘焦点、错误三态、空状态。
