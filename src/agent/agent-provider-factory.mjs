import { LocalAgentProvider } from './local-agent-provider.mjs';
import { FallbackAgentProvider } from './fallback-agent-provider.mjs';
import { HermesApiAgentProvider } from './hermes-api-agent-provider.mjs';
import { DirectApiAgentProvider } from './direct-api-agent-provider.mjs';

export function createAgentProvider(options = {}) {
  const transport = String(
    options.transport
    || process.env.AGENT_TRANSPORT
    || 'cli'
  ).trim().toLowerCase();

  const local = new LocalAgentProvider(options);
  if (transport === 'direct-api') {
    const fallbackMode = String(
      options.directApiFallback
      || process.env.DIRECT_API_FALLBACK
      || 'cli'
    ).trim().toLowerCase();
    console.error(`[agent] transport=direct-api fallback=${fallbackMode}`);
    const direct = new DirectApiAgentProvider(options);
    if (fallbackMode === 'none') {
      return direct;
    }
    return new FallbackAgentProvider(direct, local, { name: 'direct-api' });
  }

  if (transport === 'api') {
    const api = new HermesApiAgentProvider(options);
    const fallbackMode = String(options.apiFallback || process.env.AGENT_API_FALLBACK || 'cli').trim().toLowerCase();
    console.error(`[agent] transport=api fallback=${fallbackMode}`);
    if (fallbackMode === 'none') {
      return api;
    }

    return new FallbackAgentProvider(api, local, { name: 'api' });
  }

  console.error('[agent] transport=cli');
  return local;
}
