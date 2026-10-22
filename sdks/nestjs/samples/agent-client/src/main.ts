import { AuthFailure, connect, type AuthMode, type McpSession } from "./mcp.js";
import {
  AssertionFailure,
  scenarios,
  SetupFailure,
  type ScenarioName,
} from "./scenarios.js";

interface ParsedArgs {
  readonly scenario: ScenarioName;
  readonly tool?: string;
  readonly query?: string;
  readonly argumentsJson: string;
}

interface Env {
  readonly base: string;
  readonly user: string;
  readonly authMode: AuthMode;
  readonly token?: string;
}

const scenarioNames: ReadonlySet<string> = new Set<ScenarioName>([
  "smoke",
  "validation-retry",
  "error-envelope",
  "upload",
  "family",
]);

function isScenarioName(value: string): value is ScenarioName {
  return scenarioNames.has(value);
}

const authModes: ReadonlySet<string> = new Set<AuthMode>([
  "oauth",
  "token",
  "bearer",
]);

function isAuthMode(value: string): value is AuthMode {
  return authModes.has(value);
}

function parseFlags(argv: readonly string[]): ParsedArgs {
  let scenario: ScenarioName | undefined;
  let tool: string | undefined;
  let query: string | undefined;
  let argumentsJson = "{}";

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(`missing value for flag "${flag ?? ""}"`);
    }
    if (flag === "--scenario") {
      if (!isScenarioName(value)) {
        throw new Error(`unknown scenario "${value}"`);
      }
      scenario = value;
    } else if (flag === "--tool") {
      tool = value;
    } else if (flag === "--query") {
      query = value;
    } else if (flag === "--arguments") {
      argumentsJson = value;
    } else {
      throw new Error(`unknown flag "${flag}"`);
    }
  }

  if (scenario === undefined) {
    throw new Error("--scenario is required");
  }
  return { scenario, tool, query, argumentsJson };
}

function parseLegacyPositional(argv: readonly string[]): ParsedArgs {
  const [query, tool, argumentsJson] = argv;
  return {
    scenario: "smoke",
    tool,
    query,
    argumentsJson: argumentsJson ?? "{}",
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.some((arg) => arg.startsWith("--"))) {
    return parseFlags(argv);
  }
  return parseLegacyPositional(argv);
}

function readEnv(): Env {
  const base = process.env["SEZZLEE_BASE_URL"] ?? "http://127.0.0.1:3000";
  const user = process.env["SEZZLEE_USER"] ?? "alice";
  const rawAuthMode = process.env["SEZZLEE_AUTH"] ?? "oauth";
  if (!isAuthMode(rawAuthMode)) {
    throw new Error(
      `unknown SEZZLEE_AUTH "${rawAuthMode}", expected oauth, token or bearer`,
    );
  }
  return {
    base,
    user,
    authMode: rawAuthMode,
    token: process.env["SEZZLEE_TOKEN"],
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  let args: ParsedArgs;
  let env: Env;
  try {
    args = parseArgs(process.argv.slice(2));
    env = readEnv();
  } catch (error) {
    console.error(describeError(error));
    return 2;
  }

  let session: McpSession;
  try {
    session = await connect({
      base: env.base,
      user: env.user,
      authMode: env.authMode,
      token: env.token,
    });
  } catch (error) {
    if (error instanceof AuthFailure) {
      console.error(error.message);
      return 3;
    }
    throw error;
  }

  try {
    const run = scenarios[args.scenario];
    await run(session.client, {
      tool: args.tool,
      query: args.query,
      argumentsJson: args.argumentsJson,
      user: env.user,
    });
    return 0;
  } catch (error) {
    if (error instanceof SetupFailure) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof AssertionFailure) {
      console.error(error.message);
      return 1;
    }
    console.error(error);
    return 1;
  } finally {
    await session.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
