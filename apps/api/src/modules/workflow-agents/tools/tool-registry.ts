import type { WfTool, WfToolDescriptor, WfToolRegistryPort } from '../agent.contracts';

const TOOL_KEY_PATTERN = /^[a-z0-9_.]+$/;
const TOOL_KEY_MAX = 100;

/** Registre en mémoire des outils d'agent. Refuse clé invalide, doublon, et outil irréversible non validé. */
export class WfToolRegistry implements WfToolRegistryPort {
  private readonly tools = new Map<string, WfTool>();

  register(tool: WfTool): void {
    const key = tool.key;
    if (typeof key !== 'string' || key.length === 0 || key.length > TOOL_KEY_MAX || !TOOL_KEY_PATTERN.test(key)) {
      throw new Error('Clé d’outil invalide : attendu [a-z0-9_.]+ (100 caractères au plus).');
    }
    if (this.tools.has(key)) throw new Error(`Outil déjà enregistré : ${key}`);
    if (tool.sideEffect === 2 && tool.requiresValidation !== true) {
      throw new Error(`Outil ${key} : un effet externe ou irréversible exige une validation humaine.`);
    }
    this.tools.set(key, tool);
  }

  get(key: string): WfTool | undefined {
    return this.tools.get(key);
  }

  list(): WfTool[] {
    return [...this.tools.values()];
  }

  /** Descripteurs des seuls outils demandés ET connus (une clé inconnue est ignorée, jamais inventée). */
  describe(keys: readonly string[]): WfToolDescriptor[] {
    const out: WfToolDescriptor[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const tool = this.tools.get(key);
      if (!tool) continue;
      out.push({
        key: tool.key,
        label: tool.label,
        description: tool.description,
        sideEffect: tool.sideEffect,
        requiresValidation: tool.requiresValidation,
        jsonSchema: tool.jsonSchema,
      });
    }
    return out;
  }
}
