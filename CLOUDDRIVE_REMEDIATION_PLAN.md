# CloudDrive 整改计划

> 基准提交：`7592a935aa9777a3d765e9ffcf0ef8d2fdeb467b`  
> 分支：`fix/clouddrive-remediation`  
> 状态：执行中  
> 规则：每个任务完成后提交原子 commit，并实时更新本文件；未验证项不得标记 DONE。

## 当前批次

- [x] PLAN-00 建立独立 worktree、实时计划文档与验证环境
- [ ] SEC-01 分享根按 file_id 解析并处理改名/移动
- [ ] SEC-02 重命名/移动迁移 Meta、unlock、请求、同步和 Key 路径
- [ ] SEC-03 ACL 查询绑定 mount_id
- [ ] SEC-04 ACL 保存遵守目录锁和隐藏规则
- [ ] SEC-05 外部缩略图统一授权、MIME、大小与安全头
- [ ] SEC-06 普通分享执行默认/最大有效期策略
- [ ] SEC-07 分享预算、Cookie 与路径隐私收口
- [ ] SEC-08 公开请求上传流式限长与额度预留
- [ ] SEC-09 离线缓存按用户隔离
- [ ] SEC-10 WebDAV 覆盖写与分布式 COPY 修复
- [ ] SEC-11 文件夹上传父失败时跳过整个子树
- [ ] SEC-12 API Key 增加只读 scope
- [x] SEC-13 驱动统一出站 SSRF 护栏
- [ ] SEC-14 ACL 用户名枚举与通用错误响应
- [ ] LOG-01 客户端正确处理 207 部分成功
- [ ] LOG-02 可变内容缓存版本化
- [ ] LOG-03 上传 skip 与分布式续传修复
- [ ] LOG-04 分享下载按访客/文件/窗口去重
- [ ] LOG-05 分享、ACL、最近列表游标分页
- [ ] LOG-06 清理或接通 allow_list 等死配置
- [x] LOG-07 Jobs 前后端权限契约统一
- [ ] LOG-08 外部写入冲突策略与 S3 MOVE 可恢复化
- [ ] LOG-09 父子同选移动保持树结构
- [ ] LOG-10 隐藏项 total 修正
- [x] LOG-11 凭证解密错误带上下文
- [ ] PERF-01 前端下载流式落盘
- [x] PERF-02 ZIP 按需打开对象流
- [ ] PERF-03 服务端分片流式写入
- [ ] PERF-04 单文件分片并发与自动重试
- [ ] PERF-05 WebDAV 短期认证会话缓存
- [x] PERF-06 移除每请求主挂载初始化写
- [ ] PERF-07 配额计数表与定时校准
- [ ] PERF-08 URL 上传超时、限流与流式限长
- [ ] UX-01 公开页接入统一 API 服务层
- [ ] UX-02 跨 feature 引用改公开入口
- [ ] UX-03 设置、最近、分享浏览补齐错误三态
- [ ] UX-04 移动端 Inspector 改 Drawer/dialog
- [ ] UX-05 表单错误 ARIA 关联与键盘路径
- [ ] UX-06 设计令牌、i18n 与死代码清理
- [ ] UX-07 拆分 FilesPage 与 store-files 职责
- [ ] UX-08 文件列表工具栏、列与搜索体验
- [ ] UX-09 补齐 lint、测试、build、a11y 门禁
- [ ] FEAT-01 跨挂载复制/移动/迁移
- [ ] FEAT-02 跨盘全局搜索与 FTS5
- [ ] FEAT-03 公开分享转存到我的网盘
- [ ] FEAT-04 文件夹分享打包下载
- [ ] FEAT-05 ACL 权限分级与到期授权
- [ ] FEAT-06 SHA-256 秒传与内容去重
- [ ] FEAT-07 文件活动审计与异常提醒
- [ ] FEAT-08 元数据与配置备份导出
- [ ] FEAT-09 自动备份与后台同步
- [ ] FEAT-10 整盘快照与时间点恢复
- [ ] FEAT-11 私密保险箱
- [ ] FEAT-12 文件评论与 @提及
- [ ] FEAT-13 媒体增强：HEIC、续播、转码评估
- [ ] FEAT-14 大列表虚拟滚动
- [ ] QA-01 单元、类型、静态门禁与构建
- [ ] QA-02 外部浏览器关键链路验收
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
| FEAT-08 | IN PROGRESS | f5de7cf1 | 后端配置导出与脱敏测试通过；设置页入口待接 |
| FEAT-13 | IN PROGRESS | 16cd1663 | 音视频续播与账号隔离已实现；HEIC/转码仍待评估 |
| FEAT-06 | IN PROGRESS | 75215bf8 | 增量 SHA-256 工具与测试通过；上传去重协议待接 |
| FEAT-14 | IN PROGRESS | 8b35bf97 | 列表/网格/相册启用 content-visibility；大列表性能实测待做 |
| SEC-12 | IN PROGRESS | 97b6acc0 | scope 模型与迁移兼容测试通过；DAV 方法级检查待接 |
| UX-09 | IN PROGRESS | 本次提交 | 新增 gates:full；全量类型、测试与构建待跑 |

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
