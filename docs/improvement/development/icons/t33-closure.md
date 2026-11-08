# 开发模块 · 图标子模块结项说明（T33）

> 分支：`feat/development-icons`。本文件只描述已落地的 v1 边界、数据形态、迁移与回滚，不替代 `plan-1.md`。

## 1. 模块边界

- 入口：`/development/icons`（前端）、`/api/development/icons/*`（Worker，全部 `requireAuth`；对象读取路由除外）。
- 个人图标资产库：数据按 `user_id` 隔离；不做公共图标浏览器。
- 支持：SVG/PNG/JPG/WebP 上传、去重、标签/集合、收藏/置顶、FTS 搜索、游标分页、详情、原图/缩略图、批量 PNG/ICO/sprite、ZIP/sprite 导出、Iconify 按需导入、用户配额与 owner 硬上限。
- 不做：字体文件、PDF、公共浏览、ZIP 导入、任意尺寸 PNG（固定预设 24/48/96/192/512）。
- 公开缓存边界：只有 `development/icons/{svg,png,jpg,webp,ico,sprite}/...` 下的图片/CSS/JSON 走公开不可变缓存；manifest、任务状态、统计、导出下载均为 `private, no-store`。

## 2. 数据表与索引

迁移 320（13 张业务表 + FTS 影子表）：

| 表 | 用途 |
|---|---|
| `development_icons_collections` | 集合与许可证/来源 |
| `development_icons_assets` | 图标主表（内容哈希、R2 键、缩略图键） |
| `development_icons_tags` | 标签（`parent_id` 层级） |
| `development_icons_tag_links` | 图标-标签多对多 |
| `development_icons_user_state` | 收藏/置顶/使用次数 |
| `development_icons_usage_daily` | 按日使用统计 |
| `development_icons_imports` | 导入任务 |
| `development_icons_import_items` | 导入逐项结果 |
| `development_icons_exports` | 导出记录与 TTL |
| `development_icons_jobs` | 转换任务（含 `execution`） |
| `development_icons_job_items` | 转换逐项状态/产物 |
| `development_icons_fts` | FTS5 trigram 搜索 |
| 触发器 4 个 | assets/collections 变更同步 FTS |

迁移 321：`development_icons_settings`（用户配额）、`development_icons_limits`（owner 硬上限，单行 `id=1`）。

迁移 327：`development_icons_job_outputs`（产物字节台账，配额与清理依据）。

索引清单（24 + 1 + 1）：`idx_development_icons_collections_{slug,order}`、`assets_{hash,collection,recent,updated,name,format}`、`tags_{name,parent}`、`tag_links_{tag,asset}`、`state_{fav,pin,used}`、`usage_{day,asset}`、`imports_recent`、`import_items_status`、`exports_{recent,expiry}`、`jobs_{recent,status}`、`job_items_status`、`job_outputs_job`。

## 3. 迁移版本表

| 版本 | 内容 | 说明 |
|---|---|---|
| 320 | 图标核心表/索引/FTS | 本子模块 |
| 321 | 配额设置与硬上限 | 本子模块 |
| 327 | job outputs 台账 | 本子模块；327 起，避免与密码管家 325/326 撞号 |
| 328 | jobs.execution 列 | 记录 queue/browser 执行方式 |

- 约定：迁移号必须全局唯一。开工前复核实际最大号；318/319 属 WebSSH，325/326 属密码管家，322–324 属 certhub。
- 干净 D1 首次启动后 `schema_migrations` 应为且仅为 `320/321/327/328` 各一次（另有其他模块历史版本）。

## 4. R2 路径约定

```
development/icons/svg|png|jpg|webp/u{shard}/{h2}/{h4}/{sha256}.{ext}
development/icons/png/u{shard}/{h2}/{h4}/{sha256}-w{size}.png
development/icons/ico/u{shard}/{h2}/{h4}/{sha256}-ico-{sizes}.ico
development/icons/webp/u{shard}/{h2}/{h4}/{sha256}-w{96|192}.webp
development/icons/sprite/u{shard}/{setHash}/sprite.svg|png|@2x.png|json|css|scss
development/icons/manifests/u{shard}/{jobId}.json      # private
development/icons/exports/{format}/u{shard}/{exportId}.{ext}  # private
```

- `shard = sha256("inkstone:icons:" + userId)` 前 8 位；路径不含用户名/文件名，不可枚举。
- 同一源 + 同一配方命中同一 key；配方变化（尺寸/padding/倍率）产生新 key，不覆盖旧产物。
- sprite `setHash = sha256(排序后的 assetSha + 配方)`。

## 5. 配额与上限默认值

| 项 | 默认 | 硬上限默认 |
|---|---|---|
| 用户容量 | 512 MB | 2 GB |
| SVG 单文件 | 256 KB | 1 MB |
| 栅格单文件 | 5 MB | 20 MB |
| 单边尺寸 | 4096 | 8192 |
| 单批任务 | 500 | 500 |
| ZIP 大小/条目 | 50 MB / 1000 | 200 MB / 5000 |

- 有效值 = `min(用户值, 硬上限)`；owner 可改硬上限。
- 降配低于已用容量：允许，进入只读超限态；不能新增上传/转换，可删除或调高。
- 产物计入配额：`used = assets.bytes + job_outputs.bytes + 未过期 exports.bytes`。
- 任务创建时每用户仅允许 1 个 queued/running；每分钟创建预算 12 次（per-isolate）。

## 6. 回滚方式

1. 代码回滚：`git revert` 对应提交，或部署上一版本 Worker。R2 对象与 D1 行仍保留，不影响旧版本读取。
2. 关闭入口：从 `DevelopmentSidebar` 移除 `icons` 项即可隐藏 UI；API 可保留。
3. 数据库回滚：
   - 327/328 是增量（新表 + 新列），旧代码不读取即可安全共存；**不需要**立即删表。
   - 确需清理时，先确认没有其他分支复用 327/328：
     ```sql
     DROP TABLE IF EXISTS development_icons_job_outputs;
     ALTER TABLE development_icons_jobs DROP COLUMN execution; -- SQLite 3.35+；否则重建表
     DELETE FROM schema_migrations WHERE version IN (327,328);
     ```
   - 320/321 的 13 张表承载用户资产，回滚会丢数据；回滚前先导出 `development_icons_assets` 与 R2 对象清单。
4. R2 清理：按 `development_icons/` 前缀与 manifest 引用计数回收；不要按用户目录整体删除。

## 7. 未验项与部署后验证清单

未在本机验证：
- Cloudflare 边缘缓存命中率与 `cf-cache-status`（本地无边缘）。
- 真实显示器下的绝对 55 FPS（本机 Xvfb 空白页基线 50.6 FPS，生产构建相对基线 100%）。
- 浏览器端 500 项转换的耗时随设备差异（本机有头 Chromium：71.5 s，P95 1007 ms，内存峰值 137 MB）。

已实测：
- 500 资产 × PNG 5 尺寸：47.4 s，0 失败。
- 500 资产 × ICO 4 尺寸 × 2 批（共 1000 ICO）：31.0 s，0 失败。
- 500 资产 sprite（1x/2x + JSON/CSS/SCSS）：5.5 s，0 失败；产物 48.9 KB / 127.6 KB / 67.5 KB / 25.5 KB / 25.3 KB。
- 缩略图回填 9,802 条：45.2 s，0 失败；首屏 60 个从 13.8 KB（SVG）变为 40.9 KB（WebP）。
- 1 万条滚动（生产构建）：50.63 FPS；同环境空白页基线 50.64 FPS。
- 列表 21–23 ms、搜索 26–34 ms（9,802 条）。

部署后必须验证：
1. `GET /api/development/icons/bootstrap` 返回 `schemaVersions=[320,321,327,328]`。
2. 上传 SVG/PNG 后 `thumbUrl` 指向 `-w96.webp`，原图按需加载。
3. `POST /jobs` 返回 `mode=queue`（有 Queues）或 `browser`；任务最终 `done/partial` 且有产物。
4. 下载 PNG 为透明背景、尺寸与预设一致；ICO `file` 识别为多尺寸；sprite 的 CSS/JSON 坐标可用。
5. 降配额到已用以下：页面出现只读横幅，上传/转换被 413 拒绝。
6. owner 修改硬上限后，用户有效值按 `min()` 收敛。
7. `curl -I` 同一图标对象两次，确认 `cf-cache-status: HIT` 且 `cache-control` 为 immutable。
8. Iconify 导入后检查集合许可证/来源字段与 UI 展示。
