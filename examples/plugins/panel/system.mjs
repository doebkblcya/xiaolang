import { cpus, totalmem, type, release, arch } from 'node:os';
import { readFile } from 'node:fs/promises';

export function createSystemCollector() {
  let previous = { cpu: process.cpuUsage(), time: process.hrtime.bigint() }, cached, updated = 0;
  return async () => {
    if (cached && Date.now() - updated < 1000) return cached;
    const processors = cpus(), memory = process.memoryUsage();
    let physicalMemory = totalmem(), memoryLimit = null;
    try { const text = await readFile('/proc/meminfo', 'utf8'); const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(text); if (match) physicalMemory = Number(match[1]) * 1024; } catch { /* non-Linux */ }
    for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      try { const value = Number((await readFile(path, 'utf8')).trim()); if (Number.isFinite(value) && value > 0 && value < physicalMemory) memoryLimit = value; break; } catch { /* v1/v2 or no container */ }
    }
    const time = process.hrtime.bigint(), cpu = process.cpuUsage();
    const elapsed = Number(time - previous.time) / 1000;
    const cpuPercent = elapsed > 0 ? Math.max(0, Math.min(100, (cpu.user + cpu.system - previous.cpu.user - previous.cpu.system) / elapsed / Math.max(1, processors.length) * 100)) : 0;
    previous = { cpu, time }; updated = Date.now();
    cached = { machine: { cpuModel: processors[0]?.model ?? '—', logicalCpus: processors.length, memoryTotal: physicalMemory, platform: type(), release: release(), arch: arch() },
      process: { memoryBytes: memory.rss, heapBytes: memory.heapUsed, memoryPercent: physicalMemory ? memory.rss / physicalMemory * 100 : 0,
        cpuPercent, uptimeSeconds: process.uptime(), nodeVersion: process.version }, container: { memoryLimit } };
    return cached;
  };
}
