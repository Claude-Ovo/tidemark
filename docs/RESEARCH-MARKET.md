# 市场需求调研（原始报告）

checked_at: 2026-08-10（本轮复核：全部引用 URL 当日访问均存活/HTTP 200；issue 状态经 GitHub API 复核，pricing 取自当日官方页面。上一轮为 2026-07-29）。信息源：GitHub Issues、HackerNews、媒体报道。每条 claim 附 primary URL；【推测】明确标注。

## 痛点证据链

1. **记忆质量是头号痛点**：mem0 issue #4573「auditing 10,134 mem0 entries: 97.8% were junk」——生产环境 32 天审计，10,134 条仅 38 条可用；系统提示词被重复提取 52.7%（"Agent uses she/her pronouns" 出现 50+ 次）；幻觉用户 "John Doe" 连续出现 6 天；换强模型无改善；"无差别存储比没有记忆更差"。https://github.com/mem0ai/mem0/issues/4573 （状态 2026-08-10：closed/completed，关闭于 2026-06-05；审计数据为历史事实，证据力不受关闭影响）
2. **遗忘是直接呼声**：mem0 issue #5330——用户指出无过期/衰减机制导致检索劣化+token膨胀+自相矛盾，自己写了艾宾浩斯遗忘曲线插件（生产数据：稳定约20条活跃记忆、零误删）。https://github.com/mem0ai/mem0/issues/5330 （issue 标题 "Proposal: Memory access frequency tracking and lifetime-based cleanup"；状态 2026-08-10：closed/completed，关闭于 2026-06-17，讨论走向为插件方案+官方邀请提最小上游 hook）。**官方后续（呼声被部分承接）**：mem0 已于 2026-05-08 在托管 Platform 上线 Memory Decay——但为检索侧 0.3×–1.5× 重排、官方明言 "soft re-rank, not a filter"/"Nothing gets deleted or hidden"，并于 2026-06-27 给 SDK 加 expiration_date TTL（仅 Platform，OSS 无）；遗忘生命周期（存储层衰减/淘汰）仍空缺。https://mem0.ai/blog/introducing-memory-decay-in-mem0 ；https://docs.mem0.ai/changelog/highlights ；Show HN 首发日即被问 decay https://news.ycombinator.com/item?id=41447317
3. **打分失灵**：mem0 #4999——search 对所有结果返回相同 1.0 分。https://github.com/mem0ai/mem0/issues/4999 （状态 2026-08-10：closed/completed，关闭于 2026-06-05）
4. **"存储不学习"**：Ask HN（YC W23 创始人）"Mem0 stores memories, but doesn't learn user patterns"。https://news.ycombinator.com/item?id=46891715 ；claude-code #57830 求自我改进学习循环 https://github.com/anthropics/claude-code/issues/57830 （状态 2026-08-10：closed/**not_planned**，关闭于 2026-06-08——官方不做，缺口仍在，引用时可作"需求存在但无人承接"的佐证）；AWS 已产品化 episodic memory https://aws.amazon.com/blogs/machine-learning/build-agents-to-learn-from-experiences-using-amazon-bedrock-agentcore-episodic-memory/
5. **不可见/不可控**：ChatGPT 记忆丢失事件 https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-memories-are-disappearing-for-some-users-heres-what-you-can-do-to-protect-yours ；MIT TR "AI 记忆是隐私下一个前线" https://www.technologyreview.com/2026/01/28/1131835/what-ai-remembers-about-you-is-privacys-next-frontier/ ；memory transparency 学术框架 https://arxiv.org/pdf/2512.06616
6. **学术旁证**：FadeMem（生物启发遗忘）指现有系统是"全存或全丢"二元。https://arxiv.org/html/2601.18642v2

## 三假设验证

- (a) 会遗忘：**强证据**（#5330 插件倒逼 + #4573 数据 + FadeMem）
- (b) 可解释：**间接证据**（症状层：婚戒尴尬案例、"不知道它记了什么"；框架层：memory transparency 论文；【推测】用户不会说"我要可解释性"，但"让我看见+让我删"是表层刚需，"告诉我为什么"是下一层）
- (c) 从踩坑学习：**明确证据**（Ask HN + claude-code #57830 + AWS 产品化三方同时指认）

## 商业化

- mem0：Hobby 免费（1 万 add/月）→Starter $19/月→Pro $249/月→Enterprise 定制（pricing 页 checked_at 2026-08-10）。https://mem0.ai/pricing ；融资 $24.5M https://techcrunch.com/2025/10/28/mem0-raises-24m-from-yc-peak-xv-and-basis-set-to-build-the-memory-layer-for-ai-apps/
- Zep：Free 1 万 credits/月→Flex $125/月→Flex Plus $375/月→Enterprise（pricing 页 checked_at 2026-08-10，$125 确认）。https://www.getzep.com/pricing ；砍开源社区版转商业的官方公告《Announcing a New Direction for Zep's Open Source Strategy》（终止 Community Edition 支持、开源资源全转 Graphiti）https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/
- Letta：免费 3 stateful agents→Pro $20/月（up to 20 agents）→API $20/月起→Enterprise（pricing 页 checked_at 2026-08-10 确认；www.letta.com/pricing 现 301 至 docs 站）。https://docs.letta.com/letta-code/pricing
- 【推测】纯 B2B devtool 生意；C 端被模型厂商内置功能卷掉；独立厂商生存位=多平台中立+企业合规
