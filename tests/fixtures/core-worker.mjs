// A non-Pi host's Worker entry: only the host-neutral body, nothing else.
import { parentPort, workerData } from "node:worker_threads";

import { runCompileWorkerBody } from "../../metadata-worker.ts";

parentPort.postMessage(await runCompileWorkerBody(workerData));
