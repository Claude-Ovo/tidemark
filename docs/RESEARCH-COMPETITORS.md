# 竞品架构调研（原始报告）

checked_at: 2026-07-29（星数取自当日抓取的 GitHub 页面，提交前需重查）
调研方式：WebSearch + WebFetch 实际抓取各项目 GitHub/文档页。范围限于下列 8+2 个项目——所有"空白/唯一"结论均限定为 **among the projects reviewed**。

## 项目速览

| 项目 | stars（约） | 存储 | 冲突/更新 | 衰减/遗忘 | 失败→经验 | 召回可解释 |
|---|---|---|---|---|---|---|
| mem0 (mem0ai/mem0) | 61.9k | 向量(Qdrant)+SQL(+图可选) | ADD-only+读取侧时间推理 | 无 | 无 | 无 |
| Letta 原MemGPT (letta-ai/letta) | 24k | Postgres+pgvector+MemFS(git) | agent自编辑+sleep-time agent | 无（靠主动改写） | 无 | git历史（改动可溯） |
| Zep/Graphiti (getzep/graphiti) | 29.3k | 图数据库(Neo4j等) | bi-temporal边失效"invalidated not deleted" | 无（失效≠衰减） | 无 | provenance到Episode |
| LangMem (langchain-ai/langmem) | 1.6k | LangGraph BaseStore | LLM整合/Profile覆盖 | 仅概念文档描述 | prompt优化器；episodic**只存成功案例** | 无 |
| cognee (topoteretes/cognee) | 29.5k | Postgres全家桶(pgvector+图) | improve循环 | 手动forget(dataset) | 无 | 图谱路径部分 |
| Supermemory (supermemoryai/supermemory) | 28.7k | 黑盒混合 | 自动矛盾消解+supersedes | 宣传"contextual expiry"但黑盒 | 无 | 无 |
| Hindsight (vectorize-io/hindsight) | 18.9k | 稀疏+稠密向量+图 | Opinion带置信度 | 未发现 | Experience网络（最接近）；Reflect按需非自动 | 置信度分数（部分） |
| MemoryOS (BAI-LAB/MemoryOS) | 1.5k | 三层+heat | 层间升降 | **有：heat衰减+FIFO**（唯一） | 无 | 无 |

另核查：memobase ~2.8k（profile覆盖更新，无衰减）。

## 关键事实（供 submission 引用，均需附 URL）

1. mem0 2026-04 新算法转 ADD-only："memories accumulate; nothing is overwritten"，冲突推到读取侧。https://github.com/mem0ai/mem0
2. Letta sleep-time compute：主 agent 无 core memory 编辑权，睡眠 agent 空闲整理。https://www.letta.com/blog/sleep-time-compute/
3. Graphiti bi-temporal："old facts are invalidated — not deleted"。https://github.com/getzep/graphiti
4. LangMem episodic 明确只存成功交互案例（失败被丢弃）。https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
5. benchmark 互撕：Zep《Is Mem0 Really SOTA?》https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ ；"benchmark theatre"批评 https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/
6. 在所审查项目范围内：带半衰期的自动衰减仅 MemoryOS 实现；"为什么想起这条"的召回解释无一家提供（均只返回相似度分数）。

## 对我们的结论

- 三张差异化牌在所审查项目中均为空白或极浅
- 技术标配要跟上：混合检索+RRF、MCP 接入、"不覆盖只标失效"
- 盯防：Hindsight（增长最快、方向最近，但无自动失败闭环、无回执）
