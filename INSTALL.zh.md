# 安装 Fusion

[English](INSTALL.md) · 产品介绍：[README.md](README.md)（中文）、[README.en.md](README.en.md)

需要 **DeepSeek Harness 0.2.0-rc.1**，其他版本不支持。

## DSH Studio 桌面版（推荐）

点左侧栏的 **插件** → **添加插件**，在"包名或地址"里填：

```text
github:aa2246740/dsh-model-fusion#v0.2.2
```

发布版本已包含构建好的 `lib/`，不需要克隆或编译。装好后退出并重新打开 DSH Studio（插件在下次启动时生效）。

## Web 命令行

```sh
dsh plugin --profile web add github:aa2246740/dsh-model-fusion#v0.2.2
```

`dsh` 不在 PATH 里时：`npx @deepseek-ai/dsh@0.2.0-rc.1 plugin --profile web add github:aa2246740/dsh-model-fusion#v0.2.2`。
这只会写入 `web` 配置。正在运行的 Web 服务需要重新打开一次，再刷新页面。

## 装好之后

1. 在 DSH 里至少登录两个模型：一个强的当 Lead，一个便宜得多的当 Sidekick。DSH 自带的模型可以用，
   [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login) 的订阅登录线路也可以用。
2. 打开 **设置 → Fusion**，选择 Lead 和 Sidekick，保存。
3. 在模型菜单里选择 **Fusion · 自动**。
4. Windows 用户需安装 PowerShell 7，并确保启动 DSH 的进程 PATH 中有 `pwsh`。v0.2.1 已在 Windows Server 2022 上验证；Windows 10/11 尚未验证。Linux 用户正式使用前，先按 [README.md](README.md#支持范围) 里的步骤检查只读限制是否生效。

## 卸载

```sh
dsh plugin --profile web remove dsh-model-fusion
```

桌面版在左侧栏的 **插件** 页面里卸载。Fusion 自己的记录在 `$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`，
想一并清除就删掉这个文件。
