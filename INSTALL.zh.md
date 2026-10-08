# 安装 Fusion

[English](INSTALL.md) · 产品介绍：[README.md](README.md)（中文）、[README.en.md](README.en.md)

需要 **DeepSeek Harness 0.2.0-rc.2**，其他版本不支持。

## 在 DeepSeek Harness 网页版或桌面端安装

在 **添加插件** 向导的搜索框中填入 `dsh-model-fusion`，点击 **Install**：

![Add plugin wizard](https://raw.githubusercontent.com/aa2246740/dsh-model-fusion/main/docs/add-plugin-wizard.png)

发布版本已包含构建好的 `lib/`，不需要克隆或编译。

## 使用 `dsh` 命令行安装

从 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 安装 [`dsh-model-fusion`](https://www.npmjs.com/package/dsh-model-fusion) 插件：

```sh
dsh plugin --profile web add dsh-model-fusion
```

更新 `dsh-model-fusion` 插件：

```sh
dsh plugin --profile web update dsh-model-fusion@latest
```

然后用 `dsh web` 启动 Web 界面。无需构建、无需重启。

`dsh` 不在 PATH 里时：`npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-model-fusion`。
这条命令只写入 `web` profile，不修改桌面 App 的 profile；桌面端请使用上面的"添加插件"向导。

## 装好之后

1. 在 DSH 里至少登录两个模型：一个强的当 Lead，一个便宜得多的当 Sidekick。DSH 自带的模型可以用，
   [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login) 的订阅登录线路也可以用。
2. 打开 **设置 → Fusion**，选择 Lead 和 Sidekick，保存。
3. 在模型菜单里选择 **Fusion · 自动**。
4. Windows 用户需安装 PowerShell 7，并确保启动 DSH 的进程 PATH 中有 `pwsh`。Windows 支持在 v0.2.1 上于 Windows Server 2022 验证过（之后的版本只改了与平台无关的代码或打包方式，在 macOS 上复测）；Windows 10/11 尚未验证。Linux 用户正式使用前，先按 [README.md](README.md#支持范围) 里的步骤检查只读限制是否生效。

## 卸载

```sh
dsh plugin --profile web remove dsh-model-fusion
```

桌面版在左侧栏的 **插件** 页面里卸载。Fusion 自己的记录在 `$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`，
想一并清除就删掉这个文件。
