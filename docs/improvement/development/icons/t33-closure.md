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

## 8. 整库导入、体量与压测数据清理（2026-11-08）

> 第 7 节的 9,802 条是整库导入前的基线；以下是本轮最终数字。

### 8.1 整库导入

- 数据来源：jsDelivr `@iconify-json/<prefix>/icons.json` + `info.json`，只取 canonical `icons` 名（不取 aliases，避免同内容多名重复落库）。
- 机制：创建导入时下载整包 → 写入 R2 暂存 `development/icons/imports/<shard>/<id>/manifest.json` + `chunk-N.json`（每片 50 枚）→ 每个 step 读一片、清洗 SVG、并行写 R2、批量写 D1；`processed_items` 作为续传游标。支持取消、失败项列出（`error` 字段 + `GET /imports/:id/items?status=failed`）。
- 去重：`collection:name` 唯一 + SHA-256 内容去重；同内容不同名的记录标 `duplicate`，不计入“缺失”。集合详情展示 total / imported / missing / duplicates / 最后导入时间，并提供「补齐缺失」。
- 九集合实际入库（本地 D1）：

| 集合 | 源总数 | 已导入 | 缺失 |
|---|---:|---:|---:|
| Material Symbols | 16,491 | 16,381 | 0 |
| Phosphor | 9,161 | 9,158 | 0 |
| Tabler Icons | 6,305 | 6,280 | 0 |
| Simple Icons | 3,740 | 3,739 | 0 |
| Remix Icon | 3,229 | 3,153 | 0 |
| Lucide | 2,109 | 2,108 | 0 |
| Bootstrap Icons | 2,084 | 2,082 | 0 |
| HeroIcons | 1,288 | 1,281 | 0 |
| Feather Icon | 255 | 254 | 0 |
| **合计** | **44,662** | **44,436** | **0** |

- 源总数与导入数的差额来自内容重复（同名内容或不同名同图），按 `duplicate` 记录；九集合 `missing` 均为 0。
- 整库导入总耗时 304.8 s（44,436 枚，后台任务，不阻塞首屏）。补缺测试：Feather 补齐 1 枚重复内容后 `imported` 仍为 254、`duplicates=1`、`missing=0`，集合总数不变。

### 8.2 体量与存储

- D1：44,436 行资产；单表 + 现有索引容量充裕，**不需要分表**。
- 原始资源 26.9 MB；账号用量 56.9 MB / 512 MB；D1 文件 121 MB。
- 缩略图：每枚 96px + 192px WebP，列表只加载 `-w96.webp`。
- R2：清理压测数据后本地 bucket 509 MB（含其他历史产物），其中图标资产对象 117,007 个。
- 迁移：实际最大号 328（320/321/327/328）；329 归密码管家分支；本轮未新增 ≥330 迁移。

### 8.3 清理后复测（44,436 条，有头 Chromium，1440×900）

| 指标 | 清理后 | 清理前（54,239 条） |
|---|---:|---:|
| bootstrap | 265 ms | 317 ms |
| 首页数据 | 54 ms | 68 ms |
| 搜索（`zig`） | 81 ms | 235 ms |
| 搜索（`%`） | 90 ms | 100 ms |
| 首屏载荷 | 109 KB | 109 KB |
| 滚动加载 | 13,320 条 / DOM 80 | 13,320 条 / DOM 80 |
| 帧率 | 61 FPS（2,007 ms / 122 帧） | 60 FPS |

### 8.4 卡片与布局

- 卡片最小 **96×160**；1440 下 8 列、1024 下 6 列、390 下 3 列。
- 名称固定两行（`line-clamp-2`），长名 `arrow-down-a-z` 不再半截；完整名挂 `title`。
- 复制/下载/收藏/更多位于卡片底部固定操作区，悬浮时不再被 `overflow` 裁切；选中复选框覆盖在图标角。
- 密度滑杆 0–2 与 80/96/128 三档双向联动；工具栏、筛选分组、排序、视图切换均为图标 + 文字，纯图标按钮带 Tooltip 与 `aria-label`。

### 8.5 压测数据清理记录

- 目标：`collection_id IS NULL` 的 9,803 条资产（非九集合资产）。
- 留档清单：`docs/improvement/development/icons/stress-orphan-cleanup-2026-11-08.csv`（9,803 行 + 表头，2.7 MB，sha256 `a0a3039e42ca4435cbafc5f1adab44a915c718b71ab4f43f974c91dbb0acd0ce`），字段 `id,name,format,bytes,r2_key,thumb_key,created_at`。
- 构成判断：9,800 条 `seed-*` SVG（压测播种，`seed-0`–`seed-9799`，创建于 2026-11-08 01 时）+ 3 条 `upload-svg/upload-png/upload-jpg` 测试夹具（02 时）；无标签、无集合、`source_url` 为空。未发现真实用户上传，按压测遗留处理。
- 删除方式：复用 `POST /api/development/icons/assets/batch`（`action=delete`），每批 100 条，共 99 批（含 1 次单条验证），耗时 182 s，0 失败；每轮重新查询 `collection_id IS NULL`，天然可重入。R2 同时删除原图、`-w96.webp`、`-w192.webp`。
- 清理结果：
  - D1 资产 54,239 → **44,436**；`collection_id IS NULL` = 0；九集合计数不变。
  - R2 对象 146,416 → 117,007（-29,409 = 9,803 × 3）；目标对象残留 0；blob 目录 623 MB → 509 MB。
  - 九集合 stats 复核：`missing` 全部为 0，`status=done`。
  - 转换任务历史 `job_items` 仍有 4,502 行指向已删资产；该表仅作任务台账，列表读路径为 INNER JOIN，不会显示或报错，本轮未删。
