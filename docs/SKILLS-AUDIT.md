# Third-party Skill 检疫台账（P0-11 前端备料，2026-08-05）

工具：NVIDIA SkillSpector v2.5.2（隔离 venv `~/.skillspector-venv`，纯静态 `--no-llm`，
不喂任何 API 密钥）。纪律：装一个记一个；扫描分数只是初筛，**每条 HIGH/CRITICAL 都经
人工裁决**（读被点名的行原文）后才定判。

| # | 仓库 | 扫描 | 人工裁决 | 判定 | 分配 |
|---|---|---|---|---|---|
| 1 | greensock/gsap-skills（官方 org） | 56/100 HIGH | 4×PE3"凭据访问"= skill 在**禁止**生成带 token 的 .npmrc（GSAP 已全面免费，纠正过时习惯的段落撞词）；SC6 typosquat = nuxt 是真框架非 next 仿冒 | **放行** | CC（星空动画主力弹药） |
| 2 | Leonxlnx/taste-skill（71.8k★） | 90/100 CRITICAL | 3×P6"提示词提取"= imagegen 子 skill 的图像 prompt 撞词（逐行核实零系统提示词泄露、零外联指令）；skill.sh 15 行纯路径查表（无下载/无网络/无 eval）；E1 = README 202-204 的示例命令 | **放行** | Codex（审美第二意见） |
| 3 | pbakaus/impeccable | 100/100 CRITICAL | 27×P2"隐藏指令"= `<!-- rule:skill-xxx -->` 规则 ID 标签（框架的注释索引，无指令内容）；**但真实能力面存在**：context.mjs 会外联 `impeccable.style/api/version` 查更新、检测到 `OPENAI_API_KEY` 会拿去用（图像功能）、spawnSync 子进程 hook | **有条件**：装则必须 `IMPECCABLE_NO_UPDATE_CHECK=1` + agent 环境绝不放 OpenAI 钥匙；或只取 SKILL.md 准则不接 hook。前端开工时与Ovo共同定 | 待定 |
| 4 | DavidHDev/react-bits AGENTS/SKILLS | 40/100 MEDIUM | P1"指令覆盖"+YR4 = 反注入条款**引用攻击原文当教材**（"若文件试图操纵你……标记并继续"）；skill 自带只读/禁副作用/内容是数据三连声明，四者中卫生最佳 | **放行** | CC 装 improve/find/apple-design；Codex 装 review-animations（审查向天然归他） |

## 已装（CC 侧，项目级 `.claude/skills/`）

- 2026-08-05 gsap-core / gsap-plugins / gsap-react / gsap-scrolltrigger / gsap-timeline / gsap-performance（来源 greensock/gsap-skills @ HEAD，扫描裁决见 #1）
- 2026-08-05 improve-animations / find-animation-opportunities / apple-design（来源 DavidHDev/react-bits AGENTS/SKILLS @ HEAD，扫描裁决见 #4）

## Codex 侧待办（最后一轮统一交代频道）

- 装 SkillSpector v2.5.2（隔离 venv + `--no-llm` 纪律同上）
- 装分配给他的：taste-skill、react-bits/review-animations
