export type CliCommand =
  | { name: "init" }
  | { name: "import-wechat" | "import-douyin"; batchSize: number }
  | { name: "report" }
  | { name: "run-once"; mode: "dry-run" | "observe" | "supervised-send" | "live" }
  | { name: "approve-report"; hash: string };

export function parseCliCommand(args: string[]): CliCommand {
  const [name, flag, value] = args;
  if ((name === "init" || name === "report") && flag === undefined) {
    return { name };
  }
  if (name === "import-wechat" || name === "import-douyin") {
    const batchSize = flag === undefined ? 100 : parsePositiveInteger(flag, value);
    return { name, batchSize };
  }
  if (name === "approve-report" && flag === "--sha256" && value !== undefined && /^[a-f0-9]{64}$/u.test(value)) {
    return { name, hash: value };
  }
  if (name === "run-once" && flag === "--mode" && (value === "dry-run" || value === "observe" || value === "supervised-send" || value === "live")) {
    return { name, mode: value };
  }
  throw new Error("INVALID_CLI_COMMAND");
}

export function exitCodeFor(status: "success" | "warning" | "blocked" | "error"): 0 | 1 | 2 {
  if (status === "blocked") return 2;
  if (status === "error") return 1;
  return 0;
}

function parsePositiveInteger(flag: string, value: string | undefined): number {
  if (flag !== "--batch-size" || value === undefined || !/^\d+$/u.test(value)) {
    throw new Error("INVALID_CLI_COMMAND");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("INVALID_CLI_COMMAND");
  return parsed;
}
