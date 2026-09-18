# Cookbook index (https://docs.typesafe.ai/cookbooks/<slug>)

| problem | cookbook | slug | key numbers |
|---|---|---|---|
| many questions on one document | Parallel questions | parallel_questions | 13 questions in 1 call: 12.2x cheaper, 10.0x faster, same answers |
| rerank a retrieval shortlist | Re-ranking | rerank_typesafe | Top-1 5%→18%, Top-10 38%→62% on CLERC; $0.0645 for 1,200 pairs |
| find the line that answers a query | Line-by-line search | semantic_find | Choice over 218 line ids + Noul "answer exists" |
| select RAG passages, drop injections | Classifying RAG passages | classifying_rag_passages | 4 Nouls per passage, fixed-order thresholds |
| verify LLM citations | Double-checking citations | citation_check | string match in code, Choice supports/contradicts/says_nothing, auto-accept ≥0.8 |
| screen LLM inputs/outputs | Guardrails for LLMs | llm_guardrails | 4 hazard Nouls + severity Score, strict/permissive policies |
| validate structured extraction cheaply | SDE cascade | sde_cascade | mini → Noul battery per field → escalate if max > 0.7 |
| extract dates | Date extraction | date_extraction_cookbook | 7 Choices for parts, calendar math in code, review < 0.60 |
| extract emails/phones/amounts | Pre-parsed value extraction | pre_parsed_value_extraction_cookbook | regex candidates, Choice picks, code normalises |
| map text to typed function calls | Function calling | function_calling | 54 questions per command in one request |
| pick one skill per agent turn | Skill suggestion | skill_suggestion | rank 182 → re-judge top 3; wrong loads 16.8%→7.3% |
| deep taxonomy classification | Hierarchical classification | hierarchical_classification | beam search K=3 over Choice probabilities; 4/4 vs greedy 2/4 |
| classify with a fallback level | Classification using confidence | classification_using_confidence | 75-way Choice; confidence < 0.9 → report parent division; 65%→80% |
| entity matching | Knowledge graph entity alignment | entity_alignment | 3-level Score = merge / curator / unlinked; no threshold to fit |
| recover markdown structure | Structure recovery | autoformat | 2 requests, $0.0015 |
| turn text into ML features | Autoresearch feature discovery | autoresearch_feature_discovery | RMSE 3.09 → 1.77 with 38 questions |
| measure repeatability (choice) | Self-consistency: choices | consistency_choice_cookbook | 114 ms, $0.000046/call, prob std ≈ 0.01 |
| measure repeatability (noul) | Self-consistency: nouls | consistency_noul_cookbook | 0.30–0.70 band → human |
