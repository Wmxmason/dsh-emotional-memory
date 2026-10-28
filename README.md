# DeepSeek Harness QQ 情绪记忆插件

为接入 QQ 开放平台的 DeepSeek Harness 机器人提供长期记忆、按情绪强度衰减，以及每天北京时间整理后自动切换新会话的功能。

## 功能

- 聊天时及时保存观察；确认属于 QQ 的会话后，也捕获该会话内来自 Harness 界面的用户消息。
- 每天北京时间 04:00 整理偏好、情绪经历和未完成事项，按类型、情绪及再次提及管理保留时长。
- 整理完成后创建空白会话，注入长期记忆和交接摘要，沿用原来的人设及模型预设。
- 不同 QQ 私聊和群聊分别存储；提供保存、检索、遗忘、状态查询和手动整理工具。
- 数据保存在使用者本机；整理调用 Harness 中已配置的模型 API，会产生相应 API 用量。

## 安装

已验证的环境：Windows Desktop、Harness SDK **0.2.1-rc.3**、QQ 插件 **@tencent-connect/dsh-qqbot 0.5.2**。QQ 会话轮换依赖此版本的私有接口，其他版本需要重新适配验证。

安装依赖范围也接受 SDK `0.2.1-rc.2`，但该版本未做运行验证，不在本次已验证的支持范围内。

1. 在 Harness 中配置自己的模型 API、QQ 机器人和人设。
2. 从 [Releases](https://github.com/Wmxmason/dsh-emotional-memory/releases/latest) 下载 `dsh-emotional-memory-0.2.3.tgz`。
3. 打开 PowerShell，替换下面的安装包路径并执行：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add 'C:\path\to\dsh-emotional-memory-0.2.3.tgz'
```

4. 完整退出并重新打开 Harness，从 QQ 发一条消息。可让机器人“查看记忆状态”，确认插件工作。

默认存储目录为 `%USERPROFILE%\.dsh\emotional-memory\`。Harness 关闭时不会执行整理，下次启动并恢复 QQ 对话后补做。

## 使用与开发

详细安装、配置、记忆衰减规则、隐私边界及故障排查见 [中文文档](README.zh.md)。人设由使用者的 preset 或人设插件提供，本插件不附带私人角色设定。

Node.js 24 或更新版本可运行不依赖宿主的测试：

```powershell
npm test
npm run check
```

已安装上述 Harness 和 QQ 插件时，可运行 `npm run test:host` 验证宿主接口。测试使用合成消息和模型响应，不连接 QQ 或调用付费 API。

本仓库是独立社区项目，采用 [MIT License](LICENSE)。安装包不包含使用者的聊天记录、记忆库、QQ 凭据或 API 密钥。
