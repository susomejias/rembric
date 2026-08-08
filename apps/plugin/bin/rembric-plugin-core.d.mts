// Hand-written companion to rembric-plugin-core.mjs. `apps/plugin` has no
// build step and no typecheck, so nothing generates this — it is the only
// type surface the TypeScript clients (opencode's plugin.ts, Pi's index.ts)
// see over the shared core, and the only thing that makes a missing `agent`
// a compile error rather than a silently misattributed session.

export declare const MAX_TRANSCRIPT_CHARS: number;
export declare const POST_TIMEOUT_MS: number;

export declare const RECALL_REGEX: RegExp;
export declare const RECALL_NUDGE: string;
export declare const FIRST_PROMPT_NUDGE: string;
export declare const SAVE_NUDGE_EVERY: number;
export declare const SAVE_NUDGE: string;
export declare const SUMMARY_NUDGE_EVERY: number;
export declare const SUMMARY_NUDGE: string;
export declare const SESSION_ID_NUDGE_TEMPLATE: string;

export declare function diag(line: string): void;
export declare function stripPrivateTags(text: string): string;
export declare function underscoreToolNames(text: string): string;

export type TranscriptEntry = { role: 'user' | 'assistant'; text: string; id?: string };

export type SummaryBody = { summary: string; title?: string; final: false };

export type SessionProtocolOptions = {
  agent: string;
  serverUrl: string | undefined;
  apiToken: string | undefined;
  slug: string | null;
  cwd?: string;
};

export type SessionProtocol = {
  readonly disabled: boolean;
  readonly baseUrl: string;
  isSubAgent(sessionId: string): boolean;
  markSubAgent(sessionId: string): void;
  isKnown(sessionId: string): boolean;
  ensureSession(sessionId: string): Promise<void>;
  nudgesForTurn(sessionId: string, prompt: string): string[];
  /** Returns the entries the per-session cap evicted, oldest first. */
  appendUserMessage(sessionId: string, rawText: string): TranscriptEntry[];
  appendAssistantMessage(sessionId: string, rawText: string): TranscriptEntry[];
  upsertAssistantMessage(sessionId: string, messageId: string, rawText: string): TranscriptEntry[];
  flushSessionSummary(sessionId: string): Promise<void>;
  scheduleIdleFlush(sessionId: string): void;
  flushAllFireAndForget(): void;
  forgetSession(sessionId: string): TranscriptEntry[];
};

export declare function createSessionProtocol(options: SessionProtocolOptions): SessionProtocol;
