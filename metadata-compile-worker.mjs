/**
 * The Pi plugin's compile Worker entry: a thin wrapper over the host-neutral
 * body in metadata-worker.ts, which loads the data packages (or a SourceTables
 * file), compiles, and returns only the compiled result. The snapshot and its
 * object graph die with this worker; the main thread never imports either
 * package.
 */
import { parentPort, workerData } from "node:worker_threads";

import { runCompileWorkerBody } from "./metadata-worker.ts";

parentPort.postMessage(await runCompileWorkerBody(workerData));
