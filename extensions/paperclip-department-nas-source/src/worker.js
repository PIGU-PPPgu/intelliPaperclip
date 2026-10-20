import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import manifest, { folderKey } from "./manifest.js";
import { getRoot, listEntries, readDocument, renderDocument, searchDocuments, statEntry } from "./source.js";

const plugin = definePlugin({
  async setup(ctx) {
    const register = (name, handler) => {
      const declaration = manifest.tools.find((tool) => tool.name === name);
      ctx.tools.register(name, declaration, async (parameters, runContext) => {
        try {
          return await handler(parameters ?? {}, runContext.companyId);
        } catch (error) {
          return { error: error instanceof Error ? error.message : "NAS source request failed" };
        }
      });
    };

    register("nas_list", async (parameters, companyId) => {
      const result = await listEntries(ctx, companyId, parameters.path);
      return { content: JSON.stringify(result, null, 2), data: result };
    });
    register("nas_search", async (parameters, companyId) => {
      const result = await searchDocuments(ctx, companyId, parameters.query);
      return { content: JSON.stringify(result, null, 2), data: result };
    });
    register("nas_read", async (parameters, companyId) => {
      const result = renderDocument(await readDocument(ctx, companyId, parameters.path));
      return { content: `${result.name} (${result.path})\n${result.content}`, data: result };
    });
    register("nas_stat", async (parameters, companyId) => {
      const { root, sourceKind } = await getRoot(ctx, companyId);
      const result = { ...await statEntry(root, parameters.path), sourceKind };
      return { content: JSON.stringify(result, null, 2), data: result };
    });
    ctx.logger.info("Department NAS source tools registered", { folderKey, toolCount: manifest.tools.length });
  },
  async onHealth() {
    return { status: "ok", message: "Read-only NAS source worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
