# 竞品与市场调研合成报告（2026-07-29）

> 两路调研原始报告见本目录 RESEARCH-COMPETITORS.md / RESEARCH-MARKET.md（含 primary URL 与 checked_at；星数、issue 状态、pricing、机制类引用已于 2026-08-10 全量复核，逐条 URL 见两份原始报告）。本文是结论层；所有"空白/唯一"表述限定为 among the projects reviewed。

## 一句话结论

我们的三张差异化牌（会遗忘 / 从失败学经验 / 记忆可解释）**供给侧全部空白或极浅，需求侧全部有真实呼声**——假设三连验证通过。

## 供给侧（8 个头部项目横评）

| 能力 | 市场现状 |
|---|---|
| 衰减/遗忘 | 仅 MemoryOS（1.6k star 学术项目）在**存储层**真做了 heat 衰减+淘汰；mem0 2026-05 起在托管 Platform 上线检索侧 Memory Decay（官方明言 soft re-rank 不删除）+TTL；Hindsight 为检索侧 recency 加权且官方明言刻意不做 eviction；Supermemory 宣传"automatic forgetting"（原"contextual expiry"措辞已下线）但黑盒；Letta/Graphiti/cognee 只增不减或手动删 |
| 失败→经验 | 无人做完整闭环。LangMem 的 episodic **只存成功案例、失败被丢弃**；最近的是 Hindsight（19.5k star，增长最快）的 Experience 网络，但 Reflect 是按需分析不是自动闭环 |
| 召回可解释 | **全场空白**。最接近的只有 Graphiti 的 provenance（"事实从哪来"≠"为什么现在浮现"）；所有项目返回的都只是相似度分数 |

技术趋同点（=我们该跟的标配）：混合检索（向量+BM25）+ RRF、MCP 接入、"不覆盖只标失效"的冲突哲学。
赛道病：benchmark 军备竞赛且信誉崩坏（mem0-Zep 互撕、"benchmark theatre"），没人优化"记忆像不像活物"。
**需盯防对手：Hindsight**（vectorize-io/hindsight）——方向嗅觉与我们最接近，一年 0→19.5k star（2026-08-10）。

## 需求侧（Issues/HN/媒体证据）

1. **头号痛点是记忆质量**：mem0 #4573 生产审计 10,134 条记忆 97.8% 是垃圾（系统提示词被反复入库、幻觉画像连续出现 6 天）；"无差别存储比没有记忆更差"；换强模型无改善，缺的是入库质量闸门和 REJECT 机制
2. **遗忘是直接呼声**：mem0 #5330 用户自己写了艾宾浩斯遗忘曲线插件倒逼官方（2026-08-10 复核：已倒逼成功——issue closed/completed，mem0 于 2026-05 在 Platform 上线检索侧 Memory Decay，但仅重排不删除，遗忘生命周期仍空缺，详见 MARKET 报告）；Show HN 首发日就被问 decay——三个假设里证据最硬的一条
3. **从踩坑学习被三方同时指认为最大缺口**：HN 创始人帖"mem0 存储不学习"、claude-code #57830 求自我改进循环（2026-08-10 复核：closed/not_planned——官方不做，缺口仍在）、AWS 已把 episodic memory 产品化（AgentCore，博客 2026-01-21 仍在线）
4. **可解释性是刚需的下一层**：用户表层诉求是"让我看见+让我删"（ChatGPT 记忆丢失事件、婚戒尴尬案例），研究界已定义 memory transparency 框架；产品端只有 ChatGPT memory summary 起步
5. 商业化：纯 B2B devtool 生意（mem0 融了 $24.5M、Zep 砍开源版转商业），付费动机=省 token+合规托管

## 对 SPEC / submission 的直接输出

- **叙事定位**：全场卷"recall accuracy"且互撕作假，我们卷"memory as a living organ"——衰减、结果门控、可解释浮现。评分表的 originality 与 memory design 两项正打。
- **必须吸收的新需求**（调研前没排上的）：入库端质量闸门（REJECT/去重复提取）——与 GPT review 的防投毒来源分级合并成一个"写入卫生"小节。
- **Receipt 是最稀缺资产**（among the projects reviewed 唯一的"为什么想起这条"答案）：带 integrity checksum 落库可审计，文案里放 C 位。
- **A/B 评测**（no-memory vs vector-only vs full 三臂，冻结口径：**recall + outcome-gated plasticity evaluation slice**，12 场景分 main/controls/diagnostics 三组呈现，不宣称完整生命周期已验证）正好回应"benchmark theatre"——negative controls 与 invalid_fixture 判定公开，我们不刷榜，我们自证。
- 引用弹药：mem0 #4573（97.8% 垃圾）、#5330（遗忘插件）、Ask HN（不学模式）、AWS AgentCore——submission 的 "Real-World Impact" 一节全用真实 issue 编号说话。（2026-08-10 状态注：#4573/#5330/#4999 均已 closed/completed、claude-code #57830 closed/not_planned；引用时写明现状——#5330 被官方以检索侧 decay 部分承接，正证明需求真实，我们做的存储层遗忘生命周期仍无人做。）
