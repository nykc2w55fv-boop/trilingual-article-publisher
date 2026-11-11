# Windows → macOS 迁移

## 当前环境与目标

- 当前：Windows、Node.js 22.12+、npm、Git。
- 目标：macOS，同一套 Node.js 核心代码。

## 入口与核心逻辑

- Windows：`npm.cmd ci` 后双击 `publisher/start.cmd`，或运行 `npm.cmd start`。
- macOS：`npm ci` 后运行 `sh publisher/start.sh`，或运行 `npm start`。
- 跨平台核心：`publisher/server.mjs`、`publisher/lib/`；网站集成示例在 `scripts/` 和 `src/lib/`。

## 平台专属内容及风险

- `publisher/start.cmd` 只负责 Windows 启动；`publisher/start.sh` 提供 POSIX 入口。
- Git 可执行文件的 Windows 安装位置探测在 `publisher/lib/git-command.mjs`；macOS 使用 PATH。
- `sharp` 有原生平台包；每台电脑分别执行 `npm ci`，不复制 `node_modules`。
- 本机设置经 `publisher/lib/settings.mjs` 保存于各平台应用数据目录，迁移时需重新填写目标网站、原稿、备份路径和 API Key，不能复制 Windows 盘符路径。
- 目标网站必须单独迁移并满足 README 的集成接口。

## 最近一次迁移影响（2026-11-12）

从私有网站提取发布器为独立公开仓库，补独立 npm 入口和锁文件；去掉公开界面对原网站名称与盘符的硬指向。保留 Windows 薄入口与 macOS Shell 入口，没有新增平台专属依赖。
