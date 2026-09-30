# Install Fusion

[中文](INSTALL.zh.md) · Product pages: [README.md](README.md) (中文), [README.en.md](README.en.md)

Requires **DeepSeek Harness 0.2.0-rc.2**. Other versions are not supported.

## Install on DeepSeek Harness web or desktop

Fill `dsh-model-fusion` in the **Add plugin** wizard's search box, and click **Install**:

![Add plugin wizard](https://raw.githubusercontent.com/aa2246740/dsh-model-fusion/main/docs/add-plugin-wizard.png)

The release includes the built `lib/`; no clone or build is needed.

## Install with `dsh` cli

Install [`dsh-model-fusion`](https://www.npmjs.com/package/dsh-model-fusion) plugin from [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh):

```sh
dsh plugin --profile web add dsh-model-fusion
```

Or update the `dsh-model-fusion` plugin:

```sh
dsh plugin --profile web update dsh-model-fusion@latest
```

Then start the web UI with `dsh web`. No build step, no restart.

If `dsh` is not on PATH: `npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add dsh-model-fusion`.
This writes only the `web` profile; it cannot modify the desktop app's profile — use the in-app **Add plugin** wizard above for desktop.

## After installing

1. Sign in to at least two models in DSH: a strong Lead and a much cheaper Sidekick. Built-in providers work, and so do the
   subscription routes of [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login).
2. Open **Settings → Fusion**, choose the Lead and the Sidekick, and save.
3. Select **Fusion · auto** in the model menu.
4. On Windows, install PowerShell 7 and make sure `pwsh` is on the PATH used to launch DSH. Windows support was verified with v0.2.1 on Windows Server 2022 (v0.2.2 changes only platform-independent workflow code and was re-tested on macOS); Windows 10/11 remain unverified. On Linux, run the read-only check in [README.en.md](README.en.md#support) before real use.

## Uninstall

```sh
dsh plugin --profile web remove dsh-model-fusion
```

In the desktop app, uninstall from the **Plugins** page in the left sidebar. Fusion's own records stay in
`$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`; delete that file to remove them.
