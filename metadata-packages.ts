/**
 * Plugin-private metadata data-package management.
 *
 * Owns the immutable data generations under
 * `<agentDir>/cache/openai-api-pi-extension/metadata/`, the active-pointer
 * record, the cross-process update lock, package-manager selection
 * (npm/Bun/pnpm), registry `latest` queries, isolated installs, one-shot
 * Worker validation and atomic activation.
 *
 * Layout (all under the private root, dirs 0700 / files 0600):
 *
 *   metadata/
 *     active.json            pointer: {format, generation, versions}
 *     update.lock            {pid, token} — O_EXCL, conservative stale reclaim
 *     recovery.lock          serializes stale reclaim across processes
 *     manager-cache/         per-manager cache/log/tmp/store roots
 *     generations/<id>/
 *       package.json         exact pinned deps written by us
 *       <lockfile>           manager-produced
 *       node_modules/
 *
 * Everything here is private state — no user-supplied paths, package names
 * or shell fragments. The two managed packages are a fixed allowlist.
 * Host-specific inputs (npmCommand setting, Bun runtime evidence, child
 * process runner) are injected so this module imports no Pi internals.
 */
import { spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync, closeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import semver from "semver";

const require = createRequire(import.meta.url);
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixed allowlist & paths
// ---------------------------------------------------------------------------

export const MODELS_DEV_PACKAGE = "@opencode-ai/models";
export const MODELPARAMS_PACKAGE = "modelparams";
/** Stable order: both packages always install/activate as one unit. */
export const MANAGED_PACKAGES = [MODELS_DEV_PACKAGE, MODELPARAMS_PACKAGE] as const;
export type ManagedPackage = (typeof MANAGED_PACKAGES)[number];

const PRIVATE_DIR = join("cache", "openai-api-pi-extension", "metadata");
const ACTIVE_RECORD = "active.json";
const UPDATE_LOCK = "update.lock";
const RECOVERY_LOCK = "recovery.lock";
const GENERATIONS_DIR = "generations";
const MANAGER_CACHE = "manager-cache";
const ACTIVE_FORMAT = 1;

/** Entry files the compile worker loads inside each package (existing seam). */
const PACKAGE_ENTRY: Record<ManagedPackage, string> = {
  [MODELS_DEV_PACKAGE]: join("dist", "snapshot.js"),
  [MODELPARAMS_PACKAGE]: join("dist", "index.js"),
};

/** Absolute private root for a given agent dir. */
export function metadataRoot(agentDir: string): string {
  return join(agentDir, PRIVATE_DIR);
}

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Result of one child process invocation. Output is bounded by the runner. */
export type RunResult = {
  code: number | null;
  /** Termination signal when the process was killed (timeout/abort). */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** Injectable async child-process runner. Never a shell. */
export type ProcessRunner = (req: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<RunResult>;

/** Error thrown when the process exits non-zero or times out. */
export class ProcessRunError extends Error {
  readonly result: RunResult;
  constructor(args: string[], result: RunResult, detail?: string) {
    super(detail ?? `command failed: ${basename(args[0] ?? "")} ${args.slice(1).join(" ")} (exit ${result.code ?? result.signal})`);
    this.name = "ProcessRunError";
    this.result = result;
  }
}

const MAX_OUTPUT = 64 * 1024;
/** Grace window before SIGTERM escalates to SIGKILL on the process group. */
const KILL_GRACE_MS = 3000;
/** Extra time budgeted to let killed children be reaped before resolving. */
const KILL_REAP_MS = 5000;

/**
 * Default runner: `spawn` with an args array, no shell, bounded captured
 * output, timeout kill, abort kill.
 *
 * POSIX: spawned into its own process group (`detached`) so timeout/abort
 * kills the wrapper AND its descendants (a wrapper that exits can leave a
 * package manager running). Kill signals go to the whole group; the call
 * only resolves on `close`, so no descendant still holding our pipes keeps
 * the update lock alive. Other platforms fall back to killing the direct
 * child only — a documented narrower guarantee.
 *
 * A request arriving with an already-aborted signal is rejected before
 * spawn — never launches a doomed child.
 */
export const execFileRunner: ProcessRunner = (req) => {
  if (req.signal?.aborted) return Promise.reject(req.signal.reason);
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
      detached,
    });
    let stdout = "";
    let stderr = "";
    const append = (chunk: Buffer, into: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      if (into === "stdout") stdout = (stdout + text).slice(-MAX_OUTPUT);
      else stderr = (stderr + text).slice(-MAX_OUTPUT);
    };
    child.stdout?.on("data", (c: Buffer) => append(c, "stdout"));
    child.stderr?.on("data", (c: Buffer) => append(c, "stderr"));
    let settled = false;
    let killing = false;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    let reapDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalate);
      clearTimeout(reapDeadline);
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const signalAll = (sig: NodeJS.Signals) => {
      if (detached) {
        try { process.kill(-child.pid!, sig); return; } catch { /* fall through */ }
      }
      try { child.kill(sig); } catch { /* already gone */ }
    };
    const kill = () => {
      if (killing || settled) return;
      killing = true;
      signalAll("SIGTERM");
      // Grace/reap clocks start on cancellation, never on normal startup.
      escalate = setTimeout(() => signalAll("SIGKILL"), KILL_GRACE_MS);
      escalate.unref();
      reapDeadline = setTimeout(() => {
        signalAll("SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(() => resolvePromise({ code: null, signal: "SIGKILL", stdout, stderr }));
      }, KILL_GRACE_MS + KILL_REAP_MS);
      reapDeadline.unref();
    };
    const timer = setTimeout(kill, req.timeoutMs);
    timer.unref();
    const onAbort = () => kill();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    if (req.signal?.aborted) onAbort();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => {
      // The wrapper may exit while a descendant ignores SIGTERM and closes
      // its pipes. Kill the entire group before releasing the update lock.
      if (killing) signalAll("SIGKILL");
      finish(() => resolvePromise({ code: killing ? null : code, signal: signal ?? (killing ? "SIGTERM" : null), stdout, stderr }));
    });
  });
};

/** Host runtime evidence — the caller gathers public facts, we decide. */
export type HostRuntime = {
  /** `process.versions.bun` presence (Bun runtime: binary OR `bun run`). */
  bunRuntime: boolean;
  /**
   * Confirmed Bun-compiled single binary: the host's own module URLs live in
   * Bun's virtual filesystem (`$bunfs`/`~BUN`). Caller verifies the public
   * host package directory and xz-dev manifest, never the disk extension URL.
   */
  bunBinary: boolean;
  /** `process.execPath` — used as the embedded Bun binary when bunBinary. */
  execPath: string;
};

export type MetadataPackagesDeps = {
  agentDir: string;
  /** Extension install dir (fallback package resolution walks up from it). */
  extensionDir?: string;
  /** Host `npmCommand` setting (argv prefix), already read by the caller. */
  npmCommand?: string[];
  hostRuntime: HostRuntime;
  runner?: ProcessRunner;
  /** Pi offline mode: no registry queries or installs may start. */
  offline?: boolean;
  /** Overridable for tests — defaults read real package.json files. */
  readPackageVersion?: (packageDir: string) => string | undefined;
  /** Overridable worker spawn (tests may inject a fake). */
  spawnWorker?: ValidationWorker;
  /** Time budget for registry queries (default 10s) and installs (5min). */
  queryTimeoutMs?: number;
  installTimeoutMs?: number;
  /** Date.now() seam for lock/generation ids. */
  now?: () => number;
};

type Resolved = Required<Pick<MetadataPackagesDeps,
  "runner" | "readPackageVersion" | "queryTimeoutMs" | "installTimeoutMs" | "now">>
  & MetadataPackagesDeps;

function resolveDeps(deps: MetadataPackagesDeps): Resolved {
  return {
    queryTimeoutMs: 10_000,
    installTimeoutMs: 5 * 60_000,
    now: () => Date.now(),
    runner: execFileRunner,
    readPackageVersion: readVersionFromDisk,
    extensionDir: EXTENSION_DIR,
    ...deps,
  };
}

/** Version straight from disk — never the CJS require cache. */
export function readVersionFromDisk(packageDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Manifest name + version straight from disk. */
function readManifest(packageDir: string): { name?: string; version?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as { name?: string; version?: string } : undefined;
  } catch {
    return undefined;
  }
}

function packageDirName(name: ManagedPackage): string {
  // Scoped packages keep their scope segment in node_modules.
  return join(...name.split("/"));
}

// ---------------------------------------------------------------------------
// Containment (finding 1): canonical root anchors everything
// ---------------------------------------------------------------------------

/**
 * Canonical private root. The root itself must resolve through realpaths —
 * if `metadata/` or any ancestor inside agentDir is a symlink, the target
 * becomes the canonical root so every descendant check stays consistent.
 * Returns undefined when the root does not exist yet.
 */
function canonicalRoot(root: string): string | undefined {
  try {
    return realpathSync(root);
  } catch {
    return undefined;
  }
}

/**
 * `child` must resolve (realpath) inside `realRoot`. Used for every existing
 * ancestor AND leaf: generations dir, generation dir, node_modules, package
 * dirs, manifests, dist entries, pointer/temp files. A symlink anywhere in
 * the chain that escapes the canonical root fails closed.
 */
function containedInRoot(realRoot: string, child: string): boolean {
  try {
    const real = realpathSync(child);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Active record & data selection
// ---------------------------------------------------------------------------

export type ActiveRecord = {
  format: number;
  /** Internal generation id — a directory name, never a path. */
  generation: string;
  versions: { modelsDev: string; modelparams: string };
};

export type PackageSource = {
  dir: string;
  version?: string;
};

export type DataSelection = {
  source: "active" | "bundled";
  /** Present only when that package resolved (missing bundled → undefined). */
  modelsDev?: PackageSource;
  modelparams?: PackageSource;
  generation?: string;
  /** Short human reason an active record was rejected (caller warns). */
  warning?: string;
};

function generationDir(root: string, generation: string): string {
  return join(root, GENERATIONS_DIR, generation);
}

function packageDirInGeneration(root: string, generation: string, name: ManagedPackage): string {
  return join(generationDir(root, generation), "node_modules", packageDirName(name));
}

/**
 * Validates one active generation: the generations parent, the generation
 * dir, each package dir, its manifest AND its data entry file must exist
 * and stay contained in the canonical root; manifests must match the
 * managed identity and the record's versions. Anything less fails closed —
 * whole-group fallback, never a partial or escaped load.
 */
function activeRecordPaths(realRoot: string, record: ActiveRecord):
  | { modelsDev: string; modelparams: string; versions: { m: string; p: string } }
  | { error: string } {
  // Generation id must be a plain directory name — no traversal, ever.
  if (!/^[A-Za-z0-9._-]+$/.test(record.generation) || record.generation.includes("..")) {
    return { error: "active record generation id invalid" };
  }
  const generations = join(realRoot, GENERATIONS_DIR);
  if (!existsSync(generations)) return { error: "generations directory missing" };
  if (!containedInRoot(realRoot, generations)) {
    return { error: "generations directory escapes private root" };
  }
  const genDir = generationDir(realRoot, record.generation);
  if (!existsSync(genDir)) return { error: "active generation directory missing" };
  if (!containedInRoot(realRoot, genDir)) {
    return { error: "active generation escapes private root" };
  }
  const out = { modelsDev: "", modelparams: "" };
  const versions = { m: "", p: "" };
  for (const name of MANAGED_PACKAGES) {
    const dir = packageDirInGeneration(realRoot, record.generation, name);
    if (!existsSync(join(dir, "package.json"))) {
      return { error: `active generation missing ${name}` };
    }
    if (!containedInRoot(realRoot, dir)) {
      return { error: `active ${name} path escapes generation` };
    }
    // Manifest AND data module must be real, contained files — a package
    // whose dist is missing or symlinked out is not usable data.
    const manifestPath = join(dir, "package.json");
    const entryPath = join(dir, PACKAGE_ENTRY[name]);
    if (!containedInRoot(realRoot, manifestPath) || !existsSync(entryPath)
      || !containedInRoot(realRoot, entryPath)) {
      return { error: `active ${name} data incomplete or escapes root` };
    }
    const manifest = readManifest(dir);
    const expected = name === MODELS_DEV_PACKAGE
      ? record.versions.modelsDev
      : record.versions.modelparams;
    if (manifest?.name !== name || manifest.version !== expected) {
      return { error: `active ${name} manifest does not match record` };
    }
    if (name === MODELS_DEV_PACKAGE) {
      out.modelsDev = dir;
      versions.m = manifest.version;
    } else {
      out.modelparams = dir;
      versions.p = manifest.version;
    }
  }
  return { ...out, versions };
}

function parseActiveRecord(raw: string): ActiveRecord | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "active record is not valid JSON" };
  }
  const r = parsed as Partial<ActiveRecord> | null;
  if (!r || r.format !== ACTIVE_FORMAT || typeof r.generation !== "string"
    || typeof r.versions?.modelsDev !== "string" || typeof r.versions?.modelparams !== "string") {
    return { error: "active record shape invalid" };
  }
  return r as ActiveRecord;
}

/** Bundled-dependency fallback: existing walk-up resolution semantics. */
function bundledPackageDir(name: string, extensionDir: string): string | undefined {
  for (let dir = resolve(extensionDir); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    try {
      require.resolve(join(candidate, "package.json"));
      return candidate;
    } catch {
      if (dirname(dir) === dir) return undefined;
    }
  }
}

/**
 * Picks the effective data source once: valid active generation wins,
 * otherwise the extension's installed dependencies. A corrupt/escaped/
 * incomplete active record never loads outside content — it falls back as
 * a unit with a short warning reason.
 */
export function selectDataSource(
  deps: MetadataPackagesDeps | Pick<MetadataPackagesDeps, "agentDir" | "extensionDir" | "readPackageVersion">,
): DataSelection {
  const d = { extensionDir: EXTENSION_DIR, readPackageVersion: readVersionFromDisk, ...deps };
  const bundled = (): DataSelection => {
    const sel: DataSelection = { source: "bundled" };
    const m = bundledPackageDir(MODELS_DEV_PACKAGE, d.extensionDir!);
    const p = bundledPackageDir(MODELPARAMS_PACKAGE, d.extensionDir!);
    if (m) sel.modelsDev = { dir: m, version: d.readPackageVersion(m) };
    if (p) sel.modelparams = { dir: p, version: d.readPackageVersion(p) };
    return sel;
  };
  const root = metadataRoot(d.agentDir);
  const realRoot = canonicalRoot(root);
  if (!realRoot) return bundled();
  const activeFile = join(realRoot, ACTIVE_RECORD);
  // The pointer itself must be a contained real file before we read it.
  if (!existsSync(activeFile)) return bundled();
  if (!containedInRoot(realRoot, activeFile)) {
    return { ...bundled(), warning: "active record escapes private root" };
  }
  let raw: string;
  try {
    raw = readFileSync(activeFile, "utf8");
  } catch {
    return { ...bundled(), warning: "active record unreadable" };
  }
  const record = parseActiveRecord(raw);
  if ("error" in record) return { ...bundled(), warning: record.error };
  const paths = activeRecordPaths(realRoot, record);
  if ("error" in paths) return { ...bundled(), warning: paths.error };
  // Versions were just verified against the on-disk manifests — report the
  // actual disk values, never a pointer substitution.
  return {
    source: "active",
    generation: record.generation,
    modelsDev: { dir: paths.modelsDev, version: paths.versions.m },
    modelparams: { dir: paths.modelparams, version: paths.versions.p },
  };
}

// ---------------------------------------------------------------------------
// Package-manager selection
// ---------------------------------------------------------------------------

export type ManagerKind = "npm" | "bun" | "pnpm";

export type SelectedManager = {
  kind: ManagerKind;
  /** Executable path/name — never invoked through a shell. */
  command: string;
  /** Fixed argv prefix (e.g. `["--bun"]` wrappers, `["run","npm"]`). */
  prefixArgs: string[];
  /** Extra env for the child (only embedded-Bun uses it: BUN_BE_BUN=1). */
  env: Record<string, string>;
  /** Why this manager was chosen — surfaced in diagnostics/tests. */
  reason: "configured" | "embedded-bun" | "default-npm";
};

export class ManagerSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagerSelectionError";
  }
}

/** basename without extension — the host's own manager-name semantics. */
function managerNameOf(command: string): string {
  return basename(command).replace(/\.(cmd|exe)$/i, "");
}

/**
 * Resolves the configured `npmCommand` argv prefix to a supported manager.
 * The manager is the final command token (after any `--` separator), the
 * same rule the host package manager applies. Unknown/ambiguous prefixes
 * are rejected — never silently guessed.
 */
export function managerFromNpmCommand(npmCommand: string[]): SelectedManager {
  if (npmCommand.length === 0 || !npmCommand[0]?.trim()) {
    throw new ManagerSelectionError("npmCommand is configured but empty");
  }
  const parts = npmCommand;
  const first = managerNameOf(parts[0]);
  const sepIndex = parts.lastIndexOf("--");
  let managerIndex = 0;
  if (!MANAGER_NAMES.has(first)) {
    // Resolve known wrappers from their executable position, never from a
    // delimiter inside an inner subcommand (env npm exec ... -- pnpm).
    if (WRAPPER_COMMANDS.has(first)) managerIndex = parts[1] === "--" ? 2 : 1;
    else if (first === "corepack") {
      if (parts[1] !== "--") throw new ManagerSelectionError("ambiguous corepack npmCommand: use corepack -- manager");
      managerIndex = 2;
    } else if (sepIndex >= 0) managerIndex = sepIndex + 1;
    else if (parts.length > 1) {
      throw new ManagerSelectionError("ambiguous npmCommand: use a `[wrapper -- manager]` form");
    }
  }
  const managerToken = parts[managerIndex];
  if (!managerToken) {
    throw new ManagerSelectionError("npmCommand has no command after `--`");
  }
  const kind = managerNameOf(managerToken);
  if (kind !== "npm" && kind !== "bun" && kind !== "pnpm") {
    throw new ManagerSelectionError(
      `unsupported package manager "${kind}" in npmCommand; configure npm, bun or pnpm`,
    );
  }
  validateManagerPrefix(kind, parts.slice(managerIndex + 1));
  // Keep supported wrapper/option prefixes verbatim; action words can never
  // precede our own view/info/install subcommand.
  return {
    kind,
    command: parts[0],
    prefixArgs: parts.slice(1),
    env: {},
    reason: "configured",
  };
}

/** Permitted non-manager leading commands in a configured npmCommand. */
const WRAPPER_COMMANDS = new Set(["env", "env.exe"]);

const MANAGER_NAMES = new Set(["npm", "bun", "pnpm"]);

function validateManagerPrefix(kind: ManagerKind, args: string[]): void {
  const values = new Set(kind === "bun"
    ? ["--registry", "--config"]
    : ["--registry", "--userconfig", "--globalconfig", "--loglevel", "--proxy", "--https-proxy", "--cafile", "--color",
      ...(kind === "pnpm" ? ["--config.registry", "--config.userconfig"] : [])]);
  const flags = new Set(["--bun", "--silent", "--quiet", "--verbose", "--no-progress", "--no-color"]);
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    const equal = argument.indexOf("=");
    const option = equal < 0 ? argument : argument.slice(0, equal);
    if (values.has(option)) {
      const value = equal < 0 ? args[++i] : argument.slice(equal + 1);
      if (!value || value.startsWith("-")) throw new ManagerSelectionError("ambiguous npmCommand option value");
    } else if (equal >= 0 || !flags.has(option)) {
      throw new ManagerSelectionError(`ambiguous or unsupported ${kind} npmCommand prefix; use options, not subcommands`);
    }
  }
}

/**
 * Chooses the package manager without consulting any private host API:
 *   1. configured npmCommand (validated above);
 *   2. confirmed Bun-compiled release → its own binary with BUN_BE_BUN=1;
 *   3. anything else → plain npm (never PATH-guessing, never `bun run`
 *      source installs promoted to standalone).
 */
export function selectPackageManager(deps: MetadataPackagesDeps): SelectedManager {
  const d = resolveDeps(deps);
  if (d.npmCommand && d.npmCommand.length > 0) {
    return managerFromNpmCommand(d.npmCommand);
  }
  if (d.hostRuntime.bunBinary && d.hostRuntime.bunRuntime && d.hostRuntime.execPath) {
    return {
      kind: "bun",
      command: d.hostRuntime.execPath,
      prefixArgs: [],
      env: { BUN_BE_BUN: "1" },
      reason: "embedded-bun",
    };
  }
  return { kind: "npm", command: "npm", prefixArgs: [], env: {}, reason: "default-npm" };
}

/** Private per-manager env: caches, logs, tmp AND store stay in our root. */
function managerEnv(realRoot: string, manager: SelectedManager): Record<string, string> {
  const cacheRoot = join(realRoot, MANAGER_CACHE);
  const cache = join(cacheRoot, manager.kind);
  const tmp = join(cache, "tmp");
  for (const dir of [cacheRoot, cache, tmp]) {
    // A symlinked cache ancestor is a write escape — fail before mkdir
    // can follow it (finding 1: ancestors count, not only leaves).
    if (existsSync(dir) && !containedInRoot(realRoot, dir)) {
      throw new Error(`manager cache path escapes the private root`);
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return {
    ...process.env,
    ...manager.env,
    TMPDIR: tmp,
    npm_config_cache: join(cache, "npm"),
    npm_config_tmp: tmp,
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"),
    // PNPM_HOME is a bin dir, not the store — set the store explicitly or
    // pnpm writes its virtual store under ~/.local/share/pnpm.
    PNPM_HOME: join(cache, "pnpm-home"),
    npm_config_store_dir: join(cache, "pnpm-store"),
    XDG_CACHE_HOME: join(cache, "xdg"),
    PNPM_STORE_DIR: join(cache, "pnpm-store"),
  };
}

/** Read-only capability probe — `<cmd> <prefix> --version`. */
async function probeManager(
  d: Resolved,
  manager: SelectedManager,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await d.runner({
    command: manager.command,
    args: [...manager.prefixArgs, "--version"],
    cwd,
    env,
    timeoutMs,
    signal,
  });
  signal?.throwIfAborted();
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new ManagerSelectionError(
      `package manager "${manager.kind}" is not usable (exit ${result.code ?? result.signal}); ` +
      `configure Pi's npmCommand or install ${manager.kind}`,
    );
  }
  return result.stdout.trim().split("\n")[0];
}

// ---------------------------------------------------------------------------
// Registry queries
// ---------------------------------------------------------------------------

export type PackageCheckState =
  | { status: "up-to-date" | "update-available"; localVersion?: string; latest: string }
  | { status: "missing"; latest: string }
  | { status: "local-version-unknown"; latest: string }
  | { status: "query-failed"; localVersion?: string; reason: string };

export type CheckResult = {
  manager: { kind: ManagerKind; reason: string };
  packages: Record<ManagedPackage, PackageCheckState>;
  /** True when at least one package has a strictly newer stable latest. */
  updateAvailable: boolean;
};

/** One registry query per manager kind — read-only, bounded output. */
function queryArgs(manager: SelectedManager, name: ManagedPackage): string[] {
  if (manager.kind === "bun") return ["info", name, "dist-tags.latest"];
  return ["view", name, "dist-tags.latest", "--json"];
}

function parseLatest(manager: SelectedManager, name: ManagedPackage, stdout: string): string {
  let raw = stdout.trim();
  if (manager.kind !== "bun") {
    // npm/pnpm --json emits a JSON string (or object); accept both.
    try {
      const parsed = JSON.parse(raw);
      raw = typeof parsed === "string" ? parsed
        : typeof parsed?.latest === "string" ? parsed.latest
        : "";
    } catch {
      raw = "";
    }
  }
  if (!semver.valid(raw) || semver.prerelease(raw)) {
    throw new Error(`registry returned no usable stable version for ${name}`);
  }
  return raw;
}

async function queryLatest(
  d: Resolved,
  manager: SelectedManager,
  name: ManagedPackage,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const result = await d.runner({
    command: manager.command,
    args: [...manager.prefixArgs, ...queryArgs(manager, name)],
    cwd,
    env,
    timeoutMs,
    signal,
  });
  signal?.throwIfAborted(); // abort beats a killed-process error report
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 300);
    throw new ProcessRunError(
      [manager.command, ...queryArgs(manager, name)], result,
      `${name} registry query failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return parseLatest(manager, name, result.stdout);
}

/** Package presence + version validity, kept distinct (finding 8). */
function classify(
  source: PackageSource | undefined,
  latest: string,
): PackageCheckState {
  if (!source) return { status: "missing", latest };
  const localVersion = source.version;
  if (!localVersion || !semver.valid(localVersion)) {
    return { status: "local-version-unknown", latest };
  }
  return semver.gt(latest, localVersion)
    ? { status: "update-available", localVersion, latest }
    : { status: "up-to-date", localVersion, latest };
}

/**
 * `/provider-metadata check`: per-package status against registry `latest`.
 * No installs, no activation, no gateway access. Failure per package is
 * reported, never converted to "up-to-date".
 */
export async function checkMetadataPackages(
  deps: MetadataPackagesDeps,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const d = resolveDeps(deps);
  if (d.offline) throw new Error("offline: registry check skipped");
  signal?.throwIfAborted();
  const selection = selectDataSource(d);
  const manager = selectPackageManager(d);
  const root = metadataRoot(d.agentDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Canonicalize before any further write: caches and queries must run
  // inside the REAL private root, never through a symlinked ancestor.
  const realRoot = canonicalRoot(root)!;
  chmodSync(realRoot, 0o700);
  const env = managerEnv(realRoot, manager);
  // 10s total budget across probe + both queries — not per call.
  const deadline = d.now() + d.queryTimeoutMs;
  const remaining = () => Math.max(1, deadline - d.now());
  await probeManager(d, manager, realRoot, env, remaining(), signal);
  const packages = {} as Record<ManagedPackage, PackageCheckState>;
  let updateAvailable = false;
  for (const name of MANAGED_PACKAGES) {
    const local = name === MODELS_DEV_PACKAGE ? selection.modelsDev : selection.modelparams;
    try {
      const latest = await queryLatest(d, manager, name, realRoot, env, signal, remaining());
      const state = classify(local, latest);
      if (state.status === "update-available") updateAvailable = true;
      packages[name] = state;
    } catch (error) {
      packages[name] = {
        status: "query-failed",
        localVersion: local?.version,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { manager: { kind: manager.kind, reason: manager.reason }, packages, updateAvailable };
}

// ---------------------------------------------------------------------------
// Update lock: in-process mutex + cross-process lock + recovery guard
// ---------------------------------------------------------------------------

let updateInProgress = false;

export class UpdateBusyError extends Error {
  constructor(detail?: string) {
    super(`metadata update already in progress${detail ? `: ${detail}` : ""}`);
    this.name = "UpdateBusyError";
  }
}

function isProcessAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // provably dead on this machine
    return undefined; // EPERM etc. — cannot prove dead: do not steal
  }
}

function readLock(lockFile: string): { pid?: number; token?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* unreadable */ }
  return undefined;
}

/**
 * Lock release keyed by a unique per-acquisition token: only the exact
 * holder may remove the file — a stale-racer's late release can never
 * delete another process's live lock.
 */
function makeRelease(lockFile: string, token: string): () => void {
  return () => {
    const owner = readLock(lockFile);
    if (owner?.token === token) rmSync(lockFile, { force: true });
  };
}

/**
 * Conservative cross-process update lock.
 *
 * Acquisition: O_EXCL create. Contended: the recorded owner must be
 * provably dead on THIS machine before reclaim — and the reclaim itself is
 * serialized behind `recovery.lock`, so two processes can never both
 * observe "dead owner → unlink → create" and each steal a live lock.
 * Under the guard we re-read the lock file; if a new live owner already
 * took it, we yield busy instead of removing their lock.
 */
function acquireUpdateLock(realRoot: string, now: number): () => void {
  const lockFile = join(realRoot, UPDATE_LOCK);
  const token = `${process.pid}-${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const tryCreate = (): boolean => {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: now }));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (tryCreate()) return makeRelease(lockFile, token);

  // Contended — check liveness under the recovery guard so concurrent
  // reclaimers serialize instead of unlinking each other's fresh locks.
  const guardFile = join(realRoot, RECOVERY_LOCK);
  const tryGuard = (): number | undefined => {
    try {
      return openSync(guardFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return undefined;
    }
  };
  const guardFd = tryGuard();
  // Never recursively steal a recovery guard: doing so recreates the same
  // stale-unlink race one level higher. A crash here requires manual inspection.
  if (guardFd === undefined) throw new UpdateBusyError(`inspect recovery guard ${guardFile}`);
  try {
    writeFileSync(guardFd, JSON.stringify({ pid: process.pid, token }));
    const owner = readLock(lockFile); // RE-READ under guard
    if (owner === undefined) throw new UpdateBusyError(); // unreadable: alive
    const alive = owner.pid !== undefined ? isProcessAlive(owner.pid) : true;
    if (alive !== false) throw new UpdateBusyError();
    // Provably dead owner and still the same file we evaluated: safe to
    // remove exactly this record, then race a fresh exclusive create.
    rmSync(lockFile, { force: true });
    if (!tryCreate()) throw new UpdateBusyError();
    return makeRelease(lockFile, token);
  } finally {
    closeSync(guardFd);
    rmSync(guardFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Validation worker (one-shot, bounded, cancellable)
// ---------------------------------------------------------------------------

export type ValidationOutcome =
  | { ok: true; degraded: { site: string; reason: string; scope?: string }[] }
  | { ok: false; error: string };

export type ValidationWorker = (req: {
  workerFile: string;
  generationRoot: string;
  /** Existing pair may resolve from different bundled dependency roots. */
  sources?: DataSelection;
  targets: Record<ManagedPackage, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}) => Promise<ValidationOutcome>;

/**
 * Reuses the compile worker's real shape checks on the candidate
 * generation. The worker gets the caller's remaining budget: on timeout or
 * abort it is terminated and AWAITED before the update lock can release.
 * stdout/stderr are drained and bounded — never an unbounded buffer.
 */
async function runValidationWorker(req: {
  workerFile: string;
  generationRoot: string;
  sources?: DataSelection;
  targets: Record<ManagedPackage, string>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<ValidationOutcome> {
  const { workerFile, generationRoot, targets, signal, timeoutMs } = req;
  return new Promise((resolvePromise) => {
    let settled = false;
    let terminating = false;
    let errTail = "";
    let outTail = "";
    const tail = (c: Buffer, into: "err" | "out") => {
      if (into === "err") errTail = (errTail + c.toString("utf8")).slice(-MAX_OUTPUT);
      else outTail = (outTail + c.toString("utf8")).slice(-MAX_OUTPUT);
    };
    const worker = new Worker(workerFile, {
      execArgv: [],
      stderr: true,
      stdout: true,
      workerData: {
        config: {},
        publicIds: [],
        neededSites: ["models.dev", "modelparams.dev"],
        modelsDevSnapshotPath: req.sources
          ? join(req.sources.modelsDev!.dir, PACKAGE_ENTRY[MODELS_DEV_PACKAGE])
          : join(generationRoot, "node_modules", packageDirName(MODELS_DEV_PACKAGE), PACKAGE_ENTRY[MODELS_DEV_PACKAGE]),
        modelparamsPath: req.sources
          ? join(req.sources.modelparams!.dir, PACKAGE_ENTRY[MODELPARAMS_PACKAGE])
          : join(generationRoot, "node_modules", packageDirName(MODELPARAMS_PACKAGE), PACKAGE_ENTRY[MODELPARAMS_PACKAGE]),
        modelsDevVersion: targets[MODELS_DEV_PACKAGE],
        modelparamsVersion: targets[MODELPARAMS_PACKAGE],
        compileModulePath: join(EXTENSION_DIR, "model-metadata.ts"),
      },
    });
    worker.stderr?.on("data", (c: Buffer) => tail(c, "err"));
    worker.stdout?.on("data", (c: Buffer) => tail(c, "out"));
    const finish = (outcome: ValidationOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(outcome);
    };
    const complete = async (outcome: ValidationOutcome) => {
      if (settled || terminating) return;
      terminating = true; // first outcome wins even while termination is awaited.
      try { await worker.terminate(); } catch { /* gone */ }
      finish(outcome);
    };
    const timer = setTimeout(() => {
      void complete({ ok: false, error: "validation timed out" });
    }, timeoutMs);
    timer.unref();
    const onAbort = () => void complete({ ok: false, error: "validation aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: { ok?: boolean; result?: { degraded?: { site: string; reason: string; scope?: string }[] }; error?: { message?: string } }) => {
      if (message.ok && message.result) {
        void complete({ ok: true, degraded: message.result.degraded ?? [] });
      } else {
        void complete({ ok: false, error: message.error?.message ?? "validation worker failed" });
      }
    });
    worker.once("error", (error) => {
      void complete({ ok: false, error: error.message });
    });
    worker.once("exit", (code) => {
      if (terminating) return;
      // After a result message this resolve is a harmless no-op; a worker
      // that exits without posting (import crash) must not hang the update.
      finish({
        ok: false,
        error: `validation worker exited ${code} before reporting: ${errTail.trim().slice(0, 300) || outTail.trim().slice(0, 300) || "no output"}`,
      });
    });
  });
}

/** Interprets the worker's per-shape degradations as a site verdict. */
function validateDegraded(degraded: { site: string; reason: string; scope?: string }[]): string | undefined {
  const reasons = (site: string, scope?: string) =>
    degraded.filter((x) => x.site === site && x.scope === scope);
  // models.dev is usable iff at least ONE of its two shapes survived.
  const modelsDevFailed =
    reasons("models.dev").length > 0 || // whole-site reason
    (reasons("models.dev", "providers").length > 0 && reasons("models.dev", "models").length > 0);
  const modelparamsFailed = reasons("modelparams.dev").length > 0;
  if (modelsDevFailed || modelparamsFailed) {
    return degraded.map((x) => `${x.site}${x.scope ? `/${x.scope}` : ""}: ${x.reason}`).join("; ");
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Isolated install & activation
// ---------------------------------------------------------------------------

export type UpdateResult = {
  /** False when nothing needed installing (all up-to-date and complete). */
  activated: boolean;
  generation?: string;
  /** Effective versions after the call (activated or already-current). */
  versions: { modelsDev?: string; modelparams?: string };
  manager: ManagerKind;
  /** Per-package detail for the caller to render. */
  packages: Record<ManagedPackage, {
    previous?: string; target?: string; action: "installed" | "kept" | "none";
  }>;
};

/** Per-manager install argv: manifest-written exact deps, no scripts/peers. */
function installArgs(manager: SelectedManager, dir: string): string[] {
  if (manager.kind === "bun") {
    return ["install", "--cwd", dir, "--ignore-scripts", "--omit=peer"];
  }
  if (manager.kind === "pnpm") {
    return [
      "install", "--prefix", dir, "--ignore-scripts", "--prod",
      "--config.auto-install-peers=false",
      "--config.strict-peer-dependencies=false",
    ];
  }
  return [
    "install", "--prefix", dir, "--ignore-scripts", "--omit=dev",
    "--legacy-peer-deps", "--no-audit", "--no-fund",
  ];
}

/** Exact target per package: never below the current effective version. */
function chooseTarget(local: string | undefined, latest: string): string {
  if (local && semver.valid(local) && semver.gt(local, latest)) return local;
  return latest;
}

/**
 * `/provider-metadata update`: query both packages, install one isolated
 * generation, validate it in a Worker, then atomically swap `active.json`.
 * Any failure/timeout/cancel before the swap leaves the previous data —
 * and any already-published catalog — untouched.
 *
 * ONE operation deadline (default 5 min) covers probe, queries, install
 * and validation; the lock is only released after owned children and the
 * validation worker have actually terminated.
 */
export async function updateMetadataPackages(
  deps: MetadataPackagesDeps,
  signal?: AbortSignal,
): Promise<UpdateResult> {
  const d = resolveDeps(deps);
  if (d.offline) throw new Error("offline: metadata update skipped");
  signal?.throwIfAborted();
  if (updateInProgress) throw new UpdateBusyError();
  updateInProgress = true;
  try {
    const root = metadataRoot(d.agentDir);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Canonicalize once: every containment check below compares realpaths,
    // so the root itself must be the real path (agentDir may be a symlink).
    const realRoot = realpathSync(root);
    chmodSync(realRoot, 0o700);
    const releaseLock = acquireUpdateLock(realRoot, d.now());

    // Single deadline for the whole operation.
    const deadline = d.now() + d.installTimeoutMs;
    const remaining = () => {
      const budget = deadline - d.now();
      if (budget <= 0) throw new DOMException("metadata update timed out", "TimeoutError");
      return budget;
    };

    try {
      // Re-read under the lock: another process may have activated newer
      // data while we waited — never downgrade its result.
      const selection = selectDataSource(d);
      const manager = selectPackageManager(d);
      const env = managerEnv(realRoot, manager);
      await probeManager(d, manager, realRoot, env, Math.min(remaining(), d.queryTimeoutMs), signal);

      // --- query ---------------------------------------------------------
      const localOf = (name: ManagedPackage) =>
        (name === MODELS_DEV_PACKAGE ? selection.modelsDev : selection.modelparams)?.version;
      const latest: Partial<Record<ManagedPackage, string>> = {};
      for (const name of MANAGED_PACKAGES) {
        // Any failed query aborts the whole update before installing.
        latest[name] = await queryLatest(
          d, manager, name, realRoot, env, signal,
          Math.min(remaining(), d.queryTimeoutMs),
        );
      }
      const targets = {} as Record<ManagedPackage, string>;
      const packages = {} as UpdateResult["packages"];
      let anythingNeeded = false;
      for (const name of MANAGED_PACKAGES) {
        const local = localOf(name);
        const target = chooseTarget(local, latest[name]!);
        targets[name] = target;
        const dir = name === MODELS_DEV_PACKAGE ? selection.modelsDev : selection.modelparams;
        // Complete + usable + current is required for "kept" — a missing
        // entry file or unreadable version means repair (finding 6).
        const manifest = dir ? readManifest(dir.dir) : undefined;
        const usable = dir !== undefined && local !== undefined && semver.valid(local)
          && manifest?.name === name && manifest.version === local
          && existsSync(join(dir.dir, PACKAGE_ENTRY[name]));
        const needs = !usable || semver.lt(local!, target);
        if (needs) anythingNeeded = true;
        packages[name] = { previous: local, target, action: needs ? "installed" : "kept" };
      }
      if (!anythingNeeded) {
        // A manifest and entry file can survive a partial installation. Only
        // a real bounded load/shape check permits the successful no-op path.
        const validation = await (d.spawnWorker ?? runValidationWorker)({
          workerFile: join(EXTENSION_DIR, "metadata-compile-worker.mjs"),
          generationRoot: realRoot, sources: selection, targets, signal, timeoutMs: remaining(),
        });
        signal?.throwIfAborted();
        remaining();
        if (validation.ok && !validateDegraded(validation.degraded)) {
          return {
            activated: false,
            versions: { modelsDev: localOf(MODELS_DEV_PACKAGE), modelparams: localOf(MODELPARAMS_PACKAGE) },
            manager: manager.kind,
            packages: Object.fromEntries(MANAGED_PACKAGES.map((n) =>
              [n, { ...packages[n], action: "none" as const }])) as UpdateResult["packages"],
          };
        }
        for (const name of MANAGED_PACKAGES) packages[name].action = "installed";
      }

      // --- isolated generation -------------------------------------------
      const generation = `gen-${d.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const genDir = generationDir(realRoot, generation);
      // generations/ parent must itself be contained before we write into
      // it — a symlinked parent is a write escape (finding 1).
      const generationsParent = join(realRoot, GENERATIONS_DIR);
      if (existsSync(generationsParent) && !containedInRoot(realRoot, generationsParent)) {
        throw new Error("generations directory escapes the private root");
      }
      mkdirSync(genDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(genDir, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            [MODELS_DEV_PACKAGE]: targets[MODELS_DEV_PACKAGE],
            [MODELPARAMS_PACKAGE]: targets[MODELPARAMS_PACKAGE],
          },
        }),
        { mode: 0o600 },
      );
      const install = await d.runner({
        command: manager.command,
        args: [...manager.prefixArgs, ...installArgs(manager, genDir)],
        cwd: genDir,
        env,
        timeoutMs: remaining(),
        signal,
      });
      signal?.throwIfAborted(); // abort beats a killed-process error report
      if (install.code !== 0) {
        throw new ProcessRunError([manager.command, "install"], install);
      }

      // --- validate -------------------------------------------------------
      // Manifest identity + exact version must match the chosen target, and
      // every path — package dir, manifest, data entry — must resolve inside
      // the canonical root (finding 1: leaf symlinks count).
      for (const name of MANAGED_PACKAGES) {
        const dir = packageDirInGeneration(realRoot, generation, name);
        const manifestPath = join(dir, "package.json");
        const entryPath = join(dir, PACKAGE_ENTRY[name]);
        if (!containedInRoot(realRoot, dir)
          || !containedInRoot(realRoot, manifestPath)
          || !containedInRoot(realRoot, entryPath)) {
          throw new Error(`installed ${name} escapes the generation directory`);
        }
        const manifest = readManifest(dir);
        if (!manifest) throw new Error(`installed ${name} has no readable manifest`);
        if (manifest.name !== name || manifest.version !== targets[name]) {
          throw new Error(
            `installed ${name} identity mismatch: expected ${name}@${targets[name]}, got ${manifest.name}@${manifest.version}`,
          );
        }
      }
      const spawnWorker = d.spawnWorker ?? runValidationWorker;
      const validation = await spawnWorker({
        workerFile: join(EXTENSION_DIR, "metadata-compile-worker.mjs"),
        generationRoot: genDir,
        targets,
        signal,
        timeoutMs: remaining(),
      });
      signal?.throwIfAborted();
      if (!validation.ok) throw new Error(`new generation failed validation: ${validation.error}`);
      const siteFailure = validateDegraded(validation.degraded);
      if (siteFailure) throw new Error(`new generation unusable — ${siteFailure}`);
      signal?.throwIfAborted();
      remaining();

      // --- commit ----------------------------------------------------------
      // One abort re-check immediately before the atomic pointer swap.
      const record: ActiveRecord = {
        format: ACTIVE_FORMAT,
        generation,
        versions: { modelsDev: targets[MODELS_DEV_PACKAGE], modelparams: targets[MODELPARAMS_PACKAGE] },
      };
      // Exclusive temp file in the same directory → atomic rename.
      const tmpFile = join(realRoot, `${ACTIVE_RECORD}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
      const fd = openSync(tmpFile, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(record));
      } finally {
        closeSync(fd);
      }
      renameSync(tmpFile, join(realRoot, ACTIVE_RECORD)); // same filesystem = atomic
      return {
        activated: true,
        generation,
        versions: { modelsDev: targets[MODELS_DEV_PACKAGE], modelparams: targets[MODELPARAMS_PACKAGE] },
        manager: manager.kind,
        packages,
      };
    } finally {
      releaseLock();
    }
  } finally {
    updateInProgress = false;
  }
}
