// Writes a file so a crash leaves either the old file or the new one, never half of one:
// a temp file in the same folder, fsynced, then renamed over the target. Used for Snow's state
// (state-store.js) and for each desk's last-good.json (edition-loader.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} filePath the file to replace (its folder is created when needed)
 * @param {string | Buffer} data the whole new content (text is written as UTF-8)
 * @param {{ fsp?: typeof fs.promises, mode?: number }} [options] fsp lets tests make a step fail
 */
export async function writeFileAtomic(filePath, data, { fsp = fs.promises, mode = 0o600 } = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${base}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', mode);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  // Make the rename itself durable. Best effort: not every file system lets you fsync a folder.
  try {
    const d = await fsp.open(dir, 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {
    /* the file itself is already safe */
  }
}
