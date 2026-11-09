// Credentials belong to one OS user, never to browser settings or the board DB.
import { mkdirSync, lstatSync, readFileSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Account = {
  id: string; clientId: string; subject: string; email: string;
  accessToken?: string; refreshToken?: string; idToken?: string;
  expiresAt?: number; refreshExpiresAt?: number; scopes: string[]; revocationUnconfirmed?: boolean;
};
export type Credentials = { hostId: string; active?: string; welcomed?: boolean; accounts: Account[] };
export interface CredentialStore { load(): Credentials; save(data: Credentials): void; close(): void }

/** One process owns the store for its lifetime, so rotating tokens cannot race. */
export function fileStore(directory: string): CredentialStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function privateFile(path: string, directory = false) {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) ||
        (s.mode & 0o077) || (process.getuid && s.uid !== process.getuid())) {
      throw new Error('ChatGPT storage must be owned by this user with private permissions');
    }
  }
  privateFile(directory, true);
  const file = join(directory, 'credentials.json');
  const lock = join(directory, 'lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('ChatGPT storage is locked. Stop the other instance; remove a stale lock only after verifying it is no longer running.'); }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let closed = false;
  return {
    load() {
      try {
        privateFile(file);
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (!/^urn:uuid:[0-9a-f-]{36}$/.test(data.hostId) || !Array.isArray(data.accounts)) throw new Error('Invalid ChatGPT storage');
        return data;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw new Error('ChatGPT credential storage is invalid or cannot be read securely');
        return { hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
      }
    },
    save(data) {
      if (closed) throw new Error('ChatGPT storage is closed');
      const temp = join(directory, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
        renameSync(temp, file);
      } finally { try { unlinkSync(temp); } catch {} }
    },
    close() { if (!closed) { closed = true; unlinkSync(lock); } },
  };
}
