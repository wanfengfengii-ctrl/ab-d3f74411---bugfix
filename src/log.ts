/**
 * Privacy-preserving logger.
 *
 * The application must never write raw institution-local identifiers to logs.
 * This logger is the single logging seam: it emits structured single-line JSON
 * containing only batch ids (deployment-scoped correlation ids, not PHI),
 * counts, status codes and error codes. It deliberately has no API for
 * free-form strings sourced from requests.
 */

type LogLevel = "info" | "warn" | "error";

interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  info(event: string, fields: LogFields = {}): void {
    emit("info", event, fields);
  },
  warn(event: string, fields: LogFields = {}): void {
    emit("warn", event, fields);
  },
  error(event: string, fields: LogFields = {}): void {
    emit("error", event, fields);
  },
};
