# feature-dev 开发与更新

本仓库：`MaxMeiRose/openidea`；中间仓库：`dekwanlabs/openidea`；原始仓库：`l0ng-ai/openidea`。
`feature-dev` 从已有 `feature/dev` 创建，保留定制提交，并设为默认分支，让 GitHub 定时工作流生效。

合并保留定制的 macOS 原生项目标签、Agent 审批面板、Services 状态分组和 API/Eureka/方法测试工具；
上游的重复审批横幅/会话行按钮由已有审批面板承接，完整问题和额外选项仍可查看和回答。

## 自动同步和打包

`.github/workflows/feature-dev.yml` 每天北京时间 10:17 依次尝试把 `l0ng-ai/openidea/main` 和
`dekwanlabs/openidea/main`、`dekwanlabs/openidea/feature/dev` 合并到 `feature-dev`；已包含的提交会跳过，GitHub 可能延迟执行。
冲突会让任务失败，远程分支保持原状，需手动处理。推送 `feature-dev` 和手动运行工作流也会检查是否需要构建。
GitHub Token 的自动合并推送不会触发新的工作流，因此同一次任务直接继续构建。

纯文档推送不触发打包；定时合并只有文档变化时也不打包。没有上游更新、提交已过时或该提交已有完整的已发布 Windows 安装包时，在 Linux 阶段结束，不占用 Windows runner。
前端类型、lint、格式、knip 和测试先在 Linux 执行，通过后才开始 Windows IPC 生成一致性检查、Rust 测试和打包。
新推送会取消旧流水线；手动或定时任务排队执行，已发布的同一提交会跳过。确需重建时，在手动运行页面勾选 `force`。
诊断附件仅失败时上传，保留 7 天；Rust 编译缓存继续复用。Release 缓存在 Rust 检查通过后才下载。

Windows x64 包通过这些检查后，先上传到草稿，再发布到本 fork 的 `feature-dev-*` 预发布版本。
发布包保留安装标识，关闭原始仓库的应用内更新；本地定时任务负责更新，防止官方更新覆盖定制功能。
更新清单的程序 SHA-256 来自安装包内的 `openidea.exe`；Tauri 在打包后会还原构建目录内的程序，不能用还原后的文件校验安装结果。

## 本地自动安装

```powershell
pwsh -File scripts/windows/register-feature-dev-update.ps1
pwsh -File scripts/windows/update-feature-dev.ps1 -CheckOnly
pwsh -File scripts/windows/update-feature-dev.ps1 -DownloadOnly
pwsh -File scripts/windows/update-feature-dev.ps1
```

任务 `OpenIDEA FeatureDev Update` 在当前用户登录后每小时检查一次；电脑关闭或未登录时不会安装。
软件运行中会延后，软件关闭后下载、校验 SHA-256、备份旧程序，再静默安装并核对程序哈希。
已校验的安装包会复用；`-DownloadOnly` 可在软件运行时提前下载，随后关闭软件再安装。
安装目录默认 `%LOCALAPPDATA%\OpenIDEA`；记录、下载缓存和程序备份在 `%LOCALAPPDATA%\OpenIDEA-FeatureDev`。
不删除应用设置和项目数据。停止自动更新可运行 `Unregister-ScheduledTask -TaskName 'OpenIDEA FeatureDev Update' -Confirm:$false`。

## 单次手动同步

工作区有未提交修改时先保存，再执行：

```powershell
git switch feature-dev
git fetch origin
git merge --ff-only origin/feature-dev
git fetch upstream main --no-tags
git merge --no-ff upstream/main
# 有冲突时逐项解决并验证，再提交。
git push origin feature-dev
```

## 后续贡献原始仓库

每个通用 bug 单独做修复提交和验证；从最新 `upstream/main` 建立 `fix/<bug>` 分支，cherry-pick 对应提交。
不要把整个 `feature-dev` 的定制功能和本 fork 更新工作流一起提交到上游。

```powershell
git fetch upstream main
git switch -c fix/<bug> upstream/main
git cherry-pick <修复提交>
git push -u origin fix/<bug>
gh pr create --repo l0ng-ai/openidea --base main --head MaxMeiRose:fix/<bug>
```

PR 描述列出问题、复现、改动和实际验证；原始仓库维护者决定是否合并。
