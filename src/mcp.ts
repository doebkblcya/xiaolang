import type { Plugin } from 'cordis';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Fields } from './contracts.js';
import { log } from './contracts.js';
import { Failure } from './errors.js';
import { mcpConnections, toolingDefaults, toolingSchemas } from './tooling-config.js';

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server.slice(0, 20)}_${tool.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24)}_${createHash('sha256').update(tool).digest('hex').slice(0, 8)}`;
}
export const mcpPlugin: Plugin.Object<Config> = { name: 'xiaolang-mcp', inject: ['tools'], apply(ctx, config) {
  ctx.get('configuration')?.registerPlugin('xiaolang-mcp', toolingSchemas.mcp);
  const settings = config.tooling?.mcp ?? toolingDefaults.mcp;
  const connections = settings.enabled ? mcpConnections(settings.servers) : {};
  const rows = Object.entries(connections).map(([name, connection]) => ({ name, connection, state: 'connecting', errorCode: '',
    client: undefined as Client | undefined, removes: [] as (() => void)[], working: false }));
  let stopped = false;
  ctx.provide('mcp', { status: () => rows.map(({ name, connection, state, errorCode, removes }) => ({ name, transport: connection.url ? 'http' : 'stdio', state, errorCode, tools: removes.length })) });
  ctx.effect(() => ctx.tools.registerSource?.({ id: 'xiaolang-mcp', plugin: 'xiaolang-mcp', title: 'MCP', status: () => {
    const connected = rows.filter(row => row.state === 'connected').length, failed = rows.some(row => row.state === 'error' || row.errorCode);
    return { state: !settings.enabled ? 'disabled' : failed ? 'error' : !rows.length ? 'empty' : connected === rows.length ? 'ready' : 'connecting',
      label: !settings.enabled ? '已关闭' : failed ? '有连接异常' : !rows.length ? '未添加连接' : connected === rows.length ? `${connected} 个连接` : '连接中',
      items: rows.map(row => ({ name: row.name, state: row.state, errorCode: row.errorCode, detail: `${row.connection.url ? 'HTTP' : 'stdio'} · ${row.removes.length} 个工具` })) };
  } }) ?? (() => {}));
  for (const row of rows) ctx.effect(() => ctx.tools.registerSource?.({ id: `mcp:${row.name}`, plugin: 'xiaolang-mcp', title: `MCP · ${row.name}` }) ?? (() => {}));
  async function connect(row: typeof rows[number]) {
    if (stopped || row.working || row.state === 'connected') return;
    row.working = true; row.state = 'connecting';
    const client = new Client({ name: 'xiaolang', version: '0.1.0' }); row.client = client;
    const clear = () => { row.removes.splice(0).forEach(remove => remove()); };
    client.onclose = () => { clear(); row.state = 'disconnected'; };
    client.onerror = () => { row.errorCode = 'mcp_connection_error'; };
    async function refresh() {
      const tools = []; let cursor: string | undefined; let pages = 0;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
        tools.push(...page.tools); cursor = page.nextCursor;
        if (tools.length > 100 || ++pages > 10) throw new Failure('mcp_tool_limit');
      } while (cursor);
      if (stopped) return;
      clear();
      for (const tool of tools) {
        const publicRead = row.connection.publicTools?.includes(tool.name) === true && tool.annotations?.readOnlyHint === true;
        try { row.removes.push(ctx.tools.register({ name: mcpToolName(row.name, tool.name), source: `mcp:${row.name}`,
          owner: 'xiaolang-mcp', title: String(tool.title ?? tool.annotations?.title ?? tool.name).slice(0, 120),
          summary: String(tool.description ?? tool.name).split(/[。\n]/)[0]!.slice(0, 160),
          validation: { mode: 'compatible', maxCatalogTools: 100, maxSchemaChars: 12000 },
          description: String(tool.description ?? tool.name).slice(0, 2000), parameters: tool.inputSchema as Fields,
          access: publicRead ? 'everyone' : 'admin', effect: publicRead ? 'read' : 'write', timeoutMs: 60000,
          execute: async (args, { signal }) => {
            const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 60000 });
            if (result.isError) throw new Failure('mcp_tool_error');
            return { content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}) };
          } })); } catch { log(ctx, 'mcp_tool_rejected', undefined, 'tools', { plugin: row.name }); }
      }
    }
    try {
      const transport = row.connection.url ? new StreamableHTTPClientTransport(new URL(row.connection.url), {
        requestInit: { headers: row.connection.headers, redirect: 'error' }, reconnectionOptions: { maxReconnectionDelay: 5000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 2, maxRetries: 1 },
      }) : new StdioClientTransport({ command: row.connection.command!, args: row.connection.args, env: row.connection.env, stderr: 'pipe', maxBufferSize: 2_000_000 });
      if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
      await client.connect(transport, { timeout: 15000 });
      if (stopped) { await client.close(); return; }
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { try { await refresh(); } catch { row.errorCode = 'mcp_refresh_failed'; } });
      if (client.getServerCapabilities()?.tools) await refresh();
      row.state = 'connected'; row.errorCode = '';
      log(ctx, 'mcp_connected', undefined, 'tools', { plugin: row.name });
    } catch {
      clear(); row.state = 'error'; row.errorCode = 'mcp_connection_failed';
      await client.close().catch(() => {}); row.state = 'error';
      if (!stopped) log(ctx, 'mcp_connection_failed', undefined, 'tools', { plugin: row.name });
    } finally { row.working = false; }
  }
  // MCP outages do not block QQ readiness; each connection retries independently.
  const timer = setInterval(() => { for (const row of rows) void connect(row); }, 30000); timer.unref();
  for (const row of rows) void connect(row);
  ctx.effect(() => async () => { stopped = true; clearInterval(timer); for (const row of rows) { row.removes.splice(0).forEach(remove => remove()); await row.client?.close().catch(() => {}); } });
} };
