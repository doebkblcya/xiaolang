import { createHash } from 'node:crypto';

/** Keep resource-identifying query parameters; only QQ's renewable access key is excluded. */
export function imageKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  if (parsed.hostname === 'multimedia.nt.qq.com.cn' && parsed.pathname === '/download' && parsed.searchParams.has('fileid')) parsed.searchParams.delete('rkey');
  parsed.searchParams.sort();
  return 'v2:' + createHash('sha256').update(parsed.href).digest('hex');
}
