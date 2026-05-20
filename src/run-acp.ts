import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { nodeToWebWritable, nodeToWebReadable } from './utils.js';
import { AmpAcpAgent } from './server.js';

export function runAcp(): void {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(
    input as unknown as WritableStream<Uint8Array>,
    output as unknown as ReadableStream<Uint8Array>,
  );
  let agent: AmpAcpAgent | null = null;
  new AgentSideConnection((client) => {
    agent = new AmpAcpAgent(client);
    return agent;
  }, stream);
  installShutdownHandlers(() => agent);
}

function installShutdownHandlers(getAgent: () => AmpAcpAgent | null): void {
  let cleaned = false;
  const cleanup = (signal: string): void => {
    if (cleaned) return;
    cleaned = true;
    const agent = getAgent();
    if (agent) {
      for (const [, s] of agent.sessions) {
        if (s.active && s.controller) {
          s.cancelled = true;
          try { s.controller.abort(); } catch { /* ignore */ }
        }
      }
      void agent.shutdown().catch((e) => {
        console.error('[acp] permission broker shutdown failed', e);
      });
    }
    console.error(`[acp] shutting down (${signal})`);
    // Give in-flight abort propagation a moment, then exit. The SDK's spawned
    // amp.exe should die on AbortController.abort().
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGHUP', () => cleanup('SIGHUP'));
}
