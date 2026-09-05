import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openModelConfig } from "./ui.ts";

const VERSION = "0.1.0";

export default function xpiMymodels(pi: ExtensionAPI): void {
  pi.registerCommand("xpi-mymodels", {
    description: "Configure Pi providers, models, pricing, and Ctrl+P cycling",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("xpi-mymodels requires Pi interactive TUI mode", "error");
        return;
      }
      try {
        await openModelConfig(ctx);
      } catch (error) {
        ctx.ui.notify(
          `xpi-mymodels failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("xpi-mymodels-status", {
    description: "Show xpi-mymodels status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`xpi-mymodels ${VERSION} loaded`);
    },
  });
}
