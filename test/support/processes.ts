import { createServer } from "node:net";
import { eventually, type TestQueues } from "./sqs";

export interface AppProcess {
  url: string;
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  /** What the process has logged so far, parsed. Our own lines are flattened from Nest's JSON format. */
  logs(): LogLine[];
  stop(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export type LogLine = Record<string, unknown> & { message?: unknown };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** A real instance: its own Bun process, connection pool and port. */
export async function spawnApp(
  databaseUrl: string,
  queues: TestQueues,
  env: Record<string, string> = {},
): Promise<AppProcess> {
  const port = await freePort();
  const child = Bun.spawn(["bun", "src/main.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      SQS_QUEUE_NAME: queues.queueName,
      SQS_DLQ_NAME: queues.dlqName,
      SQS_EVENTS_QUEUE_NAME: queues.eventsQueueName,
      OUTBOX_POLL_INTERVAL_MS: "50",
      PENDING_POLL_INTERVAL_MS: "50",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let text = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) text += decoder.decode(chunk);
  };
  void collect(child.stdout);
  void collect(child.stderr);

  return {
    url: `http://127.0.0.1:${port}`,
    process: child,
    logs() {
      const lines: LogLine[] = [];
      for (const line of text.split("\n")) {
        try {
          const parsed = JSON.parse(line);
          lines.push(typeof parsed.message === "object" ? { ...parsed, ...parsed.message } : parsed);
        } catch {
          // A partial line, or output that is not a log.
        }
      }
      return lines;
    },
    async stop(signal = "SIGTERM") {
      child.kill(signal);
      await child.exited;
    },
  };
}

export async function waitUntilLive(instance: AppProcess, timeoutMs = 20_000): Promise<void> {
  await eventually(
    () =>
      fetch(`${instance.url}/health/live`)
        .then((response) => response.status)
        .catch(() => 0),
    (status) => status === 200,
    timeoutMs,
  );
}
