import { API_LIMITS } from "./config.js";
import { estimateRequestTokens } from "./tokens.js";
import type { Question, Questions } from "./types.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  question_id: string;
  rule: string;
  severity: Severity;
  message: string;
  fix: string;
}

export interface LintResult {
  errors: Finding[];
  warnings: Finding[];
  infos: Finding[];
  estimated_tokens: { state: number; questions: number; longest_question: number; total: number };
}

const DEGREE_ONLY = /^(very|somewhat|moderately|slightly|extremely|quite|fairly|highly|mildly|a bit|a little)?\s*(low|medium|high|severe|mild|good|bad|strong|weak|poor|great|positive|negative|neutral|urgent|important|relevant|frustrated|angry|calm|likely|unlikely|small|large|big)\s*$/i;
const COUNTING = /\b(how many|count|number of|total of|sum of|difference between|average of|percentage of|days between|hours between|older than \d|larger than \d|greater than \d|less than \d|more than \d)\b/i;
const DATE_COMPARE = /\b(before|after) (the )?(\d+|today|yesterday|tomorrow|date|deadline|due date|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b|\b(earlier than|later than|within \d+ (days?|weeks?|months?|years?)|expired|overdue|due date)\b|\bbetween .* and .*(19|20)\d\d\b/i;
const DOUBLE_NEG = /\b(not un\w+|doesn't fail to|does not fail to|isn't not|never fails to|not impossible|not without)\b/i;
const NEGATION_START = /^\s*(no|not|never|none|doesn't|does not|isn't|is not|lacks|without)\b/i;
const OTHER_OPTION = /^(other|none|none_of_the_above|none of the above|unknown|not_stated|not stated|n\/a|unclear)$/i;

/** A Noul criterion is a string or an object such as {what, examples}; compare on its wording. */
function criterionText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const what = (value as Record<string, unknown>).what;
    if (typeof what === "string") return what;
  }
  return "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function wordCount(value: unknown): number {
  return text(value).trim().split(/\s+/).filter(Boolean).length;
}

function countJoins(s: string): number {
  return (s.match(/\b(and|or)\b/gi) ?? []).length;
}

/** Backticked dot/index paths such as `ticket.messages[0].text`. */
export function extractStatePaths(value: unknown): string[] {
  const found = text(value).match(/`([A-Za-z_][\w.\[\]-]*)`/g) ?? [];
  return found.map((m) => m.slice(1, -1));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Set by evaluate_many / evaluate.py --repeat; never referenced by a question. */
const IMPLICIT_STATE_FIELDS = new Set(["sample_uid"]);

function covers(a: string, b: string): boolean {
  return a === b || b.startsWith(a + ".") || b.startsWith(a + "[");
}

/**
 * Object-key paths of `state` that no question path touches: a path is used when a question
 * names it, an ancestor of it, or a descendant of it. Arrays count as one field. Only the
 * highest unused ancestor is returned, so an unused subtree is one finding.
 */
export function unusedStateFields(state: unknown, used: string[]): string[] {
  const out: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const key of Object.keys(obj)) {
      if (!prefix && IMPLICIT_STATE_FIELDS.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (used.some((u) => covers(u, path))) continue;
      if (used.some((u) => covers(path, u))) {
        if (isPlainObject(obj[key])) walk(obj[key], path);
        continue;
      }
      out.push(path);
    }
  };
  if (isPlainObject(state)) walk(state, "");
  return out;
}

/** Every path in `state` (indices normalised to `[]`) that equals a forbidden entry or ends with `.<entry>`. */
export function forbiddenStatePaths(state: unknown, forbidden: string[]): string[] {
  const hits = new Set<string>();
  const walk = (value: unknown, path: string) => {
    if (path && forbidden.some((f) => path === f || path.endsWith("." + f))) hits.add(path);
    if (Array.isArray(value)) for (const item of value) walk(item, `${path}[]`);
    else if (isPlainObject(value)) for (const key of Object.keys(value)) walk(value[key], path ? `${path}.${key}` : key);
  };
  walk(state, "");
  return [...hits];
}

export function resolvePath(state: unknown, path: string): boolean {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = state;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") return false;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
    } else {
      if (!(part in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return true;
}

function lintQuestion(id: string, q: Question, state: unknown, push: (f: Omit<Finding, "question_id">) => void): void {
  const instr = text(q.instructions);

  if (!q.type || !["noul", "choice", "score"].includes(q.type)) {
    push({ rule: "unknown_type", severity: "error", message: `type must be noul, choice or score (got ${JSON.stringify((q as { type?: unknown }).type)})`, fix: "Set type to one of the three primitives." });
    return;
  }

  if (q.type === "score") {
    const levels = Array.isArray(q.criteria) ? q.criteria : null;
    if (!levels || levels.length < API_LIMITS.minScoreLevels || levels.length > API_LIMITS.maxScoreLevels) {
      push({ rule: "score_levels_range", severity: "error", message: `Score criteria must be an ordered array of ${API_LIMITS.minScoreLevels}–${API_LIMITS.maxScoreLevels} levels (got ${levels ? levels.length : typeof q.criteria})`, fix: "Describe 2–10 distinct situations, low to high." });
    } else {
      if (levels.every((l) => typeof l === "string" && /^\s*[\d.]+\s*$/.test(l))) {
        push({ rule: "numeric_only_levels", severity: "warning", message: "Score levels are numbers only; the model never sees level numbers, only descriptions", fix: "Describe the situation at each level, e.g. 'Broken feature, but a workaround exists'." });
      }
      levels.forEach((l, i) => {
        const s = text(l);
        if (typeof l === "string" && DEGREE_ONLY.test(s)) {
          push({ rule: "degree_words_in_levels", severity: "warning", message: `Level ${i} ("${s}") is a degree word, not a situation`, fix: "Describe what the state looks like at this level, with examples if needed." });
        }
        if (countJoins(s) >= 2 && typeof l === "string") {
          push({ rule: "multi_dimension_level", severity: "warning", message: `Level ${i} joins several properties ("${s.slice(0, 60)}")`, fix: "One Score measures one dimension. Split into separate Score questions and combine in code." });
        }
      });
    }
  }

  if (q.type === "choice") {
    const opts = q.criteria && typeof q.criteria === "object" && !Array.isArray(q.criteria) ? Object.keys(q.criteria) : null;
    if (!opts || opts.length < 1 || opts.length > API_LIMITS.maxChoiceOptions) {
      push({ rule: "choice_options_range", severity: "error", message: `Choice criteria must be a map of 1–${API_LIMITS.maxChoiceOptions} options (got ${opts ? opts.length : typeof q.criteria})`, fix: "Provide a map of option name to description (or null). Split >255 options into two stages." });
    } else if (!opts.some((o) => OTHER_OPTION.test(o))) {
      push({ rule: "no_other_option", severity: "info", message: "No 'other' / 'none of the above' option", fix: "Add one if the list might not cover every input, so the model can say nothing fits." });
    }
  }

  if (q.type === "noul" && q.criteria && typeof q.criteria === "object") {
    const t = criterionText(q.criteria.true);
    const f = criterionText(q.criteria.false);
    if (t && NEGATION_START.test(t) && f && !NEGATION_START.test(f)) {
      push({ rule: "noul_criteria_inverted", severity: "warning", message: "criteria.true starts with a negation while criteria.false is affirmative; check that a high noul really means 'yes' to the instructions", fix: "Prefer phrasing instructions so that the affirmative case is criteria.true (e.g. ask 'Does the record contain personal information?' rather than 'Is it free of...')." });
    }
  }

  if (typeof q.instructions === "string" && wordCount(instr) < 3 && /[_-]/.test(id)) {
    push({ rule: "id_only_semantics", severity: "warning", message: `instructions is only ${wordCount(instr)} word(s); the question id "${id}" is NOT sent to the model`, fix: "Write the complete question in instructions." });
  }
  if (typeof q.instructions === "string" && countJoins(instr) >= 2) {
    push({ rule: "compound_instruction", severity: "warning", message: "instructions joins several judgments with and/or", fix: "Ask one atomic question per judgment and combine the answers in code." });
  }
  if (COUNTING.test(instr)) {
    if (q.type === "score" && Array.isArray(q.criteria)) {
      push({ rule: "counting_or_math", severity: "info", message: "instructions asks 'how many' or similar; fine when the Score levels are named buckets (e.g. 'Net 30'), not when the model must compute the number", fix: "Keep it if each level names a situation or range the model can read off the text; otherwise compute in code." });
    } else {
      push({ rule: "counting_or_math", severity: "warning", message: "instructions asks for counting or arithmetic; Jev is not a calculator", fix: "Enumerate candidates in code and ask one Noul per item, compute the number in code, or bucket it into Score levels." });
    }
  }
  if (DATE_COMPARE.test(instr)) {
    push({ rule: "date_comparison", severity: "warning", message: "instructions compares dates or times; Jev reads dates as text", fix: "Extract date parts with Choice questions (with a 'not stated' option) and compare in code." });
  }
  if (DOUBLE_NEG.test(instr)) {
    push({ rule: "double_negative", severity: "warning", message: "instructions contains a double negative", fix: "Rephrase directly; split into two literal questions if needed." });
  }
  if (state !== undefined) {
    const instrObj = q.instructions !== null && typeof q.instructions === "object" ? q.instructions : undefined;
    for (const path of extractStatePaths(q.instructions)) {
      // Structured instructions (official "Advanced: structure") refer to their own keys, e.g. `field`.
      if (!resolvePath(state, path) && !(instrObj !== undefined && resolvePath(instrObj, path))) {
        push({ rule: "state_path_missing", severity: "warning", message: `path \`${path}\` referenced in instructions does not exist in state or in the instructions object`, fix: "Fix the path or add the field to state." });
      }
    }
  }
}

export function lintQuestions(questions: Questions, state?: unknown, maxTokensPerCall: number = API_LIMITS.totalTokens, forbidden: string[] = []): LintResult {
  const findings: Finding[] = [];
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    findings.push({ question_id: "", rule: "no_questions", severity: "error", message: "questions is empty", fix: "Add at least one question." });
  }
  for (const id of ids) {
    lintQuestion(id, questions[id] as Question, state, (f) => findings.push({ question_id: id, ...f }));
  }

  if (state !== undefined) {
    for (const path of forbiddenStatePaths(state, forbidden)) {
      findings.push({ question_id: "", rule: "state_path_forbidden", severity: "error", message: `state contains forbidden path \`${path}\``, fix: "Remove the field in code before building the state; the model must never see it." });
    }
    // Only when the questions use the path convention at all; otherwise every field would be "unused".
    const used = ids.flatMap((id) => extractStatePaths((questions[id] as Question).instructions)).filter((p) => resolvePath(state, p));
    if (used.length > 0) {
      for (const path of unusedStateFields(state, used)) {
        findings.push({ question_id: "", rule: "state_field_unused", severity: "warning", message: `state field \`${path}\` is not referenced by any question`, fix: "Remove it from the state (irrelevant content lowers accuracy) or reference it from a question." });
      }
    }
  }

  const est = estimateRequestTokens(state ?? "", questions);
  if (est.total > Math.min(maxTokensPerCall, API_LIMITS.totalTokens)) {
    findings.push({ question_id: "", rule: "token_budget", severity: "error", message: `estimated ${est.total} tokens for state + questions exceeds the ${Math.min(maxTokensPerCall, API_LIMITS.totalTokens)} token limit`, fix: "Send only the state fields the questions need, or split states across calls (tenbin_evaluate_many)." });
  } else if (est.state + est.longestQuestion > API_LIMITS.stateAndLongestQuestionTokens) {
    findings.push({ question_id: "", rule: "token_budget", severity: "error", message: `estimated state + longest question = ${est.state + est.longestQuestion} tokens exceeds the ${API_LIMITS.stateAndLongestQuestionTokens} token limit`, fix: "Trim the state or the longest question." });
  } else if (est.total > 0.8 * Math.min(maxTokensPerCall, API_LIMITS.totalTokens)) {
    findings.push({ question_id: "", rule: "token_budget", severity: "warning", message: `estimated ${est.total} tokens is within 20% of the limit`, fix: "Consider trimming state." });
  }

  return {
    errors: findings.filter((f) => f.severity === "error"),
    warnings: findings.filter((f) => f.severity === "warning"),
    infos: findings.filter((f) => f.severity === "info"),
    estimated_tokens: { state: est.state, questions: est.questions, longest_question: est.longestQuestion, total: est.total },
  };
}
