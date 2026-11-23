import { test, expect } from '../../../fixtures';

/**
 * Journal d'audit (SOC-89).
 *
 * État constaté : `AuditService` (apps/api/src/modules/audit/audit.service.ts) ne fait qu'ÉCRIRE
 * les deux journaux (`navigation_audit`, `data_change_audit`). Aucun contrôleur ne les expose en
 * consultation globale, et aucun écran web ne les liste : la seule lecture existante est l'onglet
 * « Historique » d'UN document (`document-tabs.service.ts`, objets `document:{id}`), hors périmètre.
 * De plus, ni le paramétrage e-mail ni l'agencement des tableaux de bord n'écrivent au journal.
 *
 * QUESTION MÉTIER (Q-D3) : faut-il un écran de consultation du journal, et les changements de
 * paramétrage e-mail doivent-ils y figurer ? Ce scénario fige l'attente si la réponse est oui.
 */
test.fixme('SOC-89 journal d’audit non exposé : une modification du gabarit e-mail y serait tracée (Q-D3)', async ({
  api,
  uniq,
}) => {
  const org = uniq('Organisation');
  await api.put('/parametres/email-template', { orgName: org });

  // Endpoint HYPOTHÉTIQUE : aucun n'existe aujourd'hui. À remplacer par le contrat retenu.
  const journal = (await api.get('/audit/data-changes?objectRef=email-template')) as Array<{
    newValue: string | null;
  }>;
  expect(journal.some((e) => (e.newValue ?? '').includes(org))).toBe(true);
});
