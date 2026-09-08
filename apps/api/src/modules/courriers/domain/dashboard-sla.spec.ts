import { MailType } from '@archivage/types';
import { agregerSla, dureeApplicable, evalSla } from './dashboard-sla';

describe('dureeApplicable', () => {
  it('retient la durée interne pour un courrier Interne, externe sinon', () => {
    expect(dureeApplicable(MailType.Interne, 30, 10)).toBe(10);
    expect(dureeApplicable(MailType.Arrivee, 30, 10)).toBe(30);
    expect(dureeApplicable(MailType.Depart, 30, 10)).toBe(30);
  });

  it('traite 0 comme « non configuré », jamais comme une échéance immédiate', () => {
    // C'est LA règle à ne pas casser : `0` est la valeur par défaut du référentiel. L'interpréter
    // comme un délai nul classerait la totalité du courrier en hors-délai (§3.8).
    expect(dureeApplicable(MailType.Arrivee, 0, 0)).toBeNull();
    expect(dureeApplicable(MailType.Interne, 30, 0)).toBeNull();
  });

  it('traite null comme non configuré', () => {
    expect(dureeApplicable(MailType.Arrivee, null, null)).toBeNull();
  });
});

describe('evalSla (KPI C4)', () => {
  it('classe dans les délais quand le délai est inférieur ou égal à la durée', () => {
    expect(evalSla(5, MailType.Arrivee, 10, null).dansLesDelais).toBe(true);
    // Le jour de l'échéance compte encore comme respecté.
    expect(evalSla(10, MailType.Arrivee, 10, null).dansLesDelais).toBe(true);
  });

  it('classe hors délais au-delà de la durée', () => {
    expect(evalSla(11, MailType.Arrivee, 10, null).dansLesDelais).toBe(false);
  });

  it("n'évalue pas un courrier dont l'objet n'a pas de durée configurée", () => {
    const r = evalSla(99, MailType.Arrivee, 0, 0);
    expect(r.configure).toBe(false);
    expect(r.dansLesDelais).toBeNull();
    expect(r.dureeRetenue).toBeNull();
  });

  it("n'évalue pas un courrier non archivé, même si la durée est configurée", () => {
    const r = evalSla(null, MailType.Arrivee, 10, null);
    expect(r.configure).toBe(true);
    expect(r.dansLesDelais).toBeNull();
  });
});

describe('agregerSla', () => {
  it('ventile succès, échecs et non évalués sans en perdre', () => {
    const evaluations = [
      evalSla(5, MailType.Arrivee, 10, null), // dans les délais
      evalSla(20, MailType.Arrivee, 10, null), // hors délais
      evalSla(5, MailType.Arrivee, 0, 0), // non configuré
      evalSla(null, MailType.Arrivee, 10, null), // non archivé
    ];

    const r = agregerSla(evaluations);
    expect(r).toEqual({ configure: true, dansLesDelais: 1, horsDelais: 1, nonEvalues: 2 });
    expect(r.dansLesDelais + r.horsDelais + r.nonEvalues).toBe(evaluations.length);
  });

  it('rend configure=false quand aucun courrier n’est évaluable', () => {
    // Cas réel aujourd'hui : mail_objet ne contient que 2 lignes, durées à 0. Le widget doit
    // afficher « SLA non configuré » plutôt qu'un graphique vide (arbitrage 2).
    const r = agregerSla([evalSla(5, MailType.Arrivee, 0, 0), evalSla(9, MailType.Depart, 0, 0)]);
    expect(r.configure).toBe(false);
    expect(r.nonEvalues).toBe(2);
  });

  it('rend un agrégat neutre sur un échantillon vide', () => {
    expect(agregerSla([])).toEqual({
      configure: false,
      dansLesDelais: 0,
      horsDelais: 0,
      nonEvalues: 0,
    });
  });
});
