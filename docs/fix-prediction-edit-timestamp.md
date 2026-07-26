# 多设备预测覆盖修复记录（edited_at 仲裁）

分支：`fix/prediction-edit-timestamp`（commit `97d600c`）。日期：2026-07-26。

## 背景

预测值是本应用唯一不可再生的数据（用户手工输入），但云端保存是"按到达顺序
无条件覆盖"（LWW）：

- `save_my_prediction_values` 直接 upsert，mutation 不携带编辑时间；
  一台离线多日的设备上线重放旧 outbox，会静默覆盖另一台设备较新的输入。
  历史快照有 `savedAt >=` 保护，预测值没有——保护不对称。
- 从云端加载（hydrate）预测后会误置 `hasUnsavedChanges=true`，30 秒自动
  保存随即回写云端：一台只是"打开看过"旧数据的设备也会周期性写云，成为
  覆盖问题的放大器。07-13 之后的提交全是在修此类"刷新/保存冲掉数据"的
  bug，本修复处理其根因。

## 决策

### 客户端（src/utils/cloudPredictionStorage.ts、cloudOutbox.ts、supabase.ts、App.tsx）

- `CloudPredictionValueMutation` 增加 `editedAt`：模块级单调时钟
  （`max(Date.now(), prev+1)`）打戳，同一批变更共享同一时间戳。
- 登录时用服务器返回的 `updated_at`（loader 已含 `max(edited_at)`，见下）
  播种时钟——慢时钟设备登录后的编辑仍能胜过云端存量。
- 旧格式 outbox（无 `editedAt`）读取时用 outbox 自身的 `updatedAt` 回填，
  旧重放不能伪装成新编辑；outbox 去重按 `editedAt` 保留最新。
- 保存队列新增 `onRejected`：服务端拒绝的单元格带存活值返回，客户端把
  它应用回本地工作区收敛视图；若用户已重新编辑同格（pending 中有更新
  值），则本地优先、不回退。
- 收到任何服务端时间戳（登录播种、拒绝反馈）都推进本地时钟，保证下一次
  编辑必然胜出。
- hydrate 不再置脏：删除"预测变化即 `setHasUnsavedChanges(true)`"的
  effect，脏标记只在真实编辑路径 `persistPredictionDraft` 中置位。

### 服务端（supabase/20260726_prediction_value_edited_at.sql）

- `user_prediction_values` 增加 `edited_at` 列，存量行回填自 `updated_at`。
- `save_my_prediction_values` 改为条件 upsert：仅
  `excluded.edited_at >= 现有 edited_at` 时写入（与历史快照的 `savedAt`
  保护对齐）；被拒单元格以行集返回存活值。
- 清除操作改为空值墓碑而非 delete：删除也留下仲裁基线，旧设备重放无法
  复活已删的值；墓碑 90 天后随保存清扫；loader 聚合时过滤空值。
- 客户端时间戳夹钳到 `now() + 2 分钟`：合法时间戳只会落后服务器（网络
  延迟）或超前毫秒级（单调递增 bump），更远的未来戳都是错误时钟，夹紧
  可把"快时钟设备压制他人编辑"的窗口限制在 2 分钟内。
- `get_my_prediction_workspace` 的第二返回值（播种源）加入
  `max(edited_at)`：`edited_at` 是客户端戳，可能超前所有服务端写入的
  `updated_at`，不纳入则快时钟设备会压制其他设备登录后的编辑。
- `replace_my_prediction_workspace`（全量导入）重建：先把现存行降级为
  `now()` 墓碑再灌入导入值，导入未包含的单元格保留仲裁基线，旧 outbox
  重放不能复活被导入丢弃的值（原实现是整表 delete，基线全失）。

### 新旧版本互操作

- 旧客户端（已发布 EXE/APK/旧 Pages 页）调新 RPC：缺 `edited_at` 字段
  → `coalesce(..., now())`，保持原 LWW 行为；RPC 返回值从 void 变行集，
  旧代码忽略 data，不受影响。
- 新客户端调旧 RPC（迁移未执行）：`jsonb_to_recordset` 忽略多余键；
  返回 void → 解析为空数组。功能可用，仅仲裁不生效。
- 部署顺序：先在 Supabase SQL 编辑器执行迁移，再发新前端最稳妥；顺序
  反了也不出错。

## 拒绝的方案

- 服务端 `now()` 当仲裁戳：离线重放到达时间晚于新编辑，恰好判反。
- 向量时钟/CRDT：单人多设备场景过重；单调播种时钟已覆盖主要偏差。
- 拒绝时弹窗让用户选择：单元格粒度冲突频率低、语义清晰（新编辑胜出），
  静默收敛+可重新编辑更符合使用习惯。

## 风险控制（对抗审查确认后修复的问题）

15 个审查代理确认 8 项缺陷，均已在提交前修复：

- 播种源漏 `max(edited_at)`（快时钟设备压制他人登录后编辑）→ 已补。
- 夹钳 1 小时过宽 → 收紧到 2 分钟。
- 全量导入删光仲裁基线 → 改为墓碑化。
- 墓碑守护测试正则锚点无效 → 改为逐条 delete 语句断言。
- edit clock 播种、`normalizeRejectedPredictionRows` 无功能测试 → 已补
  （补测试时抓到解析器漏校验股票代码/日期格式的真 bug，一并修复）。

已知残留（设计边界）：对端设备在本机登录之后才写入的未来戳，无法靠登录
播种覆盖，首次编辑会被拒一次并经拒绝反馈推进时钟，用户重输一次即生效；
窗口被 2 分钟夹钳约束。

## 验证

- `tsc -b` 通过；126 个测试全绿（原 122 + 新增：时间戳单调性、旧 outbox
  回填、去重取新、onRejected 竞态、SQL 迁移契约、hydrate 不置脏、
  rejected 行解析校验）；`verify:ma` 通过。

## 回滚

- 前端可直接回滚（旧代码兼容新 schema，见互操作一节）。
- 数据库不建议回滚：`edited_at` 列与墓碑对旧 RPC 无害；如必须还原
  `save_my_prediction_values`，重新执行
  `supabase/20260711_normalized_predictions.sql` 中对应 create or
  replace 段即可（先 `drop function` 因返回类型不同），墓碑行会被旧
  delete 分支自然清掉。
