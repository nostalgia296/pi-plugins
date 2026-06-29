/**
 * Goal Extension - Persistent thread goal with auto-continuation
 *
 * Ported from Claude Code's /goal command feature.
 *
 * Features:
 * - /goal <objective>  — Set a persistent goal that drives auto-continuation
 * - /goal              — Show current goal status
 * - /goal status       — Same as bare /goal
 * - /goal clear        — Remove active goal
 * - /goal pause        — Pause auto-continuation
 * - /goal resume       — Resume from paused state
 * - /goal continue     — Reset turn counter after max-turns and continue
 * - /goal complete     — Mark complete (manual override)
 * - GoalTool for LLM   — Model can get/update (complete/blocked) the goal
 * - Auto-continuation  — Agent auto-continues toward goal across turns
 * - Status line pill   — Shows goal progress in footer
 * - Session persistence — Goal state survives restarts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GoalStatus = "active" | "paused" | "blocked" | "complete" | "max_turns";

interface GoalState {
  objective: string;
  status: GoalStatus;
  tokensUsed: number;
  tokenBudget: number | null;
  startedAt: number; // timestamp ms
  pausedAt: number | null;
  turnsExecuted: number;
  blockedAttempts: number;
  lastBlockedReason: string | null;
}

interface GoalEntry {
  type: "goal-state";
  state: GoalState;
}

const GOAL_CUSTOM_TYPE = "goal-state";
const MAX_OBJECTIVE_CHARS = 4000;
const MAX_TURNS = 50;
const BLOCKED_ATTEMPTS_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let goal: GoalState | null = null;

function getGoal(): GoalState | null {
  return goal;
}

function formatElapsed(g: GoalState): string {
  const now = Date.now();
  const started = g.startedAt;
  let elapsedMs: number;

  if (g.status === "paused" && g.pausedAt) {
    elapsedMs = g.pausedAt - started;
  } else if (g.status === "complete") {
    elapsedMs = 0; // won't be used
  } else {
    elapsedMs = now - started;
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "complete":
      return "complete";
    case "max_turns":
      return "max_turns";
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function newGoal(objective: string): GoalState {
  return {
    objective,
    status: "active",
    tokensUsed: 0,
    tokenBudget: null,
    startedAt: Date.now(),
    pausedAt: null,
    turnsExecuted: 0,
    blockedAttempts: 0,
    lastBlockedReason: null,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persistGoalState(pi: ExtensionAPI): void {
  if (goal) {
    pi.appendEntry(GOAL_CUSTOM_TYPE, { state: goal } satisfies GoalEntry);
  }
}

function persistGoalClear(pi: ExtensionAPI): void {
  pi.appendEntry(GOAL_CUSTOM_TYPE, { state: null } satisfies { state: null });
}

function reconstructState(ctx: ExtensionContext): void {
  goal = null;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === GOAL_CUSTOM_TYPE) {
      const data = entry.data as { state: GoalState | null } | undefined;
      if (data) {
        goal = data.state;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Goal state mutations
// ---------------------------------------------------------------------------

function setGoal(objective: string): void {
  goal = newGoal(objective);
}

function clearGoal(): boolean {
  if (!goal) return false;
  goal = null;
  return true;
}

function pauseGoal(): GoalState | null {
  if (!goal) return null;
  if (goal.status !== "active") return null;
  goal.status = "paused";
  goal.pausedAt = Date.now();
  return goal;
}

function resumeGoal(): GoalState | null {
  if (!goal) return null;
  if (goal.status !== "paused") return null;
  goal.status = "active";
  goal.pausedAt = null;
  return goal;
}

function completeGoal(): GoalState | null {
  if (!goal) return null;
  if (goal.status === "complete") return null;
  goal.status = "complete";
  return goal;
}

function continueFromMaxTurns(): GoalState | null {
  if (!goal) return null;
  if (goal.status !== "max_turns") return null;
  goal.status = "active";
  goal.turnsExecuted = 0;
  return goal;
}

function incrementGoalTurns(): void {
  if (!goal) return;
  if (goal.status !== "active") return;
  goal.turnsExecuted++;
  if (goal.turnsExecuted >= MAX_TURNS) {
    goal.status = "max_turns";
  }
}

function recordBlockedAttempt(reason: string): {
  status: GoalStatus;
  attempts: number;
} | null {
  if (!goal) return null;
  if (goal.status !== "active") return null;

  goal.blockedAttempts++;
  goal.lastBlockedReason = reason;

  if (goal.blockedAttempts >= BLOCKED_ATTEMPTS_THRESHOLD) {
    goal.status = "blocked";
    return { status: "blocked", attempts: goal.blockedAttempts };
  }

  return { status: "active", attempts: goal.blockedAttempts };
}

function updateGoalTokens(delta: number): void {
  if (!goal) return;
  if (goal.status !== "active") return;
  goal.tokensUsed += delta;
}

// ---------------------------------------------------------------------------
// GoalTool — LLM-callable tool for goal management
// ---------------------------------------------------------------------------

const GOAL_TOOL_DESCRIPTION = `Get or update the active goal status. The model may only mark a goal as "complete" or "blocked".`;

const GOAL_TOOL_PROMPT = `Use this tool to interact with the active thread goal.

## Actions

### get
Returns the current goal state (objective, status, token usage, elapsed time, turns executed).
No input required beyond \`action: "get"\`.

### update
Transition the goal to a terminal status. Only two values are accepted:
- **complete** — All requirements are verified (see Completion Audit below).
- **blocked** — An insurmountable obstacle has persisted for 3+ consecutive turns (see Blocked Audit below).

When marking complete, provide a brief \`reason\` summarising what was achieved.
When marking blocked, provide a \`reason\` describing the specific blocker.

## Completion Audit (required before marking complete)
1. Derive concrete requirements from the objective.
2. Preserve the original scope — do not redefine success around existing work.
3. For every requirement, identify authoritative evidence (test output, file content, command result).
4. Treat tests and manifests as evidence only after confirming they cover the requirement.
5. Treat uncertain or indirect evidence as "not achieved".
6. The audit must PROVE completion, not merely fail to find remaining work.

## Blocked Audit (required before marking blocked)
1. The same blocking condition must persist across at least 3 consecutive continuation turns.
2. "Difficult", "slow", or "partially incomplete" is NOT blocked.
3. Only genuinely insurmountable obstacles qualify (missing credentials, external service down, etc.).

## Important
- You cannot pause, resume, or clear a goal — only the user can do that via \`/goal\`.
- If no goal is active, \`get\` returns a message saying so; \`update\` returns an error.
- On completion, the tool result includes a usage report (tokens, time, turns).`;

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function buildStatusText(): string {
  if (!goal) return "";

  const truncated =
    goal.objective.length > 30 ? `${goal.objective.slice(0, 27)}…` : goal.objective;
  const budget =
    goal.tokenBudget !== null
      ? `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget)}`
      : formatTokens(goal.tokensUsed);
  const statusLabel = formatStatusLabel(goal.status);

  return `${statusLabel} · ${truncated} · ${budget}`;
}

// ---------------------------------------------------------------------------
// Goal objective injection — appends goal to system prompt
// ---------------------------------------------------------------------------

function injectGoalContext(): string | null {
  if (!goal) return null;
  if (goal.status === "complete") return null;
  if (goal.status === "paused") return null;

  const budgetNote =
    goal.tokenBudget !== null
      ? `\nToken budget: ${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)} used`
      : `\nTokens used: ${formatTokens(goal.tokensUsed)}`;

  const turnsNote = `\nContinuation turns: ${goal.turnsExecuted} / ${MAX_TURNS}`;

  let statusNote = "";
  if (goal.status === "max_turns") {
    statusNote =
      "\n⚠️ Max continuation turns reached. The user must run /goal continue to resume auto-continuation.";
  } else if (goal.status === "blocked") {
    statusNote = `\n⚠️ Goal is BLOCKED after ${goal.blockedAttempts} attempts. Reason: ${goal.lastBlockedReason ?? "unspecified"}`;
  }

  const auditRules = [
    "",
    "## GoalTool Usage",
    "- Use the \"goal\" tool to check the active goal status before each continuation turn.",
    "- Only mark the goal complete after a rigorous completion audit.",
    "- Only mark the goal blocked after 3+ consecutive turns with the same insurmountable obstacle.",
    "",
    "## Completion Audit (required before calling goal update complete)",
    "1. Derive concrete requirements from the objective.",
    "2. Preserve the original scope — do not redefine success around existing work.",
    "3. For every requirement, identify authoritative evidence (test output, file content, command result).",
    "4. Treat tests and manifests as evidence only after confirming they cover the requirement.",
    "5. Treat uncertain or indirect evidence as \"not achieved\".",
    "6. The audit must PROVE completion, not merely fail to find remaining work.",
    "",
    "## Blocked Audit (required before calling goal update blocked)",
    "1. The same blocking condition must persist across at least 3 consecutive continuation turns.",
    '2. "Difficult", "slow", or "partially incomplete" is NOT blocked.',
    "3. Only genuinely insurmountable obstacles qualify (missing credentials, external service down, etc.).",
  ].join("\n");

  return [
    "<goal>",
    `Objective: ${goal.objective}`,
    `Status: ${formatStatusLabel(goal.status)}`,
    budgetNote,
    turnsNote,
    statusNote,
    auditRules,
    "</goal>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Guard to prevent overlapping auto-continuations
  let autoContinueTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleAutoContinue() {
    if (!goal || goal.status !== "active") return;

    // Cancel any pending continuation
    if (autoContinueTimer) {
      clearTimeout(autoContinueTimer);
      autoContinueTimer = null;
    }

    // Use setTimeout to break the synchronous agent_end → new-cycle chain.
    // This ensures each turn fully completes before the next continuation fires.
    autoContinueTimer = setTimeout(() => {
      autoContinueTimer = null;
      if (!goal || goal.status !== "active") return;

      const continuePrompt = [
        `Continue working toward the goal: "${goal.objective}".`,
        `Status: ${formatStatusLabel(goal.status)} | Turns: ${goal.turnsExecuted}/${MAX_TURNS} | Tokens: ${formatTokens(goal.tokensUsed)}`,
        "Use the goal tool to check status, and mark complete or blocked as appropriate.",
      ].join(" ");

      pi.sendUserMessage(continuePrompt);
    }, 200);
  }

  // ---- Session lifecycle: reconstruct state on load ----
  pi.on("session_start", async (_event, ctx) => {
    reconstructState(ctx);
    // Update status display
    if (ctx.hasUI) {
      const text = buildStatusText();
      if (text) {
        ctx.ui.setStatus("goal", text);
      }
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructState(ctx);
    if (ctx.hasUI) {
      const text = buildStatusText();
      ctx.ui.setStatus("goal", text || undefined);
    }
  });

  // ---- Goal objective injection: add goal to system prompt ----
  pi.on("before_agent_start", async (event, _ctx) => {
    const goalBlock = injectGoalContext();
    if (goalBlock) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + goalBlock,
      };
    }
  });

  // ---- Track tokens and auto-increment turns ----
  pi.on("turn_end", async (_event, _ctx) => {
    // Increment turn counter
    if (goal && goal.status === "active") {
      incrementGoalTurns();
      persistGoalState(pi);
    }
    // Update status display
    const text = buildStatusText();
    if (_ctx.hasUI) {
      _ctx.ui.setStatus("goal", text || undefined);
    }
  });

  // ---- Message end: track token usage ----
  pi.on("message_end", async (event, _ctx) => {
    if (goal && goal.status === "active" && event.message.role === "assistant") {
      const usage = event.message.usage;
      if (usage) {
        const delta =
          (usage.inputTokens ?? 0) +
          (usage.outputTokens ?? 0);
        if (delta > 0) {
          updateGoalTokens(delta);
        }
      }
    }
  });

  // ---- Auto-continuation: after agent finishes, continue if goal is active ----
  pi.on("agent_end", async (_event, _ctx) => {
    scheduleAutoContinue();
  });

  // ---- GoalTool: LLM tool for checking/updating goal ----
  pi.registerTool({
    name: "goal",
    label: "Goal",
    description: GOAL_TOOL_PROMPT,
    promptSnippet: "Get or update the active goal (complete/blocked)",
    promptGuidelines: [
      "Use goal to check the active goal status before each continuation turn. Use goal to mark the goal complete only after a rigorous completion audit. Use goal to mark the goal blocked only after 3+ consecutive turns with the same insurmountable obstacle.",
    ],
    parameters: Type.Object({
      action: StringEnum(["get", "update"] as const),
      status: Type.Optional(StringEnum(["complete", "blocked"] as const)),
      reason: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const action = params.action ?? (params.status ? "update" : "get");

      if (action === "get") {
        if (!goal) {
          return {
            content: [
              {
                type: "text",
                text: "No active goal. The user can set one with `/goal <objective>`.",
              },
            ],
            details: { success: true },
          };
        }

        const snapshot = {
          objective: goal.objective,
          status: formatStatusLabel(goal.status),
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget,
          elapsed: formatElapsed(goal),
          turnsExecuted: goal.turnsExecuted,
        };

        return {
          content: [
            {
              type: "text",
              text: Object.entries(snapshot)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n"),
            },
          ],
          details: { success: true, goal: snapshot },
        };
      }

      // action === "update"
      if (!params.status) {
        throw new Error(
          'The "status" field is required for update. Use "complete" or "blocked".',
        );
      }

      if (!goal) {
        throw new Error("No active goal to update.");
      }

      if (params.status === "complete") {
        const tokensStr = `${goal.tokensUsed} tokens`;
        const report = [
          "Goal achieved — usage report:",
          `  Token usage: ${tokensStr}`,
          `  Active time: ${formatElapsed(goal)}`,
          `  Continuation turns: ${goal.turnsExecuted}`,
        ].join("\n");

        completeGoal();
        persistGoalState(pi);

        return {
          content: [{ type: "text", text: report }],
          details: {
            success: true,
            goal: {
              objective: goal.objective,
              status: formatStatusLabel(goal.status),
              tokensUsed: goal.tokensUsed,
              tokenBudget: goal.tokenBudget,
              elapsed: formatElapsed(goal),
              turnsExecuted: goal.turnsExecuted,
            },
            report,
          },
        };
      }

      // status === "blocked"
      const reason = params.reason ?? "unspecified blocker";
      const result = recordBlockedAttempt(reason);

      if (!result) {
        throw new Error("Goal is not in a state that accepts blocked attempts.");
      }

      persistGoalState(pi);

      if (result.status === "blocked") {
        const msg = `Goal marked as blocked after ${result.attempts} consecutive attempts. Reason: ${reason}`;
        return {
          content: [{ type: "text", text: msg }],
          details: {
            success: true,
            goal: {
              objective: goal!.objective,
              status: formatStatusLabel(goal!.status),
              tokensUsed: goal!.tokensUsed,
              tokenBudget: goal!.tokenBudget,
              elapsed: formatElapsed(goal!),
              turnsExecuted: goal!.turnsExecuted,
            },
            message: msg,
          },
        };
      }

      const msg = `Blocked attempt ${result.attempts} recorded. The goal remains active — the same condition must persist for 3 consecutive turns before it is marked blocked.`;
      return {
        content: [{ type: "text", text: msg }],
        details: { success: true, message: msg },
      };
    },
  });

  // ---- /goal command ----
  pi.registerCommand("goal", {
    description:
      "Set or view a persistent goal that drives auto-continuation across turns",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        "status",
        "clear",
        "pause",
        "resume",
        "continue",
        "complete",
      ];
      const filtered = subcommands.filter((s) => s.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((s) => ({ value: s, label: s }))
        : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // /goal or /goal status — show current status
      if (!trimmed || trimmed.toLowerCase() === "status") {
        if (!goal) {
          ctx.ui.notify(
            "No active goal. Set one with `/goal <objective>`.",
            "info",
          );
          return;
        }

        const tokens =
          goal.tokenBudget !== null
            ? `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}`
            : formatTokens(goal.tokensUsed);

        const lines = [
          `Goal: ${goal.objective}`,
          `Status: ${formatStatusLabel(goal.status)}`,
          `Time: ${formatElapsed(goal)}`,
          `Tokens: ${tokens}`,
          `Continuation turns: ${goal.turnsExecuted}`,
        ];

        if (goal.status === "max_turns") {
          lines.push(
            `Hint: Max continuation turns reached (${MAX_TURNS}). Run \`/goal continue\` to reset and continue.`,
          );
        }

        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const lower = trimmed.toLowerCase();

      // /goal clear
      if (lower === "clear") {
        const cleared = clearGoal();
        if (cleared) {
          persistGoalClear(pi);
        }
        if (ctx.hasUI) {
          ctx.ui.setStatus("goal", undefined);
        }
        ctx.ui.notify(cleared ? "Goal cleared." : "No active goal to clear.", "info");
        return;
      }

      // /goal pause
      if (lower === "pause") {
        const g = pauseGoal();
        if (g) {
          persistGoalState(pi);
          if (ctx.hasUI) {
            ctx.ui.setStatus("goal", buildStatusText());
          }
        }
        ctx.ui.notify(g ? "Goal paused." : "No active goal to pause.", "info");
        return;
      }

      // /goal resume
      if (lower === "resume") {
        const current = getGoal();
        if (current?.status === "max_turns") {
          ctx.ui.notify(
            `Goal reached max continuation turns (${MAX_TURNS}). Run \`/goal continue\` to reset turn counter and continue.`,
            "warning",
          );
          return;
        }
        const g = resumeGoal();
        if (g) {
          persistGoalState(pi);
          if (ctx.hasUI) {
            ctx.ui.setStatus("goal", buildStatusText());
          }
        }
        ctx.ui.notify(g ? "Goal resumed." : "No paused goal to resume.", "info");

        // Trigger auto-continuation if resumed
        if (g && ctx.isIdle()) {
          pi.sendUserMessage(
            `Continue working toward the goal: "${g.objective}". Use goal to check status, and mark complete or blocked as appropriate.`,
          );
        }
        return;
      }

      // /goal continue
      if (lower === "continue") {
        const g = continueFromMaxTurns();
        if (g) {
          persistGoalState(pi);
          if (ctx.hasUI) {
            ctx.ui.setStatus("goal", buildStatusText());
          }
        }
        ctx.ui.notify(
          g
            ? `Goal continuation counter reset (0/${MAX_TURNS}). Continuing…`
            : "Current goal is not in max-turns state.",
          "info",
        );

        // Trigger auto-continuation
        if (g && ctx.isIdle()) {
          pi.sendUserMessage(
            `Continue working toward the goal: "${g.objective}". Use goal to check status, and mark complete or blocked as appropriate.`,
          );
        }
        return;
      }

      // /goal complete
      if (lower === "complete") {
        const g = completeGoal();
        if (g) {
          persistGoalState(pi);
          if (ctx.hasUI) {
            ctx.ui.setStatus("goal", buildStatusText());
          }
        }
        ctx.ui.notify(
          g ? "Goal marked complete." : "No active goal to complete.",
          "info",
        );
        return;
      }

      // /goal <objective> — set a new goal
      if (trimmed.length > MAX_OBJECTIVE_CHARS) {
        ctx.ui.notify(
          `Goal objective is too long (${trimmed.length} chars; limit ${MAX_OBJECTIVE_CHARS}). Save the detailed instructions to a file and reference it from a shorter objective.`,
          "error",
        );
        return;
      }

      const existing = getGoal();
      const needsConfirmation =
        existing !== null && existing.status !== "complete";

      if (needsConfirmation && ctx.mode === "tui") {
        // Show replace confirmation dialog
        const tokensDisplay =
          existing!.tokenBudget !== null
            ? `${formatTokens(existing!.tokensUsed)} / ${formatTokens(existing!.tokenBudget)}`
            : formatTokens(existing!.tokensUsed);

        const dialogText = [
          "A goal is already in progress. Replacing it will reset all progress and counters.",
          "",
          "Current goal:",
          `  Objective: ${existing!.objective}`,
          `  Status: ${formatStatusLabel(existing!.status)}`,
          `  Time: ${formatElapsed(existing!)}`,
          `  Tokens: ${tokensDisplay}`,
          "",
          "New objective:",
          `  ${trimmed}`,
        ].join("\n");

        const confirmed = await ctx.ui.confirm("Replace active goal?", dialogText);

        if (!confirmed) {
          ctx.ui.notify("Kept the current goal. New objective discarded.", "info");
          return;
        }
      }

      setGoal(trimmed);
      incrementGoalTurns();
      persistGoalState(pi);

      if (ctx.hasUI) {
        ctx.ui.setStatus("goal", buildStatusText());
      }

      ctx.ui.notify("Goal set.", "info");

      // Trigger auto-continuation
      if (ctx.isIdle()) {
        pi.sendUserMessage(
          `Work toward this goal: ${trimmed}. Use goal to check status periodically, and mark complete or blocked as appropriate.`,
        );
      }
    },
  });
}
