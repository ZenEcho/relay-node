import { chmod, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installReferenceSentinel } from './install-reference-sentinel.mjs';

// Release preparation runs with npm available; installed nodes only need the
// bundled Node.js binary to execute the resulting portable JavaScript runtime.
export async function prepareReferenceSentinel() {
  const directory = fileURLToPath(new URL('../runtime/reference-sentinel', import.meta.url));
  await rm(directory, { recursive: true, force: true });
  const installed = await installReferenceSentinel({ directory });
  // Packaged assets contain no credentials. A service account must be able to
  // read them when dependencies were installed by a different build user.
  async function readable(path) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await readable(child);
      else await chmod(child, 0o644);
    }
  }
  await readable(directory);
  return installed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareReferenceSentinel();
  console.log('Reference Sentinel runtime prepared.');
}
