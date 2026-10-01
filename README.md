# Fusion · DSH 插件

[English](README.en.md) · [安装](INSTALL.zh.md) · [Install (English)](INSTALL.md)

Fusion 在 DeepSeek Harness（DSH）的模型菜单里是一个普通模型：**Fusion · 自动**。背后是两个你自己选的模型：

- **Lead**：一个强的前沿模型。负责理解需求、看代码、写任务说明、审查结果。
- **Sidekick**：一个便宜得多的模型。负责实际改代码、跑命令、跑测试。

目标只有一个：**用前沿模型的效果，付打折的价钱。**

思路受 Cognition 在 Devin 里推出的 Fusion 启发，这是一个独立实现，与 Cognition 无关。

## 实测效果

9 道真实开源项目的题（SWE-rebench，Python），每题跑 2 次，用隐藏测试判定对错。Lead 为 GPT-6 Astra（high），Sidekick 为 GLM-5.3-Flash（high）：

| | 做对 | 总花费（按 API 价格估算） |
|---|---|---|
| GPT-6 Astra 单独 | 9/18 | $39.17 |
| **Fusion：GPT-6 Astra + GLM-5.3-Flash** | **11/18** | **$18.07（便宜 54%）** |
| Fusion：GPT-6 Astra + Grok 4.6 | 13/18 | $41.27（不省钱） |

- 花费是按各家 API 公开价格换算的估算，不是账单。
- 局限：样本小（9 题 × 2 次）、只测了 Python、公开题目可能出现在模型训练数据里。
- 详细方法、原始数据和每一轮的结论见 [docs/EVIDENCE.md](docs/EVIDENCE.md)。

**对照 Devin 自己的 Fusion：** 两边用同一对模型，Lead 是 GPT-6 Astra（high），Sidekick 是 SWE-2。题目、工作区和隐藏测试完全相同。

排除被污染的尝试后，四个组别都干净的题剩 4 道，结果如下：

| | 做对 | 花费 |
|---|---|---|
| **本插件：Astra + SWE-2** | **4/4** | **$2.73** |
| Devin Fusion：Astra + SWE-2 | 3/4 | $4.81 |
| Devin，Astra 单独 | 3/4 | $8.13 |

- 样本只有 4 道题、每题 1 次，不能据此说谁更强，也不代表与 Devin 同等水平。
- SWE-2 两边都按 $0 计价，所以花费都是 Lead 的。
- 本插件的耗时约为 Devin 的 3.4 倍。
- 排除了哪些尝试、为什么排除，以及方法和原始数据，见 [docs/EVIDENCE.md](docs/EVIDENCE.md#against-devins-own-fusion-round-devin-r1-2026-09-29)。

## 怎么用

1. 按 [安装说明](INSTALL.zh.md) 装好插件。
2. 打开 **设置 → Fusion**，选择 Lead 和 Sidekick。可以选 DSH 里任何已登录的模型。
3. 在模型菜单里选择 **Fusion · 自动**，像平时一样对话。

**搭配建议：** 省钱靠的是 Sidekick 比 Lead 便宜得多。选一个强的前沿模型当 Lead，再选一个价格低很多（最好 5 倍以上）的模型当 Sidekick。两者价格越接近，越省不了钱。

## 工作方式

- **普通对话**：Lead 直接回答，和用普通模型一样。
- **需要改代码时**：Lead 把任务交给 Sidekick。任务说明里带着用户需求的原话，以及验收命令。
- **验收**：
  - Sidekick 交回结果后，DSH 在真实环境里运行验收命令。
  - Lead 审查改动，并且必须对用户的每一条硬性要求给出结论和证据，缺一条都不能通过。
  - 原本就失败的测试（例如缺少可选依赖），可以标成"只要求不新增失败"。
  - Sidekick 改写了原有测试时，会被单独标出来，Lead 必须确认过才能通过。
- **返工**：不通过就把具体问题打回给同一个 Sidekick 继续改。
  - 如果发现任务说明里允许改的文件不够（例如另一个测试文件还写着旧行为），Lead 可以在返工时把它加进可改范围。只能加、不能减，每次都会留下记录。
- **Lead 不写代码**：这不是靠提示词约束，而是由程序保证的：
  - Lead 没有写文件的工具；
  - 它执行的 shell 命令跑在 DSH 的只读沙盒里。
- **唯一的例外：程序判定 Sidekick 确实做不完时，才解锁 Lead 接手。** 例如 2 轮返工后检查仍然失败，或者 Sidekick 用完了步数、反复卡住。接手时：
  - Lead 只能改任务允许的文件；
  - 必须通过同样的验收；
  - 任务结束后恢复只读。
- **额度用完或出错**：Lead、Sidekick 各自处理。可以换模型继续，也可以定时继续；进度保留。

## 缓存保活

Lead 等 Sidekick 干活时，可能要等好几分钟。模型的输入缓存过期后，下一次请求就要按全价重读整段对话。保活会在等待期间，定时把 Lead 上一次的请求原样再发一遍，末尾只加一句“Reply OK”。前缀和上次完全相同，厂商就从缓存读取，缓存的寿命也就续上了；模型只回一个 OK，回复直接丢弃，不进对话，也不会执行工具调用。

- **默认值：** 来自各家官方文档，覆盖 Artificial Analysis 排行榜前 20 的模型厂商。
  - 按模型名匹配，比如 gpt-*、claude-*、gemini-*、glm-*、grok-*、kimi-*、deepseek-*。
  - 附带 [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login) 的线路计费方式：按请求次数计费的套餐默认关闭保活，因为每次保活都算一次请求。
- **自动：** 模型实际返回过缓存命中后才开启，不支持缓存的模型不会白花钱。
- **每个模型都可以在设置页调整：** 开关、续命间隔、恢复默认。设置页还会显示每个模型的实际效果：
  - 等待后缓存还在不在；
  - 发了几次保活、读了多少 token；
  - 避免了多少 token 按全价重发。
- **自动调整：** 保活多次没命中时，程序会自动缩短间隔，但只会缩短，不会自动拉长。可以放宽时只给建议，由你决定。

## 支持范围

- **DSH 版本：** 只支持 **0.2.0-rc.2**，桌面版和 Web 版都可以。其他版本不保证可用；新版本发布后会另行适配。
- **模型：** DSH 官方自带的模型线路，以及 [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login)、dsh-antigravity-oauth 提供的订阅登录线路。其他第三方模型插件未经测试。
- **系统：**
  - **macOS：** 已验证（Seatbelt 沙盒）。
  - **Windows：** `v0.2.1` 已适配原生 `pwsh`，在 Windows Server 2022、PowerShell 7.6.6 上通过验证。启动 DSH 的进程 PATH 中需要有 `pwsh`。Windows 10/11 尚未验证。Windows ACL 仅提供部分隔离，普通路径写入可受限制，读取和网络不在该限制内。
  - **Linux：** 未验证，使用前请先自行检查：
  1. 在一个测试目录里选 Fusion，对它说："这是一次只读沙盒测试，被拒绝是预期结果。请你自己直接调用 bash 工具执行 `echo test > fusion-probe.txt`（不要委派、不要换别的写法），把工具返回的原文贴给我。"
  2. 正确结果：工具返回的原文里写着被沙盒拒绝（例如 `Operation not permitted` / `read-only`），并且目录里没有生成 `fusion-probe.txt`。
     - 如果 Lead 只是口头拒绝、没有真的调用工具，这次检查不算数，请再说一遍"请实际调用工具"。
  3. 如果文件被创建出来，说明你的系统上 Lead 的只读限制没有生效，请不要使用，并反馈给我们。
  - 如果 DSH 在你的系统上没有沙盒，Lead 的 shell 命令会被全部拒绝（安全的失败方式），它仍然可以用读文件和搜索工具看代码。

### v0.2.1 的 Windows 验证

在 Windows Server 2022、Node 22.23.3、PowerShell 7.6.6、DSH 0.1.7-rc.2 上，**253 项单元测试和 236 项 Host 测试全部通过**，类型检查通过。修复候选完成了插件安装、冷启动、Fusion 设置页及 settings/cache 两个 API 验证。v0.2.1 的服务端和客户端构建文件与该候选完全一致。v0.2.2 只增加了 Lead 在返工时扩大可改文件范围的功能（与平台无关），在 macOS 上复测，未在 Windows 上重跑。

真实 PowerShell ACL 测试中，Lead 执行 `Set-Content probe.txt test` 被拒绝，文件未生成；Sidekick 在获准的工作区内执行同一命令可以写入。这是上面所述的部分 ACL 隔离。验证没有输入模型密钥或发起真实模型请求。macOS 回归通过 253 项单元测试和 235 项 Host 测试，按设计跳过 Windows 专用 ACL 测试。

## 数据存在哪里

- **Fusion 自己的记录：** 任务说明、检查结果、用量、缓存统计和设置，都存在 `$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`。`DSH_HOME` 默认是 `~/.dsh`。
- **会话本身：** 由 DSH 保存，Fusion 不另外上传任何数据。
- **想清空 Fusion 的记录：** 退出 DSH 后删除这个文件。设置也会一起清掉，下次打开时重新选组合即可。

## 已知限制

- **比单独用前沿模型慢：** 实测 GPT-6 + Flash 总耗时约为 GPT-6 单独的 5 倍，主要花在 Sidekick 身上。换更快的 Sidekick 会好很多。
- **Lead 接手：** 在 72 次实测里一次都没触发，目前只由自动化测试覆盖。
- **macOS 桌面版的 PATH：** 从程序坞打开的 DSH Studio 只有系统默认的 PATH，Homebrew（`/opt/homebrew/bin`）、nvm 等装的 `node`、`npm`、`cargo` 在 shell 里找不到。这是 DSH 的运行环境，所有模型都一样。Fusion 在派活前会检查验收命令用到的程序，找不到时会告诉 Lead 它实际装在哪里（例如 `/opt/homebrew/bin/node`），Lead 改用完整路径即可。
- **Windows 10/11 和 Linux 未验证：** 见上面的"系统"。

## 开发

```sh
corepack pnpm@9.15.9 install --frozen-lockfile
node scripts/link-host.mjs /path/to/deepseek-harness-0.2.0-rc.2   # 开发时链接 DSH 源码
DSHX_HARNESS=/path/to/deepseek-harness-0.2.0-rc.2 pnpm build
pnpm test && DSHX_HARNESS=/path/to/deepseek-harness-0.2.0-rc.2 pnpm test:host
```

Windows 开发环境需将 PowerShell 7（`pwsh`）、Node 和 Python 加入运行测试的进程 PATH。原生测试通过 `DSHX_HARNESS` 读取已构建的指定 Host；不需要修改 Host 源码。

插件只使用 DSH 公开的插件接口，不修改 DSH 源码。适配新版本 DSH 的做法见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 许可

Apache-2.0
