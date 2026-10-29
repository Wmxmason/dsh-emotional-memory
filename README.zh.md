# DeepSeek Harness 情绪记忆插件

只处理 QQ 机器人会话：聊天时保存文字观察，每天北京时间 04:00 整理长期记忆，根据情绪强度、真实再次提及和明确保留请求管理六级记忆期限，然后创建一个空白原生会话，把 QQ 对话切过去。新会话使用同一份长期记忆、交接摘要和原来的人设配置。

## 已验证的环境

- 自动轮换验证环境为 Windows Desktop 内置 Harness SDK `0.2.1-rc.3`、Cordis `4.0.5`。
- 本机 QQ 通道为 `@tencent-connect/dsh-qqbot 0.5.2`。
- 自动测试使用真实 QQ SessionManager、Cordis、Session、工具定义、消息装配器及原生 Agent 维护通道；模型响应和 QQ 传输使用合成实现，不联系 QQ 用户或调用付费 API。
- 安装依赖范围也接受 SDK `0.2.1-rc.2`，但该版本及其他 SDK 版本暂未运行验证，不在本次已验证的支持范围内。运行时的 `@deepseek-ai/*` 依赖由 Harness 提供，不需要额外数据库、Embedding 服务或 API Key。

## 安装

推荐安装打包产物：

从 [GitHub Releases](https://github.com/Wmxmason/dsh-emotional-memory/releases/latest) 下载安装包，完整退出 Harness 后执行安装命令。使用者需要先配置自己的模型 API 和 QQ 机器人；本插件不附带个人记忆、人设或凭据。

```powershell
dsh plugin --profile desktop add 'C:\path\to\dsh-emotional-memory-0.3.1.tgz'
```

若 `dsh` 不在 PATH，本机 Windows Desktop 的命令位于：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add 'C:\path\to\dsh-emotional-memory-0.3.1.tgz'
```

升级后重新打开 Harness，再从 QQ 发一条普通消息，让适配器登记对应的 QQ 对话。安装命令会把声明了 bundle patch 的包加入 `dsh.profile.bundles`，由宿主读取包内的 `cordis.patch.yml`；已有配置覆盖继续生效。卸载使用同一入口的 `plugin --profile desktop remove dsh-emotional-memory`，数据文件由用户保留。

## 使用

可以直接在 QQ 对机器人说：

- “记住：以后请叫我小林。”机器人可以即时调用 `memory_save`。
- “查一下你记住了哪些与公园有关的事情。”调用 `memory_search`。
- “忘掉这条记忆。”先搜索定位 id，再调用 `memory_forget`。
- “现在整理一下当前聊天的记忆。”调用 `memory_run_daily`，在当前轮结束后执行。
- “查看记忆状态。”调用 `memory_status`。

日常捕获和北京时间每日整理不依赖机器人主动调用工具；明确保存和维护工具用于即时需求。手动操作始终限于调用工具的当前会话。

`memory_save` 返回实际保存记录的 JSON，包括 id、内容、类型、情绪强度、重要度、可信度、历史强化次数与时间；`memory_search` 返回同样字段。六级模式还会输出 `topic`、`keywords`、`level`、`levelHits`、`mentionCount`、`lastMentionedAt`、`expiresAt`。确认保存参数时直接核对工具结果。

## 查看整理进度

`memory_status` 返回 `processingDate` 和 `maintenance`。其中 `remaining` 是当前待整理观察数量，`batches`、`processed` 是本次维护尝试已提交的批次和观察数量，`lastProgressAt` 是最近成功提交的时间，`running` 表示当前宿主是否持有该范围的维护任务。

六级模式还返回 `memoryModeVersion`、`migrationRemaining`、各级活跃记录数 `levels`、`modeActivatedAt`、`lastKeywordCleanupAt` 与 `nextKeywordCleanupAt`。这些时间均为 Unix 毫秒时间戳；`migrationRemaining` 为仍待重分类的活跃旧记录数。

状态包括 `queued`（已请求）、`running`（执行中）、`partial`（本次批次用完，稍后继续）、`deferred`（暂不能进入维护）、`retry-pending`（失败后等待重试）、`context-pending`（整理已保存，等待活动会话应用）、`complete`（本轮完成）。重启后保留的运行快照不直接视为仍在执行，工具会显示等待恢复。

| reason | 含义 |
| --- | --- |
| agent-busy | 用户回合正在运行 |
| maintenance-busy | 原生维护通道已被另一项工作占用；外部状态也可能显示 idle |
| batch-limit | 本次最多处理的批次已用完 |
| routing-error | QQ 路由检查失败，原会话和待整理观察保留并重试 |
| request-timeout | 模型请求超过超时限制 |
| model-truncated | 模型输出达到 token 上限，整批保留 |
| model-error | 模型请求失败；结合 `maintenance.modelFailure` 查看安全错误码 |
| request-cancelled | 模型请求被取消 |
| unexpected-tool-calls | 整理响应尝试调用工具，未生成所需的最终文本 |
| model-incomplete | 其他不正常的模型结束状态 |
| invalid-model-json / invalid-model-response | 模型响应不符合整理格式，整批保留 |
| invalid-source | 模型引用了无法核验的用户来源，整批保留 |
| memory-changed | 整理期间记忆被纠正或遗忘，旧提案取消并重试 |
| storage-error / invalid-stored-state | 存储写入失败或文件格式异常 |
| operation-failed | 其他失败；结合 phase 判断发生阶段 |

模型失败时，`maintenance.modelFailure` 只保留结束类型 `finishKind`、白名单错误码 `code` 及可选数字 HTTP 状态 `status`；未知错误码记为 `UNKNOWN`。不保存或回显供应商错误正文、请求标识、聊天内容或密钥。新整理开始及成功后会清除旧诊断。`nextRetryAt`、`startedAt`、`finishedAt` 等时间为 Unix 毫秒时间戳；退避期限和未完成的手动请求可跨宿主重启恢复，新手动请求可重新排队。

多条观察组成的批次达到模型输出上限时，会保留该批数据，并持久化减半后的批次条数供下轮重试；单条观察仍被截断时进入失败退避。全部整理完成后重置该限制。

剩余观察仍在 inbox 时，搜索不到某条内容只能说明它还没有形成可检索记忆。自动轮换还需整理成功并应用到新会话，以实际 `sessionId` 变化及 `lastRotationDate` 为准；单凭等待一两分钟或会话能回答旧问题不能判定轮换成功。

## 生命周期

### QQ 会话范围

插件默认 `qqOnly: true`、`rotateQQSession: true`。QQ 0.5.2 的入站消息没有专用插件标记，本版通过 QQ SessionManager 的真实路由识别会话。Harness 界面和其他通道不会因此被当作 QQ 对话。保留对显式 `plugin: im-qqbot` 消息来源的兼容，但这种没有路由绑定的来源仅整理、压缩原会话。

范围判断以整个会话是否属于 QQ 机器人为准。空会话或暂未出现 QQ 来源的会话保留后续识别机会；一旦由路由或 QQ 来源确认归属，该会话内从 QQ 或 Harness 界面发送的用户消息都会保存。已确认的归属写入记忆状态，普通独立的 Harness 会话继续排除。

记忆范围为 `qq:qqbot:<appId>:<c2c或group>:<peerId>`。每个私聊或群单独保存，session 换新后范围不变。日常轮换、QQ `/new` 都会继承该对话已保存的长期记忆；`/new` 本身不会额外触发旧对话的模型整理。

QQ 插件没有公开会话切换服务，本版适配其 0.5.2 私有接口，并在其他版本拒绝安装适配器、记录警告。升级 QQ 插件后需要重新验证适配。适配器只在进程内包装生命周期方法，不修改 QQ 插件安装文件。

### 六级记忆模式

`v0.3.0` 起启用六级模式。旧版本升级后在首次维护时分批迁移活跃记忆，迁移使用宿主配置的模型并产生相应 API 用量。

普通事件的等级期限为 L1 1 天、L2 3 天、L3 7 天、L4 30 天、L5 365 天、L6 永久。首个北京时间 04:00 业务日内，独立用户消息 1–2 条为 L1、至少 3 条为 L2；之后每一级分别累计 1、3、5、7、10 次真实命中才升到下一等级。每个 `topic + actor` 每个业务日最多升级一级，升级后本级计数清零；未达门槛的真实用户来源时间仍刷新过期时间。情绪记录初始按情绪强度 `<.2`、`.2–.4`、`.4–.6`、`.6–.8`、`>=.8` 分别进入 L1–L5，之后真实命中可升至 L6。`core`、`pinned`、`commitment` 与 L6 均受永久保护。

明确的用户保留请求采用保守模板识别；普通叙述（例如“出差三天”）不是保留请求。请求的期限向上取至不短于该期限的等级：例如 2 天使用 3 天级别，半个月使用 30 天级别，超过 365 天为永久。期限不保证召回；注入仍受预算和当前问题相关性限制。已过期的事实被用户再次提及时，会从适用的初级状态重新开始，不继承旧的命中进度。

主题和关键词仅用于候选查找；模型必须按语义判断是否为同一具体事实或纠正，且不同群/用户 actor 必须分开。完整 `content` 保留。每个独立用户事件对每个主题至多记一次：消息分块、fork、重试、assistant、检索和扫描都不计。新关键词须带各自真实的 `sourceIds`，不能因刷新而照抄旧标签来源。

缺少 actor 的旧群聊记忆保留未知归属，具名群成员的发言只能形成自己的新事实，不能据此修改、强化或归档该旧记录；明确按 id 遗忘仍可在当前群的记忆范围内执行。私聊中没有 actor 标记的来源继续兼容。

每个 scope 从首次启用的 `modeActivatedAt` 开始固定每 30 天清理一次关键词窗口 `[T-40 天, T-10 天)`；最新 10 天的标签处于观察保护期，最近由真实用户重新提及的标签保留。`core`、`commitment`、`pinned`、L6 全部排除。清理只删关键词索引，不删完整内容或原始日志，不按运行次数计算；离线或失败后会在恢复时补做。

旧 active 记忆首次维护时逐条重分类，且不改写 `content`、`createdAt`、`sourceIds` 或原有 protected kind。保留旧 `reinforcementCount` 以兼容展示，但不把它映射为新命中；新 `levelHits` 和 `mentionCount` 从 0 开始。每条成功迁移的记录从迁移时刻开始自己的新 TTL，关键词同时开始观察期；模式清理锚点与单条 TTL 锚点独立。迁移按批次成功持久化，失败保留恢复状态，不会复活 archive。旧半衰期及 `archiveThreshold` 仅作为尚未迁移数据的兼容回退，不适用于新模式。

情绪强度影响保留时长；召回先按当前问题相关性筛选。最多 3 条核心或未完成事项可常驻，其余需中文双字或英文词命中，每次注入总长度受 `injectMaxChars` 限制。普通会话交接在 14 天没有新对话后过期；已经单独保存的未完成承诺继续受保护。

## 每日整理与上下文

1. 用户和 assistant 的文字事件及时写入本地，长消息分块保存，不静默截掉开头。
2. 每分钟检查已到达的北京时间业务日。宿主关闭时无法运行；下次启动或会话恢复后补做。
3. 用户偏好、事件、重要性、情绪强度、可信度及交接由当前配置的模型提炼。无值得记忆的内容允许空操作。
4. 在 Agent 维护锁内整理，成功批次先落盘，全部处理完成后保存轮换检查点及目标 session id。
5. 创建空白会话，不复制旧消息；沿用当前会话 preset、工作目录及模型路由。已配置的全局人设插件（例如可选的 `dsh-whale-persona`）仍在请求组装时生效，QQ 私聊／群聊附加提示词也由 QQ 插件继续提供。自定义人设应放在人设插件或 preset 中。
6. 等新会话保存成功、确认旧会话没有新消息后，原子保存 QQ 的 session 路由，再更换运行时映射。新消息随后进入新会话。每个北京时间业务日最多自动轮换一次，手动要求重复整理也遵守此限制。
7. 如果 QQ 会话因空闲被回收，先使用上次记录的模型路由整理；重新连接后，下一次空闲检查再完成轮换。宿主关闭时不能执行，重新启动并恢复 QQ 对话后补做。

每个会话每次最多处理 2 个批次，并发最多 2 个会话。剩余批次下一分钟继续，期间不提前替换上下文。忙碌会话延后；模型、解析或保存失败保留进度并退避重试。积压期间优先保留未整理内容，inbox 可能增长，可通过 `memory_status` 查看；没有“超额就丢弃旧消息”的行为。

记忆和交接由 `systemPrompt.context` 在每次请求时按预算提供，不反复追加进新聊天历史。轮换失败保持旧 QQ 路由；路由已切换但完成标记尚未保存时，重试只补完标记。旧原生会话文件保留供回查。损坏的单个记忆文件会报错并保留，不覆盖为空，也不会阻止其他会话维护。

`rotateQQSession: false` 时使用原会话上下文压缩：保留人格／开发者消息及最近两轮用户消息和回复（原文最多保留 48 小时），检查工具调用与结果配对，并用持久化检查点恢复失败操作。

## 数据与隔离

默认存储在 `$DSH_HOME/emotional-memory/scopes/`，未配置 `DSH_HOME` 时使用用户目录的 `.dsh/emotional-memory/scopes/`。文件名由 QQ 对话范围哈希生成，内容是 JSON。旧版按 session id 保存的本对话记忆在首次识别时迁移，旧文件标记为已迁移并保留。每个 Desktop 宿主应使用自己的数据目录，单目录不支持多个进程同时写入。

按 QQ 对话隔离，不会把其他用户、群或 Harness 界面聊天的记忆注入当前对话；群聊是一份群共享记忆。各 session 的采集序号分别记录，因此新会话从小序号开始也能正常采集，模型切换 fork 继承的消息不会重复采集。跳过子代理。

常见 `sk-`、GitHub/AWS 密钥、JWT、Bearer 和明确标注的密码/验证码在文字分块前替换；自动与手动保存共用已知凭据模式检查，交接也过滤。这是已知格式过滤，不能发现所有形式的秘密。不要把数据目录提交到公开仓库。

明确遗忘会删除插件当前/归档中的记录，丢弃该记录来源事件尚未整理的所有片段，并中和本插件已注入的旧交接。待整理的 assistant 回复也会清理，以免其回显把已遗忘信息再次写入交接。中途失败会保留待清理标记，在恢复或下一步前继续处理。同一原消息内尚未提炼的其他信息也会被丢弃，已经形成的其他记录需按各自 id 删除。

**切换新会话后，旧会话原文退出后续模型输入。Harness 原始日志、迁移前备份及 QQ 平台记录继续保留，不属于 `memory_forget` 的删除范围。** 明确遗忘删除当前记忆库及待整理来源，历史备份需要另行处理。

## 配置与验证

默认配置见 `cordis.patch.yml`，时间固定按北京时间（UTC+8）解释；`dailyHour` / `dailyMinute` 可调整。`rotateQQSession` 控制自动换会话。`maxDistillChars` 限制一次整理输入大小，`maxBatchesPerRun` 控制每次占用，`maxRecords` 是每个 QQ 对话的活跃记录容量；核心或未完成事项不会为腾空间而被静默淘汰。

```powershell
npm test
npm run check
npm run test:host
```

`test:host` 使用已安装 Desktop 中的真实 SDK，临时测试目录与当前用户聊天隔离。测试不连接 QQ，也不消耗模型 API 额度。

设计参考：[LivingMemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory)、[Culeot/dsh-agent-memory](https://github.com/Culeot/dsh-agent-memory)、[zhbcher/dsh-memory](https://github.com/zhbcher/dsh-memory)、[yan5236/dsh-memory](https://github.com/yan5236/dsh-memory)。插件为独立实现。
