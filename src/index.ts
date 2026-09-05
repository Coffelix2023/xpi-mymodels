import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VERSION = "0.1.0";

export default function xpiMymodels(pi: ExtensionAPI): void {
  pi.registerCommand("xpi-mymodels", {
    description: "Show xpi-mymodels status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`xpi-mymodels ${VERSION} loaded`);
    },
  });
}
