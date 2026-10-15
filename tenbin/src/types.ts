export type EntryType = string | { [key: string]: unknown } | unknown[] | null;

export interface NoulQuestion {
  type: "noul";
  instructions: EntryType;
  criteria?: { true?: EntryType; false?: EntryType } | null | undefined;
}
export interface ChoiceQuestion {
  type: "choice";
  instructions: EntryType;
  criteria: Record<string, EntryType>;
}
export interface ScoreQuestion {
  type: "score";
  instructions: EntryType;
  criteria: EntryType[];
}
/** Locates what the instructions describe in the request's image; needs Jev 1.14 (`jev-preview`). */
export interface BoxQuestion {
  type: "box";
  instructions: EntryType;
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion | BoxQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
}
/** Edges as fractions of the image's width (left, right) and height (top, bottom), from the top-left corner. */
export interface BoxAnswer {
  type: "box";
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number | null;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer | BoxAnswer;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface EvaluateResult {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
  cost_usd: number;
  request_id: string | undefined;
  latency_ms: number;
}
