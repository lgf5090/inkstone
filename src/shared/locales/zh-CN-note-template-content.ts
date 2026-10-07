export const ZH_CN_NOTE_TEMPLATE_CONTENT = {
    "template.kanban_sprint_board.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 清单]
---

\`\`\`kanban
## 待办
- [ ] 拆故事
- [ ] 定迭代目标

## 进行中
- [ ] 开第一个故事

## 已完成
- [x] 搭好看板
\`\`\`

本次迭代的目标：

风险与阻塞：
- 

{{cursor}}
`,
    "template.mindmap_reading_map.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习]
---

## 书

\`\`\`mindmap
- {{title}}
  - 核心论点
  - 结构
    - 第一部
    - 第二部
  - 我会用上的
  - 待解的问题
\`\`\`

## 章节
- 

## 值得留下的句子
> 

`,
    "template.chart_weekly_dashboard.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [每周, 表格]
---

## 本周

\`\`\`chart style=table
| 日期 | 专注小时 | 打断次数 |
| --- | --- | --- |
| 周一 | 4 | 3 |
| 周二 | 5 | 2 |
| 周三 | 3 | 4 |
| 周四 | 6 | 2 |
| 周五 | 4 | 3 |
\`\`\`

## 读数字
- 状态最好：
- 拖累我的：

## 下周只改一件事
- [ ] 

`,
    "template.timeline_milestones.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 复盘]
---

::: timeline
:: [milestone] {{date}} 启动
范围确认，责任人确定。
:: [todo] {{date}} 首个版本
:: [doing] {{date}} 内测反馈
:::

## 风险
- 

## 还没定的事
- 

`,
    "template.columns_comparison.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [决策, 表格]
---

## {{title}}

::: cols
### 方案 A
- 成本：
- 工作量：
- 风险：

::
### 方案 B
- 成本：
- 工作量：
- 风险：
:::

## 结论
> 

## 理由
- 

`,
    "template.tabs_alternatives.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [计划]
---

:::: tabs
::: tab-item 方案 A
- 目标：
- 步骤：
- 成本：
:::
::: tab-item 方案 B
- 目标：
- 步骤：
- 成本：
:::
::: tab-item 方案 C
- 目标：
- 步骤：
- 成本：
:::
::::

## 选定的
- 

`,
    "template.details_faq.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作]
---

## {{title}}

::: details [这是什么？]
> 

:::

::: details [给谁用？]
> 

:::

::: details [怎么开始？]
1. 
2. 

:::

## 还没说清的
- 

`,
    "template.callout_annotations.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作, 清单]
---

## {{title}}

> [!NOTE]
> 不打断阅读顺序的补充说明。

> [!TIP]
> 马上能派上用场的捷径。

> [!WARNING]
> 忽略就会出问题的地方。

## 用法
- [ ] 一页最多一个
- [ ] 警示放在要做动作的那句话旁边

`,
    "template.blank.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [每日]
---

{{cursor}}
`,
    "template.front_matter_only.content": `---
title: {{title}}
createdAt: {{createdAt}}
date: {{date}}
folder: {{folder}}
tags: [表格]
---

{{cursor}}
`,
    "template.daily_note.content": `---
title: {{title}}
createdAt: {{createdAt}}
date: {{date}}
tags: [每日]
---

## 今天
- [ ] 

## 随手记
- 

## 流水
- {{time}} 

## 收尾
- 做完：
- 顺延：
- [ ] 

`,
    "template.weekly_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [每周, 复盘]
---

## 做成了
1. 

## 没做成
1. 

## 数字
| 指标 | 目标 | 实际 |
| --- | --- | --- |
|  |  |  |

## 下周，按顺序
- [ ] 
- [ ] 
- [ ] 

## 有一件事该停
> 

`,
    "template.monthly_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [复盘, 目标]
---

## 这个月的目标
| 目标 | 状态 | 证据 |
| --- | --- | --- |
|  |  |  |

## 习惯
- 守住的：
- 断掉的：

## 最好的一次决定
> 

## 这个月花在了哪
- 

## 下月的主题
- [ ] 

`,
    "template.annual_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [复盘, 目标]
---

## 这一年的大数
| 方面 | 去年 | 今年 |
| --- | --- | --- |
| 健康 |  |  |
| 工作 |  |  |
| 学习 |  |  |
| 钱 |  |  |

## 一季度
- 

## 二季度
- 

## 三季度
- 

## 四季度
- 

## 想重复的
1. 

## 要留下的
1. 

## 明年，一句话说清
> 

`,
    "template.one_on_one.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 会议]
---

## 和谁
- 

## 对方的议题
1. 

## 我的议题
1. 

## 值得问的问题
- 这周卡住你的是什么？
- 最近学到了什么？
- 我们的协作方式你想改哪一处？

## 行动项
- [ ] 负责人：— 事项：
- [ ] 负责人：— 事项：

## 只记给自己的
> 

`,
    "template.rfc.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [技术, 决策]
---

## 状态
- 作者：
- 评审：
- 结论：待定

## 问题
> 

## 建议的改法
- 

## 考虑过的备选
1. 不选，因为：
2. 不选，因为：

## 上线
- [ ] 
- [ ] 

## 还没回答的
- 

`,
    "template.incident_postmortem.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [技术, 复盘]
---

## 概要
> 

## 影响
| 时间窗 | 受影响用户 | 谁发现的 |
| --- | --- | --- |
|  |  |  |

## 时间线
| 时间 | 发生了什么 |
| --- | --- |
| {{time}} |  |

## 根因
- 

## 做得好的
- 

## 做得差的
- 

## 改进项
- [ ] 
- [ ] 

`,
    "template.sop.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [清单, 工作]
---

## 什么时候跑
- 触发：
- 频率：
- 责任人：

## 步骤
1. 
2. 
3. 

## 收工前确认
- [ ] 
- [ ] 

## 例外情况
> 

## 出了岔子
- 上报给：
- 回滚方式：

`,
    "template.zettelkasten_permanent.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 写作]
---

## {{title}}

> 

## 用自己的话
- 

## 连到
- [[]]

## 被连到
- [[]]

## 出处
- 

`,
    "template.fleeting_note.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [每日]
---

## 记下了
> 

## 从哪来的
- 

## 它可能变成
- [ ] 一条永久笔记
- [ ] 一个任务
- [ ] 一个项目
- [ ] 直接删掉

## 处理期限
- {{tomorrow}}

`,
    "template.literature_note.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 写作]
---

## 来源
| 字段 | 值 |
| --- | --- |
| 作者 |  |
| 年份 |  |
| 链接 |  |

## 观点，按原文顺序
1. （页码） 
2. （页码） 

## 我的反应
> 

## 想追问的
- 

`,
    "template.map_of_content.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 技术]
---

## {{title}}

> 

## 从这里进
- [[]]
- [[]]

## 按问题
- ？→ [[]]

## 按概念
- → [[]]

## 缺口
- [ ] 

## 最近加的
- 

`,
    "template.sq3r_reading.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 清单]
---

## 1. 浏览
- 小标题：
- 图表：

## 2. 提问
- [ ] 

## 3. 阅读
> 

## 4. 合上书复述
- 

## 5. 复盘
| 问题 | 回答 |
| --- | --- |
|  |  |

## 还没懂
- 

`,
    "template.glossary.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 表格]
---

## {{title}}

| 术语 | 定义 | 首次出现 |
| --- | --- | --- |
|  |  | [[]] |

## 容易混的一对
- 与 → 

## 什么时候加
- [ ] 

`,
    "template.interview_notes.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 会议]
---

## 对象
- 谁：
- 时间：
- 目的：

## 问答
**问：** 
**答：** 

## 原话
> 

## 信号
- 

## 欠的追问
- [ ] 

`,
    "template.backlog.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 清单]
---

## 排过序的
| 事项 | 价值 | 成本 | 决定期限 |
| --- | --- | --- | --- |
|  |  |  |  |

## 冷宫
- 

## 这季度砍掉的
- 

## 怎么提一个
1. 

`,
    "template.competitive_analysis.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [技术, 表格]
---

## 是谁
| 名称 | 定位 | 价格 |
| --- | --- | --- |
|  |  |  |

## 逐项对比
| 能力 | 我们 | 他们 | 备注 |
| --- | --- | --- | --- |
|  |  |  |  |

## 我们输在哪
> 

## 我们赢在哪
> 

## 该抄的
- [ ] 

`,
    "template.decision_log.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [决策, 复盘]
---

## 决定
> 

## 背景
- 

## 否掉的选项
| 选项 | 为什么不 |
| --- | --- |
|  |  |

## 谁同意了
- 

## 什么会推翻它
- [ ] 

## 何时重看
- {{tomorrow}}

`,
    "template.onboarding_checklist.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [清单, 工作]
---

## 权限
- [ ] 

## 要见的人
- [ ] 

## 先读的
- [ ] 

## 头几件事
- [ ] 

## 第一周
| 天 | 结果 |
| --- | --- |
| 1 |  |
| 3 |  |
| 5 |  |

## 要问主管的
- 

`,
    "template.handover_doc.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 清单]
---

## 这是什么
> 

## 东西在哪
| 东西 | 位置 | 权限 |
| --- | --- | --- |
|  |  |  |

## 周期性的活
| 什么时候 | 做什么 | 问谁 |
| --- | --- | --- |
|  |  |  |

## 做了一半的
- [ ] 

## 坑
- 

## 联系人
- 

`,
    "template.ab_experiment.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [技术, 表格]
---

## 假设
> 

## 设计
| 字段 | 值 |
| --- | --- |
| 指标 |  |
| 样本量 |  |
| 跑多久 |  |
| 分流 |  |

## 护栏指标
- 

## 结果
| 分组 | 样本 | 指标 | 提升 |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |

## 结论
- [ ] 上线
- [ ] 再改
- [ ] 不做

`,
    "template.character_card.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作]
---

## {{title}}

| 字段 | 值 |
| --- | --- |
| 年龄 |  |
| 位置 |  |
| 想要 |  |
| 需要 |  |
| 伤口 |  |

## 说话方式
> 

## 小动作
- 

## 自相矛盾之处
- 

## 变化
- 开场：
- 收尾：

`,
    "template.worldbuilding.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作]
---

## {{title}}

## 规则
> 

## 代价
- 

## 谁得利
- 

## 谁受害
- 

## 大家都以为
- 

## 实际上
- 

## 它出现在
- [[]]

`,
    "template.book_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 写作]
---

## 结论
> 

## 这本书主张
1. 

## 它证得怎么样
- 

## 最好的一章
- 

## 最弱的一处
- 

## 谁该读
- [ ] 

## 谁可以跳过
- [ ] 

## 打分
| 维度 | 分 |
| --- | --- |
| 观点 |  |
| 文笔 |  |
| 用处 |  |

`,
    "template.film_review.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作, 复盘]
---

## 一句话
> 

## 它想做的
- 

## 做到没有
- 

## 定调的那场戏
> 

## 手艺
| 部分 | 成立吗 | 为什么 |
| --- | --- | --- |
| 剪辑 |  |  |
| 声音 |  |  |
| 剧本 |  |  |

## 怎么看
- [ ] 影院
- [ ] 家里
- [ ] 不看

`,
    "template.scqa_pyramid.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作, 工作]
---

## 背景
- 

## 冲突
- 

## 疑问
> 

## 答案（先说这个）
> 

## 支撑
1. 因为 
   1. 
2. 因为 
   1. 
3. 因为 
   1. 

## 顺序自检
- [ ] 读者的疑问出现在答案之前
- [ ] 每条支撑只说一件事

`,
    "template.longform_article.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作]
---

## 承诺
> 

## 导语
> 

## 第一节
### 
- 

## 第二节
### 
- 

## 转折
> 

## 第三节
### 
- 

## 收尾
> 

## 待删
- 

::: details [给编辑的话]
- 

:::

`,
    "template.medication_log.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [健康, 表格]
---

## 今天
| 时间 | 事项 | 剂量 | 反应 |
| --- | --- | --- | --- |
| {{time}} |  |  |  |

## 症状
- 位置：
- 程度（0-10）：
- 起始：

## 要问医生的
- [ ] 

## 补充
- 

`,
    "template.therapy_prep.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [健康, 复盘]
---

## 上次以来
- 

## 这周最强烈的感受
> 

## 我注意到的模式
- 

## 这次想谈的一件事
1. 

## 有用的
- 

## 没用的
- 

`,
    "template.health_metrics.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [健康, 表格]
---

## {{title}}

| 指标 | 去年 | 今年 | 参考范围 | 标记 |
| --- | --- | --- | --- | --- |
| 体重 |  |  |  |  |
| 血压 |  |  |  |  |
| 心率 |  |  |  |  |
| 空腹血糖 |  |  |  |  |
| 低密度脂蛋白 |  |  |  |  |

## 变了什么
- 

## 要复查的
- [ ] 

## 医生说的
> 

`,
    "template.quit_tracker.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [健康, 目标, 清单]
---

## 开始
- 时间：{{date}}
- 为了：
> 

## 今天
| 时间 | 冲动 | 强度 | 我改做了什么 |
| --- | --- | --- | --- |
|  |  |  |  |

## 有效的替代
- 

## 如果没扛住
> 

## 里程碑
- [ ] 24 小时
- [ ] 一周
- [ ] 一个月

`,
    "template.mood_checkin.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [健康, 每日]
---

## {{date}} {{time}}

| 维度 | 1-5 |
| --- | --- |
| 心情 |  |
| 精力 |  |
| 专注 |  |
| 焦虑 |  |

## 触发点
- 

## 我做了什么
- 

## 我需要什么
- [ ] 

## 明天
> 

`,
    "template.lesson_plan.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [学习, 计划]
---

## 班级
- 科目：
- 时长：

## 目标
> 学完学生能 

## 引入（5 分钟）
- 

## 讲授（15 分钟）
1. 
2. 

## 练习（20 分钟）
- [ ] 

## 检测
| 提问 | 好答案长什么样 |
| --- | --- |
|  |  |

## 出门小题
> 

## 下次
- 

`,
    "template.lab_notebook.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [技术, 表格]
---

## 问题
> 

## 假设
> 

## 材料
- 

## 方法
1. 

## 原始结果
| 次数 | 输入 | 输出 | 备注 |
| --- | --- | --- | --- |
| 1 |  |  |  |

## 异常
- 

## 结论
- [ ] 支持
- [ ] 推翻
- [ ] 说不清

## 下一个实验
- 

`,
    "template.client_profile.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 会议]
---

## 是谁
| 字段 | 值 |
| --- | --- |
| 公司 |  |
| 联系人 |  |
| 职务 |  |

## 他们的处境
> 

## 决策链
- 谁定：
- 谁能卡：
- 预算在谁手上：

## 时间线
- 

## 我们要的
- 

## 听到的顾虑
- 

## 下一步
- [ ] 

`,
    "template.sales_call.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [工作, 清单]
---

## 打之前
- 我要：
- 他们大概要：

## 通话中
| 话题 | 他们说 | 我说 |
| --- | --- | --- |
|  |  |  |

## 信号
- 预算：
- 决策权：
- 需求：
- 时间：

## 说定的
- [ ] 

## 跟进期限
- {{tomorrow}}

`,
    "template.case_summary.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [复盘, 写作]
---

## 案号
| 字段 | 值 |
| --- | --- |
| 事务 |  |
| 委托人 |  |
| 法院 |  |

## 事实
- 

## 争点
1. 

## 各方立场
| 方 | 主张 | 依据 |
| --- | --- | --- |
|  |  |  |

## 未决问题
- [ ] 

## 期限
| 到期 | 事项 | 责任人 |
| --- | --- | --- |
|  |  |  |

`,
    "template.flat_comparison.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [钱, 表格]
---

## 一票否决
| 房子 | 有吗 | 是什么 |
| --- | --- | --- |
|  |  |  |

## 并排看
| 项 | A | B | C |
| --- | --- | --- | --- |
| 价格 |  |  |  |
| 通勤 |  |  |  |
| 采光 |  |  |  |
| 噪音 |  |  |  |
| 收纳 |  |  |  |

## 房租之外的开销
- 

## 看过
- {{date}} 

## 倾向
> 

`,
    "template.article_outline.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作]
---

## 标题

## 核心论点
> 

## 读者

## 大纲
### 1. 开头
- 

### 2. 第一节
- 核心论点：
- 论据：

### 3. 第二节
- 核心论点：
- 论据：

### 4. 结尾
- 

## 参考资料
- 
`,
    "template.book_notes.content": `---
title: 《{{title}}》读书笔记
createdAt: {{createdAt}}
tags: [读书]
---

## 书目
- 作者：
- 开始阅读：{{date}}
- 读完：

## 核心观点
1. 

## 金句摘录
> 

## 我的想法
- 

## 行动清单
- [ ] 

## 评分
⭐⭐⭐⭐⭐
`,
    "template.brainstorm.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [头脑风暴]
---

## 主题

## 规则
- 数量优先于质量
- 过程中不批评
- 在别人的想法上继续延伸

## 原始想法
- 
- 
- 
- 

## 归类
### 类别 A
- 

### 类别 B
- 

## 优选
1. 

## 下一步
- [ ] 
`,
    "template.bug_tracker.content": `---
title: Bug：{{title}}
createdAt: {{createdAt}}
tags: [bug]
---

## 严重程度
- [ ] 致命
- [ ] 高
- [ ] 中
- [ ] 低

## 环境
- 版本：
- 系统 / 浏览器：

## 复现步骤
1. 

## 预期行为
- 

## 实际行为
- 

## 根因
- 

## 修复方案
- [ ] 

## 验证
- [ ] 修复前已复现
- [ ] 修复版本：
`,
    "template.bullet_journal.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [子弹头笔记]
---

## 未来日志
- [[月份]] · {{tomorrow}}
- [[月份]] · {{tomorrow}}
- [[月份]] · {{tomorrow}}

## 月度日志

| 日期 | 任务 | 事件 | 备注 |
| --- | --- | --- | --- |
|  |  |  |  |

## 每日日志

- [ ] 任务
- [ ] 迁移的任务 · >
- [ ] 安排的任务 · <
- 事件 · o
- 备注 · -

## 符号说明
- · 任务 · > 迁移 · < 安排 · o 事件 · - 备注
- * 优先 · ! 灵感 · ? 疑问 · x 完成
`,
    "template.class_notes.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [课堂]
---

## 课程
- 讲师：
- 主题：

## 要点
1. 

## 例子
- 

## 疑问
- [ ] 

## 课后
- [ ] 复习笔记
- [ ] 完成练习
- [ ] 请教问题
`,
    "template.cornell.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [康奈尔笔记]
---

| 线索栏 | 笔记栏 |
| --- | --- |
| 关键词、问题 | 正文笔记、图示、例子 |

> 左边写关键词和问题，右边记录笔记要点。
> 24 小时内复习：遮住笔记栏，根据线索栏复述内容。

## 总结

用自己的话在 1-3 句话内概括本页内容。{{cursor}}
`,
    "template.dev_daily.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [开发]
---

## 今日进展
- [ ] 
- [ ] 

## 实现细节
- 

## 提交 / 合并
- 

## 阻塞
- 

## 待确认
- 

## 明日计划
- [ ] 

## 今日收获
- 
`,
    "template.diary.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [日记]
---

## 心情
- 精力（1-5）：
- 心情（1-5）：

## 今日亮点
1. 

## 流水账
- 

## 感恩
- 

## 明天
- [ ] 

{{cursor}}
`,
    "template.expense_log.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [记账]
---

## 今日支出
| 项目 | 分类 | 金额 |
| --- | --- | --- |
|  |  |  |

## 分类小计
- 餐饮：
- 交通：
- 购物：
- 其他：

## 预算对照
- 每日预算：
- 今日花费：
- 本月剩余：

## 备注
- 
`,
    "template.feynman.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [费曼]
---

## 概念

## 白话解释

假装在教一个 8 岁的小孩：

> 

## 发现的知识缺口
1. 

## 简化重试

用一个比喻重新写一遍：

## 最终检查
- [ ] 不用术语能讲清楚吗？
- [ ] 能举出具体例子吗？
`,
    "template.four_quadrant.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [四象限]
---

## 1. 重要且紧急 —— 立即做
- [ ] 

## 2. 重要不紧急 —— 排期做
- [ ] 

## 3. 紧急不重要 —— 委托他人
- [ ] 

## 4. 不紧急不重要 —— 放弃或减少
- [ ] 

> 原则：把时间留给第二象限，真正重要的事都住在这里。{{cursor}}
`,
    "template.gtd.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [gtd]
---

## Inbox 收件箱
- 

## Next Actions 下一步行动
- [ ] 

## Waiting For 等待他人
- [ ] 

## Projects 项目
- [ ] 

## Someday / Maybe 将来也许
- 

## Calendar 日历
- {{today}}：
- {{tomorrow}}：

> 每周回顾：清空收件箱、更新清单，并为每个项目确定下一步的具体行动。
`,
    "template.habit_tracker.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [习惯]
---

## 习惯清单
- [ ] 
- [ ] 
- [ ] 

## 月度打卡

| 日期 | 习惯 1 | 习惯 2 | 习惯 3 |
| --- | --- | --- | --- |
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

## 复盘
- 漏了一天？别断链，明天继续就好。{{cursor}}
`,
    "template.knowledge_cards.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [卡片笔记]
---

## 核心想法

> 一句话。

## 展开

## 来源
- 

## 关联
- [[相关笔记]]

## 行动
- [ ] 

> 写得像再也不会看到原始来源一样。{{cursor}}
`,
    "template.marketing_plan.content": `---
title: {{title}} 营销策划
createdAt: {{createdAt}}
tags: [营销]
---

## 活动概览
- 目标：
- 目标受众：
- 上线日期：

## 渠道
- [ ] 社交媒体
- [ ] 邮件
- [ ] 内容 / SEO
- [ ] 付费广告

## 内容计划
| 日期 | 渠道 | 主题 | 状态 |
| --- | --- | --- | --- |
|  |  |  |  |

## 预算
| 项目 | 计划 | 实际 |
| --- | --- | --- |
| 广告 |  |  |
| 制作 |  |  |

## 成功指标
- 

## 复盘时间
- {{tomorrow}}
`,
    "template.meal_log.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [饮食]
---

## 早餐
- 

## 午餐
- 

## 晚餐
- 

## 加餐
- 

## 每日小结
- 热量：  / 
- 饮水： 杯
- 感受：
- 

> 诚实的记录胜过完美的记录。{{cursor}}
`,
    "template.meeting_minutes.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [会议]
---

## 基本信息
- 时间：
- 参会人：
- 缺席：

## 议程
1. 

## 讨论要点
- 

## 决策
1. 

## 待办事项
- [ ] 负责人：  · 截止：

## 下次会议
- {{tomorrow}}
`,
    "template.mistake_notebook.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [错题]
---

## 科目

## 原题

## 我的错误

## 正确解法

## 根本原因
- [ ] 粗心
- [ ] 知识点不熟
- [ ] 方法错误

## 重测日期
- {{tomorrow}}
`,
    "template.morning_pages.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [日记]
---

## 自由书写

想到什么写什么，不修改、不停笔。

{{cursor}}

## 今日一句

## 今日意图
`,
    "template.movie_log.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [观影]
---

## 观影清单

### {{date}}
- 片名：
- 评分：⭐⭐⭐
- 短评：
- 最喜欢的场景：

## 想看清单
- [ ] 
- [ ] 

## 年度统计
- 总数：
- 最爱：
`,
    "template.okr.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [okr]
---

## 目标一

- [ ] KR 1.1： 
- [ ] KR 1.2： 
- [ ] KR 1.3： 

## 目标二

- [ ] KR 2.1： 
- [ ] KR 2.2： 

## 每周检视
| 周次 | 进展 | 阻碍 |
| --- | --- | --- |
|  |  |  |

> 关键结果要可衡量、有挑战、有期限，每周检视一次。
`,
    "template.pdca.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [pdca]
---

## Plan 计划
- 目标：
- 现状：
- 根本原因：
- 准备采取的行动：

## Do 执行
- [ ] 
- [ ] 

## Check 检查
- 结果与计划的差距：
- 有效之处：
- 无效之处：

## Act 处理
- 保留：
- 调整：
- 下一轮开始：{{tomorrow}}
`,
    "template.pomodoro.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [番茄钟]
---

## 今日目标

## 番茄钟记录

| # | 任务 | 打断 | 完成 |
| --- | --- | --- | --- |
| 1 |  |  | [ ] |
| 2 |  |  | [ ] |
| 3 |  |  | [ ] |
| 4 |  |  | [ ] |

## 备注
- 

> 节奏：25 分钟工作、5 分钟休息；每 4 个番茄钟休息长一点。{{cursor}}
`,
    "template.prd.content": `---
title: {{title}} PRD
createdAt: {{createdAt}}
tags: [产品]
---

## 背景
- 问题：
- 为什么是现在：

## 目标
1. 

## 非目标
- 

## 目标用户
- 

## 用户故事
- 作为……，我想要……，以便……

## 功能范围
### 包含
- [ ] 

### 不包含
- 

## 验收标准
- [ ] 

## 衡量指标
- 

## 待确认
- 
`,
    "template.project_review.content": `---
title: {{title}} 复盘
createdAt: {{createdAt}}
tags: [复盘]
---

## 背景
- 项目：
- 周期：
- 目标：

## 做得好
1. 

## 做得不好
1. 

## 根因分析
- 

## 继续做
- 

## 下次改进
- [ ] 

## 经验沉淀
- 
`,
    "template.recipe.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [食谱]
---

## 菜品

## 份量

## 时间
- 备菜： 分钟
- 烹饪： 分钟

## 食材
- 

## 步骤
1. 

## 口味记录
- 评分：⭐⭐⭐
- 下次调整：

> 记得写下实际使用的调料用量。{{cursor}}
`,
    "template.shopping_list.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [购物]
---

## 生鲜食品
- [ ] 
- [ ] 

## 日用品
- [ ] 
- [ ] 

## 数码及其他
- [ ] 

## 预算
- 计划： 
- 已花： 
- 剩余： 

> 每放进购物车一件，就勾掉一件。{{cursor}}
`,
    "template.sleep_diary.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [睡眠]
---

## 昨夜
- 上床时间：
- 入睡时间：
- 醒来时间：
- 起床时间：

## 质量
- 总睡眠： 小时
- 质量（1-5）：
- 醒来次数：

## 影响因素
- 14 点后摄入咖啡因：
- 睡前使用屏幕：
- 今日运动：

## 今晚计划
- [ ] 开始放松：
- [ ] 熄灯：

> 保持规律作息，周末也一样。{{cursor}}
`,
    "template.speech_draft.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [演讲]
---

## 场合
- 活动：
- 时长： 分钟
- 听众：

## 一句话信息
> 

## 开场
- 钩子：
- 为什么讲这个话题：

## 主体
### 要点 1
- 

### 要点 2
- 

### 要点 3
- 

## 收尾
- 回顾：
- 行动号召：

## 演讲提示
- 语速：
- 停顿：
`,
    "template.story_setting.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [写作]
---

## 一句话梗概
> 

## 角色
### 主角
- 姓名：
- 想要：
- 需要：
- 缺陷：

### 反派
- 姓名：
- 想要：

## 世界观
- 背景：
- 规则：
- 冲突来源：

## 情节
### 开端
- 

### 发展
- 

### 结局
- 

## 主题
- 
`,
    "template.swot.content": `---
title: {{title}} SWOT
createdAt: {{createdAt}}
tags: [swot]
---

|  | 积极 | 消极 |
| --- | --- | --- |
| 内部 | **优势 Strengths** | **劣势 Weaknesses** |
|  |  |  |
| 外部 | **机会 Opportunities** | **威胁 Threats** |
|  |  |  |

## 策略
- SO（用优势抓住机会）：
- WO（补短板抓住机会）：
- ST（用优势化解威胁）：
- WT（避开威胁、减少劣势）：
`,
    "template.task_breakdown.content": `---
title: {{title}}
createdAt: {{createdAt}}
tags: [拆解]
---

## 大任务

**目标 / 完成标准：**

## 子任务
- [ ] 1. 
  - [ ] 细节
- [ ] 2. 
  - [ ] 细节
- [ ] 3. 

## 依赖与风险
- 

## 预估
- 总计： 小时
- 截止： 

> 每个子任务都要小到可以不用思考就开始。{{cursor}}
`,
    "template.todo_list.content": `---
title: {{title}} · {{date}}
createdAt: {{createdAt}}
tags: [待办]
---

## 今日待办
- [ ] **高优先级**
  - [ ] 
- [ ] **中优先级**
  - [ ] 
- [ ] **低优先级**
  - [ ] 

## 延后处理
- [ ] 

> 先圈出最重要的一件事，从它开始。{{cursor}}
`,
    "template.travel_guide.content": `---
title: {{title}} 旅行攻略
createdAt: {{createdAt}}
tags: [旅行]
---

## 行程概览
- 目的地：
- 日期：
- 同行人：

## 行程安排
### 第 1 天 · {{today}}
- [ ] 上午：
- [ ] 下午：
- [ ] 晚上：

### 第 2 天 · {{tomorrow}}
- [ ] 上午：
- [ ] 下午：
- [ ] 晚上：

## 预算
| 项目 | 计划 | 实际 |
| --- | --- | --- |
| 交通 |  |  |
| 住宿 |  |  |
| 餐饮 |  |  |
| 门票 |  |  |

## 行李清单
- [ ] 证件
- [ ] 

## 预订
- [ ] 机票 / 车票
- [ ] 酒店
- [ ] 

## 备注
- 
`,
    "template.weekly_plan.content": `---
title: {{title}} · 本周
createdAt: {{createdAt}}
tags: [周计划]
---

## 本周重点
1. 

## 日程
| 星期 | 任务 | 备注 |
| --- | --- | --- |
| 周一 |  |  |
| 周二 |  |  |
| 周三 |  |  |
| 周四 |  |  |
| 周五 |  |  |
| 周六 |  |  |
| 周日 |  |  |

## 下周预告
- 

> 周日复盘：哪些推进了，哪些需要重新安排。{{cursor}}
`,
    "template.weekly_report.content": `---
title: {{title}} 周报
createdAt: {{createdAt}}
tags: [周报]
---

## 本周完成
1. 

## 进行中
- 

## 需要支持
- 

## 本周收获
- 

## 下周计划
- [ ] 

## 数据
| 指标 | 目标 | 实际 |
| --- | --- | --- |
|  |  |  |
`,
    "template.workout_plan.content": `---
title: {{title}} 训练计划
createdAt: {{createdAt}}
tags: [健身]
---

## 每周安排
| 星期 | 训练重点 |
| --- | --- | --- |
| 周一 |  |
| 周三 |  |
| 周五 |  |

## 训练日志
### 推日
| 动作 | 组数 × 次数 | 重量 | 完成 |
| --- | --- | --- | --- |
|  |  |  | [ ] |

### 拉日
| 动作 | 组数 × 次数 | 重量 | 完成 |
| --- | --- | --- | --- |
|  |  |  | [ ] |

## 休息与恢复
- 睡眠： 小时
- 拉伸：[ ] 
`,
} as const

export type NoteTemplateContentKey = keyof typeof ZH_CN_NOTE_TEMPLATE_CONTENT
