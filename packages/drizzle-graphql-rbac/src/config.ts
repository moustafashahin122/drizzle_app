/**
 * @module drizzle-graphql-rbac/config
 *
 * Server config-file loader, CLI flag parser, secrets resolver, and boot
 * helper. The framework follows a strict three-stage precedence chain:
 *
 *     CLI args  >  user config file (knobs) and .env (secrets)  >  framework defaults
 *
 *   - **Knobs** (port, host, GraphQL gates, etc.) come from
 *     {@link frameworkDefaultConfig}, may be overridden by the user's
 *     config file, and may be overridden again by CLI flags.
 *   - **Secrets** (admin email/password) come from `.env` (or the shell
 *     environment) and may be overridden by CLI flags. They are NEVER read
 *     from the user config file — keep them out of source control.
 *   - The user config file MUST provide `db`, `schema`, and `rbac`. Everything
 *     else has a default.
 *
 * Typical layout:
 *
 *     // .env  (gitignored — secrets only)
 *     ADMIN_EMAIL=admin@example.com
 *     ADMIN_PASSWORD=change-me
 *
 *     // server.config.ts  (knobs only — no secrets)
 *     import { defineServerConfig } from "drizzle-graphql-rbac";
 *     import { sudoDb } from "./src/sudoDb.js";
 *     import * as schema from "./src/schema.js";
 *     import { roles, accessRights, recordRules } from "./src/rbac/index.js";
 *     export default defineServerConfig({
 *       db: sudoDb,
 *       schema,
 *       rbac: { roles, accessRights, recordRules },
 *     });
 *
 *     // server.ts
 *     import { runServer } from "drizzle-graphql-rbac";
 *     await runServer();
 *
 *     // boot
 *     node --env-file=.env --import tsx server.ts --config ./server.config.ts
 *     # any knob or secret can be overridden via CLI:
 *     node --env-file=.env --import tsx server.ts \
 *       --config ./server.config.ts --port 8080 --admin-password override
 */
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createApp, type CreateAppOptions, type CreatedApp } from "./app.js";
import { logger } from "./logger.js";
import { frameworkDefaultConfig } from "./defaultConfig.js";

/** Secrets the framework resolves from `.env` or CLI flags. */
export interface Secrets {
  /** Source: `--admin-email` flag, then `ADMIN_EMAIL` env var. */
  adminEmail?: string;
  /** Source: `--admin-password` flag, then `ADMIN_PASSWORD` env var. */
  adminPassword?: string;
}

/**
 * Full server configuration: everything {@link createApp} accepts plus the
 * boot-time transport settings consumed by {@link runServer}.
 */
export interface ServerConfig extends CreateAppOptions {
  /** TCP port to bind. @default 3000 */
  port?: number;
  /** Network interface to bind. @default `"0.0.0.0"` (all interfaces) */
  host?: string;
  /**
   * When `true` (the default) and both `ADMIN_EMAIL` and `ADMIN_PASSWORD`
   * are resolved (from `.env` or CLI), `runServer` upserts that user on
   * startup and assigns them the `admin` role. Set to `false` to manage
   * admin accounts entirely through the REST API or seed scripts.
   *
   * @default true
   */
  bootstrapAdmin?: boolean;
}

/**
 * Identity helper — gives full TypeScript inference over the config object
 * the user default-exports from `server.config.ts`.
 */
export function defineServerConfig(cfg: ServerConfig): ServerConfig {
  return cfg;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliKnobs {
  port?: number;
  host?: string;
  publicDir?: string;
  graphqlEndpoint?: string;
  graphqlMaxDepth?: number;
  graphqlAllowIntrospection?: boolean;
  graphqlRequireAuth?: boolean;
  maxListLimit?: number;
  bootstrapAdmin?: boolean;
}

interface CliSecrets {
  adminEmail?: string;
  adminPassword?: string;
}

export interface ParsedCli {
  knobs: CliKnobs;
  secrets: CliSecrets;
  configPath?: string;
}

type FlagSpec =
  | { type: "string"; bucket: "knobs"; key: keyof CliKnobs }
  | { type: "number"; bucket: "knobs"; key: keyof CliKnobs }
  | { type: "bool"; bucket: "knobs"; key: keyof CliKnobs }
  | { type: "string"; bucket: "secrets"; key: keyof CliSecrets }
  | { type: "string"; bucket: "config" };

const FLAG_SPECS: Record<string, FlagSpec> = {
  "--port":                        { type: "number", bucket: "knobs",   key: "port" },
  "--host":                        { type: "string", bucket: "knobs",   key: "host" },
  "--public-dir":                  { type: "string", bucket: "knobs",   key: "publicDir" },
  "--graphql-endpoint":            { type: "string", bucket: "knobs",   key: "graphqlEndpoint" },
  "--graphql-max-depth":           { type: "number", bucket: "knobs",   key: "graphqlMaxDepth" },
  "--graphql-allow-introspection": { type: "bool",   bucket: "knobs",   key: "graphqlAllowIntrospection" },
  "--graphql-require-auth":        { type: "bool",   bucket: "knobs",   key: "graphqlRequireAuth" },
  "--max-list-limit":              { type: "number", bucket: "knobs",   key: "maxListLimit" },
  "--bootstrap-admin":             { type: "bool",   bucket: "knobs",   key: "bootstrapAdmin" },
  "--admin-email":                 { type: "string", bucket: "secrets", key: "adminEmail" },
  "--admin-password":              { type: "string", bucket: "secrets", key: "adminPassword" },
  "--config":                      { type: "string", bucket: "config" },
};

function coerceBool(raw: string | null): boolean {
  if (raw == null) return true;
  return raw !== "false" && raw !== "0";
}

/**
 * Parse known CLI flags from an argv slice. Supports `--flag value`,
 * `--flag=value`, and `--no-flag` (for booleans). Unknown flags are
 * silently ignored so callers can layer their own CLI on top.
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): ParsedCli {
  const out: ParsedCli = { knobs: {}, secrets: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Negated boolean: --no-foo
    if (arg.startsWith("--no-")) {
      const positive = "--" + arg.slice(5);
      const spec = FLAG_SPECS[positive];
      if (spec?.type === "bool" && spec.bucket === "knobs") {
        out.knobs[spec.key] = false as never;
      }
      continue;
    }

    const eqIdx = arg.indexOf("=");
    const flag = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
    const inline = eqIdx > 0 ? arg.slice(eqIdx + 1) : null;
    const spec = FLAG_SPECS[flag];
    if (!spec) continue;

    if (spec.type === "bool") {
      out.knobs[spec.key] = coerceBool(inline) as never;
      continue;
    }

    const raw = inline ?? argv[++i];
    if (raw === undefined) continue;

    if (spec.bucket === "config") {
      out.configPath = raw;
    } else if (spec.bucket === "secrets") {
      out.secrets[spec.key] = raw;
    } else if (spec.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(`CLI flag ${flag} expected a number; got ${JSON.stringify(raw)}`);
      }
      out.knobs[spec.key] = n as never;
    } else {
      out.knobs[spec.key] = raw as never;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

/**
 * Resolve a config-file path. Precedence: explicit arg → `--config` CLI flag
 * → `CONFIG_PATH` env. Returns `undefined` when none is set (user config is
 * optional — the framework defaults still apply, but `db`/`schema`/`rbac`
 * must come from somewhere).
 */
export function resolveConfigPath(explicit?: string): string | undefined {
  const fromCli = parseCliArgs().configPath;
  const raw = explicit ?? fromCli ?? process.env.CONFIG_PATH;
  return raw ? resolvePath(process.cwd(), raw) : undefined;
}

/**
 * Load and return the user's server config from disk. The file must
 * default-export (or named-export `config`) a {@link ServerConfig} object,
 * typically built with {@link defineServerConfig}. Returns `undefined` if
 * no config path is given.
 */
export async function loadServerConfig(path?: string): Promise<ServerConfig | undefined> {
  const abs = resolveConfigPath(path);
  if (!abs) return undefined;
  const mod = (await import(pathToFileURL(abs).href)) as {
    default?: ServerConfig;
    config?: ServerConfig;
  };
  const cfg = mod.default ?? mod.config;
  if (!cfg || typeof cfg !== "object") {
    throw new Error(
      `Server config at ${abs} must default-export (or named-export 'config') an object.`,
    );
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Secrets resolution
// ---------------------------------------------------------------------------

/**
 * Resolve secrets from CLI flags (highest precedence) falling back to env
 * vars (`.env` is loaded by Node's `--env-file` flag, not by this function).
 */
export function loadSecrets(cliOverrides?: CliSecrets): Secrets {
  return {
    adminEmail: cliOverrides?.adminEmail ?? process.env.ADMIN_EMAIL,
    adminPassword: cliOverrides?.adminPassword ?? process.env.ADMIN_PASSWORD,
  };
}

// ---------------------------------------------------------------------------
// Admin bootstrap
// ---------------------------------------------------------------------------

async function bootstrapAdminUser(
  handle: CreatedApp,
  schema: Record<string, unknown>,
  email: string,
  password: string,
): Promise<void> {
  const log = logger.child({ component: "framework.bootstrap" });
  const usersTable = (schema as { users?: unknown }).users as
    | {
        id: unknown;
        email: unknown;
      }
    | undefined;
  if (!usersTable) {
    log.warn("schema has no `users` export; skipping admin bootstrap");
    return;
  }

  const { sudoDb, rbac } = handle;
  const passwordHash = await bcrypt.hash(password, 12);

  const [existing] = await (sudoDb as unknown as {
    select: () => {
      from: (t: unknown) => {
        where: (cond: unknown) => { limit: (n: number) => Promise<{ id: number }[]> };
      };
    };
  })
    .select()
    .from(usersTable)
    .where(eq(usersTable.email as never, email))
    .limit(1);

  let userId: number;
  if (existing) {
    await (sudoDb as unknown as {
      update: (t: unknown) => {
        set: (v: unknown) => { where: (cond: unknown) => Promise<unknown> };
      };
    })
      .update(usersTable)
      .set({ passwordHash, active: true })
      .where(eq(usersTable.id as never, existing.id));
    userId = existing.id;
    log.info({ email, userId }, "admin user updated");
  } else {
    const [row] = await (sudoDb as unknown as {
      insert: (t: unknown) => {
        values: (v: unknown) => { returning: () => Promise<{ id: number }[]> };
      };
    })
      .insert(usersTable)
      .values({ name: "Admin", email, passwordHash, active: true })
      .returning();
    userId = row.id;
    log.info({ email, userId }, "admin user created");
  }

  rbac.assignRole(userId, "admin");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface ResolvedServerConfig extends ServerConfig {
  port: number;
  host: string;
}

export interface RunServerHandle extends CreatedApp {
  /** Resolved port the server is listening on. */
  port: number;
  /** Resolved host the server is bound to. */
  host: string;
  /** The merged, fully-resolved config (defaults <- user config <- CLI). */
  config: ResolvedServerConfig;
  /** Resolved secrets (env <- CLI). Fields are `undefined` when not provided. */
  secrets: Secrets;
}

export interface RunServerOptions {
  /** Override the config-file path (skips CLI flag + `CONFIG_PATH` lookup). */
  configPath?: string;
  /** Skip admin auto-bootstrap even when both admin secrets resolve. */
  skipAdminBootstrap?: boolean;
}

/**
 * One-call boot: parse CLI flags, load the user config file (if any), merge
 * with framework defaults, resolve secrets, build the app via `createApp`,
 * auto-bootstrap the admin user when both admin secrets are set, and start
 * a Node HTTP listener via `@hono/node-server`.
 *
 * Returns the standard `createApp` handle plus the resolved `port` / `host`,
 * the merged `config`, and the resolved `secrets`.
 *
 * For non-Node hosts (Workers, Bun, Deno, edge), call {@link loadServerConfig}
 * + {@link parseCliArgs} + {@link createApp} directly and hand `app.fetch`
 * to the runtime's listener.
 */
export async function runServer(opts: RunServerOptions = {}): Promise<RunServerHandle> {
  const cli = parseCliArgs();
  const userConfig = await loadServerConfig(opts.configPath);

  // db / schema / rbac are app-specific and have no defaults.
  if (!userConfig?.db || !userConfig?.schema || !userConfig?.rbac) {
    throw new Error(
      "Server config must export `db`, `schema`, and `rbac`. " +
        "Pass --config <path>, set CONFIG_PATH, or call runServer({ configPath }).",
    );
  }

  // Precedence: framework defaults < user config < CLI knobs.
  const merged = {
    ...frameworkDefaultConfig,
    ...userConfig,
    ...cli.knobs,
  } as ResolvedServerConfig;

  const port = merged.port ?? 3000;
  const host = merged.host ?? "0.0.0.0";
  merged.port = port;
  merged.host = host;

  // Precedence: env < CLI.
  const secrets = loadSecrets(cli.secrets);
  const hasEmail = !!secrets.adminEmail;
  const hasPwd = !!secrets.adminPassword;
  if (hasEmail !== hasPwd) {
    throw new Error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must be set together " +
        "(via .env or --admin-email/--admin-password).",
    );
  }

  // Build the app. Strip server-only fields before passing to createApp.
  const { port: _p, host: _h, bootstrapAdmin: _b, ...appOpts } = merged;
  const handle = createApp(appOpts);

  // Auto-bootstrap the admin user when both secrets resolved.
  const bootstrap = merged.bootstrapAdmin !== false && !opts.skipAdminBootstrap;
  if (bootstrap && hasEmail && hasPwd) {
    await bootstrapAdminUser(
      handle,
      userConfig.schema,
      secrets.adminEmail!,
      secrets.adminPassword!,
    );
  }

  // Start listener.
  const log = logger.child({ component: "framework.server" });
  serve({ fetch: handle.app.fetch, port, hostname: host }, (info) => {
    log.info({ port: info.port, host }, "server listening");
  });

  return { ...handle, port, host, config: merged, secrets };
}
