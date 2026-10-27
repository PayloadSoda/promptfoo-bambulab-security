import { readFile, writeFile, rename, copyFile, unlink, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// The CLI writes a fresh export. Combine it only after it finishes, so a failed
// or cancelled process cannot truncate an existing report.
export async function saveOutput(staged, destination) {
  const fresh = await readFile(staged, 'utf8');
  let existing;
  try { existing = await readFile(destination, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const extension = path.extname(destination).toLowerCase();
  let combined = fresh;
  let backup;
  if (extension === '.json') {
    const next = JSON.parse(fresh);
    if (existing?.trim()) {
      const previous = JSON.parse(existing);
      combined = JSON.stringify([...(Array.isArray(previous) ? previous : [previous]), next], null, 2) + '\n';
    }
  } else if (existing) {
    if (extension === '.jsonl') {
      combined = existing + (existing.endsWith('\n') ? '' : '\n') + fresh;
    } else {
      // HTML/XML/CSV/YAML exports cannot safely be concatenated as documents.
      backup = `${destination}.previous-${randomUUID()}`;
      await copyFile(destination, backup, constants.COPYFILE_EXCL);
    }
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const mode = (await stat(destination).catch(() => null))?.mode ?? 0o600;
  try {
    await writeFile(temporary, combined, { flag: 'wx', mode });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => {}); }
  return { appended: !!existing?.trim() && ['.json', '.jsonl'].includes(extension), backup };
}
