import type { WfTaskExecutor } from './engine.types';
import { WfExecutorRegistry } from './executor-registry';

const executor = (taskType: string): WfTaskExecutor => ({
  taskType,
  execute: () => Promise.resolve({ kind: 'wait' }),
});

describe('WfExecutorRegistry', () => {
  it('enregistre et retrouve un exécuteur par type', () => {
    const registry = new WfExecutorRegistry();
    const agent = executor('agent');
    registry.register(agent);
    expect(registry.has('agent')).toBe(true);
    expect(registry.get('agent')).toBe(agent);
    expect(registry.has('generation')).toBe(false);
    expect(registry.get('generation')).toBeUndefined();
    expect(registry.types()).toEqual(['agent']);
  });

  it('refuse un double enregistrement du même type (aucun remplacement silencieux)', () => {
    const registry = new WfExecutorRegistry();
    const first = executor('generation');
    registry.register(first);
    expect(() => registry.register(executor('generation'))).toThrow(/déjà enregistré/);
    expect(registry.get('generation')).toBe(first);
  });

  it('refuse un type de tâche inconnu ou un exécuteur sans execute', () => {
    const registry = new WfExecutorRegistry();
    expect(() => registry.register(executor('form'))).toThrow(/inconnu/);
    expect(() => registry.register({ taskType: 'agent' } as unknown as WfTaskExecutor)).toThrow(/execute/);
    expect(registry.has('agent')).toBe(false);
  });
});
