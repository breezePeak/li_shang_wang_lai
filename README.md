# 礼尚往来 · li_shang_wang_lai

## 安装

环境要求：

- Node.js 20+
- npm
- Playwright Chromium
- 已登录的抖音创作者账号

以 Hermes 为例，OpenClaw 只需要替换安装目录：

```bash
git clone https://github.com/breezePeak/li_shang_wang_lai.git ~/.hermes/skills/li-shang-wang-lai
cd ~/.hermes/skills/li-shang-wang-lai
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

安装目录：

| 引擎 | 安装目录 |
|---|---|
| Hermes (macOS/Linux) | `~/.hermes/skills/li-shang-wang-lai` |
| Hermes (Windows) | `$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai` |
| OpenClaw (macOS/Linux) | `~/.openclaw/skills/li-shang-wang-lai` |
| OpenClaw (Windows) | `$env:USERPROFILE\.openclaw\skills\li-shang-wang-lai` |

Windows 示例：

```powershell
git clone https://github.com/breezePeak/li_shang_wang_lai.git "$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai"
Set-Location "$env:LOCALAPPDATA\hermes\skills\li-shang-wang-lai"
npm install
npx playwright install chromium
npm run db:init
npm run auth
```

更多命令和参数见 `docs/COMMANDS.md`，Skill 约束见 `SKILL.md`。
