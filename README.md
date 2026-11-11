# 三语文章发布器

本仓库只包含本地发布器、测试和网站集成代码，不包含个人网站源码、文章、Obsidian 原稿、图片、密钥或原网站的 Git 历史。

发布器读取 Obsidian 中文 Markdown，预览手机排版，检查翻译结构，再调用**另一个目标网站仓库**中的导入脚本生成简体中文、英文和繁体中文页面。发布前需要人工确认；程序不自动 Git commit 或 push。

## 使用

需要 Node.js 22.12+、npm、Git，以及一个兼容的网站仓库。该网站仓库须有 `package.json`、`package-lock.json`、`scripts/publish-content.mjs`、`src/content/essays/`，并提供 `sync:assets`、`check:articles`、`build` 命令。这里的 `scripts/publish-content.mjs` 等文件是集成实现的参考副本，不能仅凭本仓库完成网站构建。

1. 安装本仓库依赖：Windows 运行 `npm.cmd ci`，macOS/Linux 运行 `npm ci`。
2. Windows 双击 `publisher/start.cmd`，macOS/Linux 运行 `sh publisher/start.sh`；也可以运行 `npm start`。
3. 在本地页面设置目标网站仓库、Obsidian 中文稿目录、备份目录和翻译接口。配置保存在本机应用数据目录，不写入本仓库。
4. 预览、核对译文及图片后发布，再到目标网站仓库检查差异并自行提交。

`npm test` 运行发布器测试。测试会在系统临时目录和本仓库 `.local/` 下创建隔离夹具；按个人工作规则，这些目录不会由测试脚本递归删除。

详细流程见 [publisher/README.md](publisher/README.md)。

目标网站若使用 Astro，请把 [手机排版样式片段](integrations/astro-mobile-reading.css.txt) 放入文章页面的 Astro 样式块；该片段与发布器预览采用相同的手机宽度规则。
