# 状态模型统一说明

本文档先统一“扫描 / 回评 / 回访”三条链路对外解释时使用的语义状态，不直接修改数据库里的原始枚举值。

当前策略是：

- DB 继续保存各模块自己的原始状态，避免一次性迁移带来兼容风险。
- 服务端和后续统计口径通过 `src/domain/status-model.mjs` 把原始状态映射到统一语义。
- 前端可以逐步切换到统一语义，不要求一次改完。

## 1. 统一语义状态

统一后的状态只保留 7 类：

| 统一状态 | 含义 | 是否终态 | 是否可继续重试 |
| --- | --- | --- | --- |
| `pending` | 已入队，尚未开始或已完成前置步骤，等待下一步推进 | 否 | 是 |
| `running` | 当前正在执行中 | 否 | 是 |
| `succeeded` | 目标动作已经完成 | 是 | 否 |
| `retryable_failed` | 本轮失败，但补齐条件后通常可以重试 | 否 | 是 |
| `terminal_failed` | 当前语义上已经阻断，不应自动重试 | 是 | 否 |
| `skipped` | 明确跳过，不再继续 | 是 | 否 |
| `uncertain` | 已做过动作或拿到结果，但结果未完全确认 | 否 | 是 |

补充理解：

- `uncertain` 主要用于“动作可能已经发生，但系统没拿到足够确认信号”的场景。
- `terminal_failed` 和 `skipped` 都是终态，但前者代表异常阻断，后者代表有意跳过。
- `retryable_failed` 不是终态，它强调“失败了，但仍属于流程内可恢复分支”。

## 2. 回评链路映射

来源：`work_comments.reply_status`

| 原始状态 | 统一状态 | 说明 |
| --- | --- | --- |
| `pending` | `pending` | 待执行 |
| `prepared` | `pending` | 兼容旧状态，语义仍是待执行 |
| `succeeded` | `succeeded` | 回评成功 |
| `manually_replied` | `succeeded` | 人工已回，按“已完成”对待 |
| `blocked` | `terminal_failed` | 需要人工判断，不应自动推进 |
| `sent_unverified` | `uncertain` | 发送过但未完全确认 |
| `skipped` | `skipped` | 明确忽略 |

说明：

- 这里把 `manually_replied` 并入 `succeeded`，是为了统一“结果已经完成”的外部语义。
- `sent_unverified` 暂不并入成功或失败，保留为 `uncertain` 更安全。

## 3. 回访链路映射

来源：`return_visit_tasks.status`

| 原始状态 | 统一状态 | 说明 |
| --- | --- | --- |
| `pending_visit` | `pending` | 待回访 |
| `content_collected` | `pending` | 前置资料已齐，等待后续推进 |
| `comment_generated` | `pending` | 文案已生成，等待落地 |
| `pending_execute` | `pending` | 待执行真实动作 |
| `collecting_content` | `running` | 正在收集内容 |
| `executing` | `running` | 正在执行 |
| `done` | `succeeded` | 回访完成 |
| `failed_collect` | `retryable_failed` | 补齐资料或重开页面后可重试 |
| `failed_generate_comment` | `retryable_failed` | 重新生成后通常可重试 |
| `failed_like` | `retryable_failed` | 真实动作失败，但通常仍可补救 |
| `failed_comment` | `retryable_failed` | 评论动作失败，但通常仍可补救 |
| `failed` | `terminal_failed` | 已落入通用失败终态 |
| `skipped_no_work` | `skipped` | 明确跳过 |
| `skipped_private` | `skipped` | 明确跳过 |
| `skipped_no_suitable_work` | `skipped` | 明确跳过 |

说明：

- 回访链路里的 `failed_collect` / `failed_like` / `failed_comment` 先统一视为“可重试失败”。
- 真正不可自动恢复的失败，才进入 `failed -> terminal_failed`。

## 4. 扫描链路映射

来源：`interaction_events.status`

| 原始状态 | 统一状态 | 说明 |
| --- | --- | --- |
| `new` | `pending` | 新线索，待处理 |
| `planned` | `pending` | 已规划，但未完成 |
| `prepared` | `pending` | 兼容旧动作语义 |
| `running` | `running` | 执行中 |
| `replied` | `succeeded` | 已闭环 |
| `succeeded` | `succeeded` | 已闭环 |
| `blocked` | `terminal_failed` | 已阻断 |
| `failed` | `terminal_failed` | 已终止失败 |
| `skipped` | `skipped` | 已跳过 |
| `sent_unverified` | `uncertain` | 已执行但未完全确认 |

说明：

- 扫描链路里部分状态来自旧 action/event 体系，所以这里是“统一解释层”，不是要求所有表马上完全一致。
- 只要进入统一映射层，后续统计和跨模块推理都优先看统一状态，而不是直接比较原始枚举名。

## 5. 当前落地范围

本轮已落地：

- 新增统一映射模块：`src/domain/status-model.mjs`
- 新增单元测试：`tests/unit/status-model.test.mjs`
- 服务端统计接口 `/api/stats` 新增统一分布字段：
  - `normalizedReplyStatusDistribution`
  - `normalizedVisitStatusDistribution`
  - `normalizedEventStatusDistribution`

本轮暂不做：

- 不修改数据库 CHECK 约束
- 不重命名现有表字段值
- 不一次性替换前端所有状态文案和颜色逻辑

## 6. 后续建议

建议下一步分两段做：

1. 前端列表页和 badge 改为优先消费统一状态，再保留原始状态做补充说明。
2. 把回评、回访、扫描三个模块里的“是否终态 / 是否可重试 / 是否应展示为异常”判断，全部收口到统一模块里。
