import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { validateWorkflowGraph } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { TEMPLATE_KEYS } from '../catalog.contracts';
import { ALL_TEMPLATES } from './data';
import { TEMPLATE_NAME_MAX_RETRIES, TemplatesService } from './templates.service';

jest.mock('../eval/aiguilleur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('aiguilleur'), { virtual: true });
jest.mock('../eval/redacteur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('redacteur'), { virtual: true });
jest.mock('../eval/controleur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('controleur'), { virtual: true });
jest.mock('../eval/relanceur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('relanceur'), { virtual: true });

const actor: AuthUser = { userId: 7, username: 'conc', fullName: 'Conceptrice', isAdmin: false, userGroupId: 70 };

function build(opts: { takenNames?: string[]; upsertError?: Error } = {}) {
  const taken = new Set(opts.takenNames ?? []);
  const definitions = {
    create: jest.fn(async (input: { name: string }) => {
      if (taken.has(input.name)) throw new ConflictException('Un workflow non archivé porte déjà ce nom.');
      return { definition: { wfDefinitionId: 42 }, version: {} };
    }),
    upsertAgentConfig: jest.fn(async () => {
      if (opts.upsertError) throw opts.upsertError;
      return {};
    }),
    archive: jest.fn(async () => ({})),
  };
  let nextCase = 1000;
  const evals = {
    createSet: jest.fn(async () => ({ wfEvalSetId: 500 })),
    addCase: jest.fn(async () => ({ wfEvalCaseId: nextCase++ })),
    runSet: jest.fn(),
  };
  const audit = { dataChange: jest.fn(async () => undefined) };
  const service = new TemplatesService(definitions as never, evals as never, audit as never);
  return { service, definitions, evals, audit };
}

describe('TemplatesService.list', () => {
  it('projette exactement { key, name, description, agentKey, tags } pour chaque modèle', () => {
    const { service } = build();
    const list = service.list();
    expect(list).toHaveLength(ALL_TEMPLATES.length);
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['agentKey', 'description', 'key', 'name', 'tags']);
    }
    expect(list.map((i) => i.key)).toEqual(ALL_TEMPLATES.map((t) => t.key));
  });
});

describe('TemplatesService.instantiate', () => {
  it('clé inconnue : 404, rien n’est créé', async () => {
    const { service, definitions } = build();
    await expect(service.instantiate('inconnu', undefined, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(definitions.create).not.toHaveBeenCalled();
  });

  it('modèle agent : brouillon, jeu d’évaluation et cas, configuration « suggère » liée au jeu, sans run ni autorisation', async () => {
    const { service, definitions, evals, audit } = build();
    const template = ALL_TEMPLATES.find((t) => t.key === TEMPLATE_KEYS.aiguilleur)!;

    const res = await service.instantiate(TEMPLATE_KEYS.aiguilleur, undefined, actor);
    expect(res).toEqual({ definitionId: 42 });

    expect(definitions.create).toHaveBeenCalledTimes(1);
    const created = definitions.create.mock.calls[0]![0] as { name: string; graph: unknown };
    expect(created.name).toBe(template.name);
    expect(validateWorkflowGraph(created.graph).ok).toBe(true);
    expect(created.graph).not.toBe(template.graph); // copie : la donnée du dépôt n'est jamais partagée

    expect(evals.createSet).toHaveBeenCalledWith(
      expect.objectContaining({ definitionId: 42, stepKey: 'aiguillage', minAccuracy: template.evalSet!.minAccuracy }),
      actor,
    );
    expect(evals.addCase).toHaveBeenCalledTimes(template.evalSet!.cases.length);
    expect(evals.addCase).toHaveBeenCalledWith(500, expect.objectContaining({ label: expect.any(String) }), actor);
    expect(evals.runSet).not.toHaveBeenCalled();

    expect(definitions.upsertAgentConfig).toHaveBeenCalledWith(
      42,
      'aiguillage',
      expect.objectContaining({
        autonomy: 'suggere',
        tools: template.agentSteps.aiguillage!.tools,
        confidenceThreshold: 0.8,
        maxSteps: template.agentSteps.aiguillage!.maxSteps,
        timeoutSeconds: template.agentSteps.aiguillage!.timeoutSeconds,
        evalSetId: 500,
      }),
      actor,
    );
    expect(definitions.archive).not.toHaveBeenCalled();
    // Aucune autorisation d'outil : le service n'a aucune dépendance vers les autorisations (wf_tool_grant).
    expect(Object.keys(definitions).sort()).toEqual(['archive', 'create', 'upsertAgentConfig']);

    expect(audit.dataChange).toHaveBeenCalledTimes(1);
    const entry = (audit.dataChange.mock.calls[0] as unknown as [{ objectRef: string; newValue: string }])[0];
    expect(entry.objectRef).toBe('wf_definition:42');
    expect(JSON.parse(entry.newValue)).toEqual({
      action: 'template_instantiated',
      templateKey: TEMPLATE_KEYS.aiguilleur,
      templateSchemaVersion: template.schemaVersion,
      definitionId: 42,
    });
    expect(entry.newValue).not.toContain(template.graph.steps[0]!.name);
  });

  it('modèle sans IA : brouillon seulement (ni jeu d’évaluation ni configuration d’agent)', async () => {
    const { service, definitions, evals, audit } = build();
    await service.instantiate(TEMPLATE_KEYS.circuitVisaDocument, 'Visa du service', actor);
    expect((definitions.create.mock.calls[0]![0] as { name: string }).name).toBe('Visa du service');
    expect(definitions.upsertAgentConfig).not.toHaveBeenCalled();
    expect(evals.createSet).not.toHaveBeenCalled();
    expect(audit.dataChange).toHaveBeenCalledTimes(1);
  });

  it('collision de nom : réessaie avec « (2) », « (3) »', async () => {
    const base = ALL_TEMPLATES.find((t) => t.key === TEMPLATE_KEYS.demandeAvecChecklist)!.name;
    const { service, definitions } = build({ takenNames: [base, `${base} (2)`] });
    await service.instantiate(TEMPLATE_KEYS.demandeAvecChecklist, undefined, actor);
    const names = definitions.create.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual([base, `${base} (2)`, `${base} (3)`]);
  });

  it('collision persistante : 409 après 5 nouvelles tentatives, sans archivage (rien n’a été créé)', async () => {
    const base = 'Mon workflow';
    const names = [base, ...Array.from({ length: TEMPLATE_NAME_MAX_RETRIES }, (_, i) => `${base} (${i + 2})`)];
    const { service, definitions } = build({ takenNames: names });
    await expect(service.instantiate(TEMPLATE_KEYS.circuitVisaDocument, base, actor)).rejects.toBeInstanceOf(ConflictException);
    expect(definitions.create).toHaveBeenCalledTimes(1 + TEMPLATE_NAME_MAX_RETRIES);
    expect(definitions.archive).not.toHaveBeenCalled();
  });

  it('le suffixe respecte la longueur maximale du nom', async () => {
    const long = 'a'.repeat(200);
    const { service, definitions } = build({ takenNames: [long] });
    await service.instantiate(TEMPLATE_KEYS.circuitVisaDocument, long, actor);
    const second = (definitions.create.mock.calls[1]![0] as { name: string }).name;
    expect(second).toHaveLength(200);
    expect(second.endsWith(' (2)')).toBe(true);
  });

  it('outil absent ou désactivé (422 de la configuration) : brouillon archivé et erreur relancée telle quelle', async () => {
    const err = new UnprocessableEntityException('Outils inconnus ou désactivés : lire_organigramme_imputable.');
    const { service, definitions, audit } = build({ upsertError: err });
    await expect(service.instantiate(TEMPLATE_KEYS.aiguilleur, undefined, actor)).rejects.toBe(err);
    expect(definitions.archive).toHaveBeenCalledWith(42, actor);
    expect(audit.dataChange).not.toHaveBeenCalled();
  });

  it('un échec de l’archivage de nettoyage ne masque pas l’erreur d’origine', async () => {
    const err = new UnprocessableEntityException('Outils inconnus ou désactivés : x.');
    const { service, definitions } = build({ upsertError: err });
    definitions.archive.mockRejectedValueOnce(new Error('base indisponible'));
    await expect(service.instantiate(TEMPLATE_KEYS.relanceur, undefined, actor)).rejects.toBe(err);
  });

  it('un échec du jeu d’évaluation archive aussi le brouillon', async () => {
    const { service, definitions, evals } = build();
    const err = new Error('échec jeu');
    evals.createSet.mockRejectedValueOnce(err);
    await expect(service.instantiate(TEMPLATE_KEYS.controleur, undefined, actor)).rejects.toBe(err);
    expect(definitions.archive).toHaveBeenCalledWith(42, actor);
    expect(definitions.upsertAgentConfig).not.toHaveBeenCalled();
  });

  it('un échec du journal d’audit ne fait pas échouer l’instanciation', async () => {
    const { service, definitions, audit } = build();
    audit.dataChange.mockRejectedValueOnce(new Error('audit indisponible'));
    await expect(service.instantiate(TEMPLATE_KEYS.circuitVisaDocument, undefined, actor)).resolves.toEqual({ definitionId: 42 });
    expect(definitions.archive).not.toHaveBeenCalled();
  });
});
