import { loadConfig } from "./config.ts";
import { createAppServer } from "./http.ts";
import { log } from "./log.ts";
import { ManifestStore } from "./store.ts";

async function main(): Promise<void> {
  const config = await loadConfig();
  const store = new ManifestStore(config.dataDir);
  await store.load();

  const server = createAppServer({
    store,
    aliasSecret: config.aliasSecret,
    maxBodyBytes: config.maxBodyBytes,
  });

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address !== null ? address.port : config.port;
    log.info("server_listening", { host: config.host, port: actualPort });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("server_shutting_down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log.error("startup_failed", {
    message: err instanceof Error ? err.message : "unknown error",
  });
  process.exit(1);
});
