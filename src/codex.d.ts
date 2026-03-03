/**
 * Ambient type declarations for @openai/codex.
 *
 * The package ships as a CLI bundle without library exports or type
 * declarations.  We declare just the subset of the API surface that
 * the Dispatch Codex provider relies on.
 */
declare module "@openai/codex" {
  export interface AgentLoopOptions {
    model: string;
    config: { model: string; instructions: string };
    approvalPolicy: "full-auto" | "suggest" | "ask-every-time";
    additionalWritableRoots?: string[];
    getCommandConfirmation: (
      command: unknown,
      patch?: unknown,
    ) => Promise<{ approved: boolean }>;
    onItem: (item: unknown) => void;
    onLoading: (loading: boolean) => void;
    onLastResponseId: (id: string) => void;
  }

  export interface ResponseItem {
    type: string;
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  }

  export class AgentLoop {
    constructor(opts: AgentLoopOptions);
    run(messages: unknown[]): Promise<ResponseItem[]>;
    terminate(): void;
  }
}
