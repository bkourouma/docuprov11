import { z } from 'zod';
import type { WfTool } from '../agent.contracts';
import { WfToolRegistry } from './tool-registry';

function tool(over: Partial<WfTool> = {}): WfTool {
  return {
    key: 'outil.test_1',
    label: 'Outil',
    description: 'Un outil',
    sideEffect: 0,
    requiresValidation: false,
    inputSchema: z.object({}).strict(),
    jsonSchema: { type: 'object' },
    execute: async () => ({ output: null, sources: [] }),
    ...over,
  };
}

describe('WfToolRegistry', () => {
  it('enregistre et retrouve un outil', () => {
    const r = new WfToolRegistry();
    const t = tool();
    r.register(t);
    expect(r.get('outil.test_1')).toBe(t);
    expect(r.list()).toEqual([t]);
    expect(r.get('inconnu')).toBeUndefined();
  });

  it.each(['', 'Majuscule', 'avec espace', 'tiret-invalide', 'accentué', 'a'.repeat(101)])(
    'refuse la clé invalide %j',
    (key) => {
      expect(() => new WfToolRegistry().register(tool({ key }))).toThrow(/Clé d’outil invalide/);
    },
  );

  it('accepte une clé de 100 caractères', () => {
    expect(() => new WfToolRegistry().register(tool({ key: 'a'.repeat(100) }))).not.toThrow();
  });

  it('refuse un doublon', () => {
    const r = new WfToolRegistry();
    r.register(tool());
    expect(() => r.register(tool())).toThrow(/déjà enregistré/);
  });

  it('refuse un outil sideEffect 2 sans validation, accepte avec validation', () => {
    const r = new WfToolRegistry();
    expect(() => r.register(tool({ key: 'ext', sideEffect: 2, requiresValidation: false }))).toThrow(/validation/);
    expect(() => r.register(tool({ key: 'ext', sideEffect: 2, requiresValidation: true }))).not.toThrow();
  });

  it('describe ne renvoie que les clés demandées ET connues (sans doublon)', () => {
    const r = new WfToolRegistry();
    r.register(tool({ key: 'a' }));
    r.register(tool({ key: 'b' }));
    const d = r.describe(['b', 'inconnu', 'b']);
    expect(d.map((x) => x.key)).toEqual(['b']);
    expect(Object.keys(d[0]).sort()).toEqual(
      ['description', 'jsonSchema', 'key', 'label', 'requiresValidation', 'sideEffect'].sort(),
    );
    expect(r.describe([])).toEqual([]);
  });
});
