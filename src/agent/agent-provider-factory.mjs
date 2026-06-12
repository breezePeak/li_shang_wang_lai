import { HermesWebSocketAgentProvider } from './hermes-ws-agent-provider.mjs';
import { LocalAgentProvider } from './local-agent-provider.mjs';
import { FallbackAgentProvider } from './fallback-agent-provider.mjs';

export function createAgentProvider(options = {}) {
  const transport = String(
    options.transport
    || process.env.AGENT_TRANSPORT
    || (process.env.HERMES_WS_URL ? 'ws' : 'cli')
  ).trim().toLowerCase();

  const local = new LocalAgentProvider(options);
  if (transport !== 'ws') {
    return local;
  }

  const websocket = new HermesWebSocketAgentProvider(options);
  const fallbackMode = String(options.wsFallback || process.env.AGENT_WS_FALLBACK || 'cli').trim().toLowerCase();
  if (fallbackMode === 'none') {
    return websocket;
  }

  return new FallbackAgentProvider(websocket, local, { name: 'websocket' });
}
