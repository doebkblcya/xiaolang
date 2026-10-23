import { readFileSync, writeFileSync } from 'node:fs';
if (JSON.parse(readFileSync('node_modules/@tencent-connect/qqbot-nodejs/package.json', 'utf8')).version !== '1.0.5') throw Error('Review QQ SDK patches before changing version');
// Pinned SDK 1.0.5: preserve its transport, add response semantics missing from that release.
const path = 'node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api/api-client.js';
let source = readFileSync(path, 'utf8');
const marker = '// xiaolang: business errors and trace IDs';
if (!source.includes(marker)) {
  const anchor = '        if (!res.ok) {';
  if (!source.includes(anchor)) throw Error('QQ SDK response patch needs review');
  source = source.replace(anchor, `        ${marker}
        let decoded;
        try { decoded = JSON.parse(rawBody); } catch {}
        const business = decoded && typeof decoded === 'object' ? decoded.err_code ?? decoded.code : undefined;
        if (!res.ok || (typeof business === 'number' && business !== 0)) {
            throw Object.assign(new ApiError('QQ API rejected request', res.status, path, business), {
                traceId: traceId || decoded?.trace_id,
            });
        }
        if (!rawBody.trim()) return undefined;
${anchor}`);
  writeFileSync(path, source);
}
const typesPath = 'node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/types.d.ts';
const types = readFileSync(typesPath, 'utf8');
writeFileSync(typesPath, types.replace(/(export interface StreamMessageRequest \{[\s\S]*?)event_id: string;/, '$1event_id?: string;'));
const tokenPath = 'node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api/token.js';
const token = readFileSync(tokenPath, 'utf8');
const tokenAnchor = 'throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);';
if (!token.includes('QQ credential response rejected')) {
  if (!token.includes(tokenAnchor)) throw Error('QQ SDK token patch needs review');
  writeFileSync(tokenPath, token.replace(tokenAnchor, "throw Object.assign(new Error('QQ credential response rejected'), { bizCode: data.code ?? data.err_code, httpStatus: response.status, traceId: traceId || data.trace_id });"));
}
