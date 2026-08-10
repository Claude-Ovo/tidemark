# 竞品架构调研（原始报告）

checked_at: 2026-08-10（星数与 issue 状态取自当日 GitHub API；机制类 claim 经官方博客/文档页当日复核。上一轮为 2026-07-29）
调研方式：WebSearch + WebFetch 实际抓取各项目 GitHub/文档页。范围限于下列 8+2 个项目——所有"空白/唯一"结论均限定为 **among the projects reviewed**。

## 项目速览

| 项目 | stars（约） | 存储 | 冲突/更新 | 衰减/遗忘 | 失败→经验 | 召回可解释 |
|---|---|---|---|---|---|---|
| mem0 (mem0ai/mem0) | 62.9k | 向量(Qdrant)+SQL(+图可选) | ADD-only+读取侧时间推理 | 检索侧重排 Memory Decay(2026-05起,仅Platform,官方明言不删除)+TTL(仅Platform) | 无 | 无 |
| Letta 原MemGPT (letta-ai/letta) | 24.2k | Postgres+pgvector+MemFS(git) | agent自编辑+sleep-time agent | 无（靠主动改写） | 无 | git历史（改动可溯） |
| Zep/Graphiti (getzep/graphiti) | 29.7k | 图数据库(Neo4j等) | bi-temporal边失效"invalidated not deleted" | 无（失效≠衰减） | 无 | provenance到Episode |
| LangMem (langchain-ai/langmem) | 1.6k | LangGraph BaseStore | LLM整合/Profile覆盖 | 仅概念文档描述 | prompt优化器；episodic**只存成功案例** | 无 |
| cognee (topoteretes/cognee) | 29.9k | Postgres全家桶(pgvector+图) | improve循环 | 手动forget(dataset) | 无 | 图谱路径部分 |
| Supermemory (supermemoryai/supermemory) | 28.8k | 黑盒混合 | 自动矛盾消解+supersedes | 宣传"automatic forgetting"/到期过期但黑盒（原措辞"contextual expiry"已下线，见脚注） | 无 | 无 |
| Hindsight (vectorize-io/hindsight) | 19.5k | 稀疏+稠密向量+图 | Opinion带置信度 | 检索侧recency加权；官方明言刻意不做eviction（见脚注） | Experience网络（最接近）；Reflect按需非自动 | 置信度分数（部分） |
| MemoryOS (BAI-LAB/MemoryOS) | 1.6k | 三层+heat | 层间升降 | **有：heat衰减+FIFO**（存储层唯一） | 无 | 无 |

另核查：memobase 2.8k（profile覆盖更新，无衰减）。

### 各行 primary URL 与精确星数（checked_at 2026-08-10，GitHub API）

- mem0 62,933：https://github.com/mem0ai/mem0 ；Memory Decay=检索侧 0.3×–1.5× 重排，官方原话 "It's a soft re-rank, not a filter" / "Nothing gets deleted or hidden"，博客 2026-08-07（changelog 首发 2026-05-08）：https://mem0.ai/blog/introducing-memory-decay-in-mem0 ＋ https://docs.mem0.ai/platform/features/memory-decay ；TTL expiration_date（2026-06-27，仅托管 Platform，OSS 无）：https://docs.mem0.ai/changelog/highlights
- Letta 24,171：https://github.com/letta-ai/letta
- Zep/Graphiti 29,732：https://github.com/getzep/graphiti
- LangMem 1,602：https://github.com/langchain-ai/langmem
- cognee 29,912：https://github.com/topoteretes/cognee
- Supermemory 28,838：https://github.com/supermemoryai/supermemory （README："Automatic forgetting. … Temporary facts ('I have an exam tomorrow') expire after the date passes"）。注：2026-08-10 在其官网/docs/README 均已找不到旧措辞 "contextual expiry"，现行表述为 "automatic forgetting"/"forgets expired information"；机制仍无公开文档，黑盒判断维持
- Hindsight 19,453：https://github.com/vectorize-io/hindsight ；consolidation 四杆框架（importance/merge/decay/eviction）博客 2026-05-21：Hindsight 自身 decay="Recency boost at retrieval"（检索侧），且 "Hindsight deliberately skips individual memory eviction"：https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation
- MemoryOS 1,551：https://github.com/BAI-LAB/MemoryOS （README 含 mid_term_heat_threshold 配置）；论文 arXiv:2506.06326（EMNLP 2025 Oral），摘要原文 "short-term to mid-term updates follow a dialogue-chain-based FIFO principle"，heat 分数驱动 mid→long 升层与淘汰见正文：https://arxiv.org/abs/2506.06326
- memobase 2,835：https://github.com/memodb-io/memobase

## 关键事实（供 submission 引用，均需附 URL）

1. mem0 2026-04 新算法转 ADD-only："memories accumulate; nothing is overwritten"，冲突推到读取侧。https://github.com/mem0ai/mem0
2. Letta sleep-time compute：主 agent 无 core memory 编辑权，睡眠 agent 空闲整理。https://www.letta.com/blog/sleep-time-compute/
3. Graphiti bi-temporal："old facts are invalidated — not deleted"。https://github.com/getzep/graphiti
4. LangMem episodic 明确只存成功交互案例（失败被丢弃）。https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
5. benchmark 互撕：Zep《Is Mem0 Really SOTA?》https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ ；"benchmark theatre"批评 https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/
6. 在所审查项目范围内：**存储层**的自动衰减+淘汰仍仅 MemoryOS 实现（2026-08-10 复核仍成立）。变化：mem0 于 2026-05 起在托管 Platform 上线 Memory Decay，但为检索侧重排、官方明言"soft re-rank, not a filter"不删除（https://mem0.ai/blog/introducing-memory-decay-in-mem0 ）；Hindsight 的 decay 亦为检索侧 recency 加权，且官方明言 "deliberately skips individual memory eviction"（https://hindsight.vectorize.io/blog/2026/05/21/agent-memory-consolidation ）。"为什么想起这条"的召回解释仍无一家提供（均只返回相似度分数）。

## 对我们的结论

- 三张差异化牌在所审查项目中均为空白或极浅
- 技术标配要跟上：混合检索+RRF、MCP 接入、"不覆盖只标失效"
- 盯防：Hindsight（增长最快、方向最近，但无自动失败闭环、无回执）
