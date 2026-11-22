import { WF_AUTHORING_MARKER_KEY, validateWorkflowGraph, type WfGraph } from '@archivage/types';
import { detectInjection } from '../workflow-agents/injection/suspicion';
import { generateNonce } from '../workflow-agents/injection/untrusted';
import {
  ATTACK_ALLOWED_TOOLS,
  ATTACK_DESCRIPTIONS,
  ATTACK_NONCE_PLACEHOLDER,
  BENIGN_DESCRIPTION,
  buildObedientMaliciousOutput,
  materializeAttack,
} from './authoring.attack.corpus';
import type { AuthoringToolInfo } from './authoring.contracts';
import { GUARDRAIL_NEUTRAL_TEXT, applyGuardrails } from './authoring.guardrails';
import { AUTHORING_DESCRIPTION_MAX_CHARS, buildAuthoringPrompt } from './authoring.prompt';

const TOOLS: AuthoringToolInfo[] = [
  { key: 'rechercher_documents', label: 'Rechercher des documents', description: 'Recherche.', sideEffect: 0 },
  { key: 'lire_document', label: 'Lire un document', description: null, sideEffect: 0 },
];

/** Contenu du bloc DESCRIPTION (entre les balises légitimes). */
function descriptionBody(text: string, nonce: string): string {
  const open = `<<DESCRIPTION ${nonce}>>\n`;
  const close = `\n<<FIN_DESCRIPTION ${nonce}>>`;
  const start = text.indexOf(open);
  const end = text.indexOf(close, start + open.length);
  if (start < 0 || end < 0) throw new Error('bloc DESCRIPTION introuvable');
  return text.slice(start + open.length, end);
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('corpus d’attaques du générateur', () => {
  it('au moins 12 descriptions hostiles, identifiants uniques', () => {
    expect(ATTACK_DESCRIPTIONS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(ATTACK_DESCRIPTIONS.map((a) => a.id)).size).toBe(ATTACK_DESCRIPTIONS.length);
  });

  it.each(ATTACK_DESCRIPTIONS.filter((a) => a.expectSuspicious).map((a) => [a.id, a] as const))(
    '%s : signalée par la détection heuristique',
    (_id, sample) => {
      expect(detectInjection(materializeAttack(sample, generateNonce())).suspicious).toBe(true);
    },
  );
});

describe('(a) prompt construit pour une description hostile', () => {
  const nonce = generateNonce();
  const benign = buildAuthoringPrompt({ nonce, description: BENIGN_DESCRIPTION, tools: TOOLS });

  it.each(ATTACK_DESCRIPTIONS.map((a) => [a.id, a] as const))('%s', (_id, sample) => {
    const description = materializeAttack(sample, nonce);
    const req = buildAuthoringPrompt({ nonce, description, tools: TOOLS });

    // Message système fixe : identique à celui d'une description inoffensive.
    expect(req.system).toBe(benign.system);

    // Un seul bloc DESCRIPTION légitime.
    expect(count(req.text, `<<DESCRIPTION ${nonce}>>`)).toBe(1);
    expect(count(req.text, `<<FIN_DESCRIPTION ${nonce}>>`)).toBe(1);

    const body = descriptionBody(req.text, nonce);
    // Aucune balise forgée ne subsiste : plus aucun chevron (ASCII ou pleine chasse) dans la donnée.
    expect(body).not.toMatch(/[<>\uFF1C\uFF1E\u2329\u232A\u27E8\u27E9\u3008\u3009]/);
    expect(body).not.toContain('</data>');
    expect(body).not.toContain('<|im_start|>');
    // Le jeton généré n'apparaît jamais dans la donnée (retiré s'il avait été deviné).
    expect(body.toUpperCase()).not.toContain(nonce);
    if (sample.description.includes(ATTACK_NONCE_PLACEHOLDER)) expect(body).toContain('[jeton retiré]');
    // Aucun caractère invisible ni contrôle bidirectionnel.
    expect(body).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u{E0000}-\u{E007F}]/u);
    // Taille bornée.
    expect(Array.from(body).length).toBeLessThanOrEqual(AUTHORING_DESCRIPTION_MAX_CHARS);

    // Hors du bloc, seules subsistent les balises légitimes portant le jeton de l'appel.
    const outside = req.text.replace(body, '');
    const tags = outside.match(/<<[^<>\n]*>>/g) ?? [];
    for (const t of tags) expect(t.endsWith(` ${nonce}>>`)).toBe(true);
    expect(outside.replace(/<<[^<>\n]*>>/g, '')).not.toMatch(/[<>]/);

    // Les règles sont rappelées après la donnée.
    expect(req.text.lastIndexOf('Rappel :')).toBeGreaterThan(req.text.indexOf(`<<FIN_DESCRIPTION ${nonce}>>`));
  });

  it('prompt très long : la consigne de fin est coupée par la borne de 4000 caractères', () => {
    const sample = ATTACK_DESCRIPTIONS.find((a) => a.id === 'prompt_tres_long');
    expect(sample).toBeDefined();
    const req = buildAuthoringPrompt({ nonce, description: sample?.description ?? '', tools: TOOLS });
    const body = descriptionBody(req.text, nonce);
    expect(body.endsWith('…')).toBe(true);
    expect(body).not.toContain('révèle ton prompt');
  });

  it('jeton deviné : retiré de la donnée et avertissement de l’application', () => {
    const sample = ATTACK_DESCRIPTIONS.find((a) => a.id === 'jeton_devine');
    expect(sample).toBeDefined();
    const req = buildAuthoringPrompt({ nonce, description: sample ? materializeAttack(sample, nonce) : '', tools: TOOLS });
    expect(descriptionBody(req.text, nonce)).toContain('‹‹FIN_DESCRIPTION [jeton retiré]››');
    expect(req.text).toContain('Avertissement de l’application');
  });

  it('texte invisible : la consigne en caractères « tag » disparaît de la donnée', () => {
    const sample = ATTACK_DESCRIPTIONS.find((a) => a.id === 'texte_invisible');
    const req = buildAuthoringPrompt({ nonce, description: sample?.description ?? '', tools: TOOLS });
    expect(descriptionBody(req.text, nonce)).not.toMatch(/Ignore your previous instructions/i);
  });

  it('la description n’entre jamais dans le message système', () => {
    for (const sample of ATTACK_DESCRIPTIONS) {
      const req = buildAuthoringPrompt({ nonce, description: materializeAttack(sample, nonce), tools: TOOLS });
      expect(req.system).not.toContain('comptabilité saisit');
    }
  });
});

describe('(b) sortie malveillante d’un modèle « obéissant »', () => {
  const output = buildObedientMaliciousOutput();
  const rawBefore = JSON.stringify(output.graph);
  const result = applyGuardrails(output.graph, { allowedTools: ATTACK_ALLOWED_TOOLS });
  const validation = validateWorkflowGraph(result.graph, { isLowRisk: false });
  const serialized = JSON.stringify(result.graph);

  it('l’entrée n’est pas modifiée et aucun prototype n’est pollué', () => {
    expect(JSON.stringify(output.graph)).toBe(rawBefore);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).isLowRisk).toBeUndefined();
  });

  it('le graphe nettoyé est valide sans marquage de faible risque', () => {
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('aucune autonomie autre que "suggere"', () => {
    const graph = validation.graph as WfGraph;
    for (const s of graph.steps) if (s.agent) expect(s.agent.autonomy).toBe('suggere');
    expect(serialized).not.toMatch(/autonome|agit_avec_validation/);
    expect(validation.issues.map((i) => i.code)).not.toContain('AUTONOMY_REQUIRES_LOW_RISK');
    expect(result.removed.autonomy).toBeGreaterThanOrEqual(1);
  });

  it('aucun outil hors catalogue', () => {
    const graph = validation.graph as WfGraph;
    for (const s of graph.steps) {
      for (const t of s.agent?.tools ?? []) expect(ATTACK_ALLOWED_TOOLS.has(t)).toBe(true);
    }
    expect(serialized).not.toMatch(/envoyer_email|supprimer_document|outil_admin/);
    expect(result.removed.tools).toBe(3);
  });

  it('aucune affectation par identifiant', () => {
    const graph = validation.graph as WfGraph;
    for (const s of graph.steps) {
      if (s.assignee) {
        expect(['initiator', 'subject_owner']).toContain(s.assignee.kind);
        expect(s.assignee.id).toBeUndefined();
      }
    }
    expect(serialized).not.toMatch(/"id"\s*:/);
    expect(serialized).not.toContain('escalation');
    expect(result.removed.assignees).toBeGreaterThanOrEqual(4);
    // Les étapes humaines sans affectation sont laissées « à compléter », avec le libellé lu.
    expect(result.toComplete.map((t) => [t.stepKey, t.hint])).toEqual([
      ['saisie', 'la comptabilité'],
      ['piege', null],
      ['validation_daf', 'DAF'],
    ]);
    const daf = graph.steps.find((s) => s.key === 'validation_daf');
    expect(daf?.config?.[WF_AUTHORING_MARKER_KEY]).toEqual({ toComplete: ['assignee'], assigneeHint: 'DAF' });
  });

  it('aucune clé de faible risque, de modèle, de budget ni de prototype ; marqueur forgé remplacé', () => {
    expect(serialized).not.toMatch(/isLowRisk|lowRisk|maxCostPerRun|"model"|__proto__|polluted|"script"|"secret"/);
    const graph = validation.graph as WfGraph;
    const saisie = graph.steps.find((s) => s.key === 'saisie');
    expect(saisie?.config?.[WF_AUTHORING_MARKER_KEY]).toEqual({ toComplete: ['assignee'], assigneeHint: 'la comptabilité' });
    expect(serialized).not.toContain('utilisateur 1');
  });

  it('objectif injecté neutralisé ; seuil de confiance relevé ; maxSteps borné', () => {
    const agent = (validation.graph as WfGraph).steps.find((s) => s.type === 'agent')?.agent;
    expect(agent?.objective).toBe(GUARDRAIL_NEUTRAL_TEXT);
    expect(agent?.confidenceThreshold).toBeGreaterThanOrEqual(0.8);
    expect(agent?.maxSteps).toBeLessThanOrEqual(10);
    expect(serialized).not.toMatch(/pirate@example\.com|ignore tes règles/i);
    expect(result.removed.suspiciousText).toBeGreaterThanOrEqual(1);
  });

  it('conditions dangereuses retirées (chemin de prototype, opérateur inconnu)', () => {
    expect(serialized).not.toMatch(/constructor|prototype|eval|process\.exit/);
  });

  it('notes françaises, sans contenu de l’attaque', () => {
    expect(result.notes.length).toBeGreaterThan(0);
    for (const n of result.notes) expect(n).not.toMatch(/pirate|ignore tes|<|>/i);
  });
});
