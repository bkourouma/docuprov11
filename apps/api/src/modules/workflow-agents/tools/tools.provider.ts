import type { Provider } from '@nestjs/common';
import { WF_TOOL_REGISTRY } from '../agent.contracts';
import { AgentDataAdapter } from './agent-data.adapter';
import { WF_AGENT_DATA, type WfAgentDataPort } from './agent-data.port';
import { createBaseTools } from './base-tools';
import { WfToolRegistry } from './tool-registry';

/** Port de données = adaptateur (droits du lanceur). */
export const agentDataProvider: Provider = { provide: WF_AGENT_DATA, useExisting: AgentDataAdapter };

/** Registre d'outils : les cinq outils de base sont enregistrés à la construction. */
export const toolRegistryProvider: Provider = {
  provide: WF_TOOL_REGISTRY,
  useFactory: (data: WfAgentDataPort): WfToolRegistry => {
    const registry = new WfToolRegistry();
    for (const tool of createBaseTools(data)) registry.register(tool);
    return registry;
  },
  inject: [WF_AGENT_DATA],
};
