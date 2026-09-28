# Install Fusion

[中文](INSTALL.zh.md) · Product pages: [README.md](README.md) (中文), [README.en.md](README.en.md)

Requires **DeepSeek Harness 0.2.0-rc.1**. Other versions are not supported.

## DSH Studio desktop app (recommended)

Click **Plugins** in the left sidebar → **Add plugin**, and enter in "Package name or address":

```text
github:aa2246740/dsh-model-fusion#v0.2.2
```

The release includes the built `lib/`; no clone or build is needed. Then quit and reopen DSH Studio (plugins take effect at the next start).

## Web CLI

```sh
dsh plugin --profile web add github:aa2246740/dsh-model-fusion#v0.2.2
```

If `dsh` is not on PATH: `npx @deepseek-ai/dsh@0.2.0-rc.1 plugin --profile web add github:aa2246740/dsh-model-fusion#v0.2.2`.
This writes only the `web` profile. Reopen a running Web Host once and reload the page.

## After installing

1. Sign in to at least two models in DSH: a strong Lead and a much cheaper Sidekick. Built-in providers work, and so do the
   subscription routes of [dsh-oauth-login](https://github.com/aa2246740/dsh-oauth-login).
2. Open **Settings → Fusion**, choose the Lead and the Sidekick, and save.
3. Select **Fusion · auto** in the model menu.
4. On Windows, install PowerShell 7 and make sure `pwsh` is on the PATH used to launch DSH. v0.2.1 has been verified on Windows Server 2022; Windows 10/11 remain unverified. On Linux, run the read-only check in [README.en.md](README.en.md#support) before real use.

## Uninstall

```sh
dsh plugin --profile web remove dsh-model-fusion
```

In the desktop app, uninstall from the **Plugins** page in the left sidebar. Fusion's own records stay in
`$DSH_HOME/plugins/dsh-model-fusion/state.sqlite`; delete that file to remove them.
