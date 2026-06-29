/**
 * /clear - Clear the current session context
 *
 * Creates a new empty session, effectively resetting the conversation
 * context to a clean state. Equivalent to starting a fresh session
 * without changing the working directory or loaded extensions.
 *
 * Usage:
 *   /clear        - Clear session after confirmation
 *   /clear -f     - Force clear without confirmation
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clear", {
    description: "Clear current session context (fresh reset)",
    handler: async (args, ctx) => {
      const force = args.trim() === "-f" || args.trim() === "--force";

      // Ask for confirmation unless forced
      if (!force) {
        const ok = await ctx.ui.confirm(
          "Clear Session",
          "This will clear all conversation history and start fresh. Continue?",
        );
        if (!ok) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      const currentSessionFile = ctx.sessionManager.getSessionFile();

      // Create a brand-new session
      const result = await ctx.newSession({
        parentSession: currentSessionFile,
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify("Session cleared. Fresh start!", "info");
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("Clear cancelled by another extension", "info");
      }
    },
  });
}
