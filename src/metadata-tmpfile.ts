/**
 * Temp file writer for the compile-view command. The file lives in
 * `mkdtemp(join(os.tmpdir(), "openai-api-extension-metadata-<pid>-"))`
 * with 0700 on the directory and 0600 on the file. Files are retained —
 * the command prints the path for the user to open; the OS temp cleaner
 * reclaims them.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PREFIX = "openai-api-extension-metadata-";

/** Writes `content` to a fresh temp file; returns its absolute path. */
export function writeMetadataTempFile(content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), `${PREFIX}${process.pid}-`), { mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "metadata-compile.txt");
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
