# 贡献指南

感谢你愿意改进 `li_shang_wang_lai`。

这个项目同时涉及浏览器自动化、SQLite 状态流转和创作者工作流，所以提 PR 前建议先对改动范围有明确判断，避免“页面能跑、状态乱了”这种回归。

## 先看这些

- [README.md](README.md)
- [SKILL.md](SKILL.md)
- [references/comment-safety-rules.md](references/comment-safety-rules.md)
- [docs/COMMANDS.md](docs/COMMANDS.md)

## 开发环境

```bash
npm install
npx playwright install chromium
npm run db:init
```

如果你要验证真实登录态：

```bash
npm run auth
```

## 提交前请做到

1. 改动尽量聚焦，避免顺手混入无关重构。
2. 如果改了状态流转逻辑，尽量补单元测试。
3. 如果改了前端控制台，至少手动检查关键卡片和异常态。
4. 提交前运行：

```bash
npm test
```

## 提交信息

项目当前提交信息以中文为主，建议继续保持简洁直白，例如：

- `收紧评论发布接口成功判定`
- `锁定已忽略和成功回评状态`
- `补充开源仓库说明文档`

## Issue / PR 建议

提 Issue 时，请尽量带上：

- 你运行的命令
- 预期行为
- 实际行为
- 报错日志
- 是否能稳定复现

提 PR 时，请尽量说明：

- 改了什么
- 为什么要改
- 是否影响状态机或数据库
- 测试如何验证

## 不建议提交的内容

这些内容默认不应进入仓库：

- `.env`
- `config/local.json`
- `.playwright/`
- `data/` 下的本地数据库和运行数据

## 安全与合规

不要在公开 Issue 或 PR 里贴出：

- 账号 Cookie
- 本地配置中的密钥
- 带隐私的原始互动数据

如果问题涉及凭据、风控或潜在安全风险，请优先看 [SECURITY.md](SECURITY.md)。
