import { MailType } from '@archivage/types';
import { dateArchivage, delaiTraitementJours, estArchive, joursEntre } from './dashboard-archivage';

const DECHARGE = new Date('2026-03-10T08:00:00Z');
const TRAITE = new Date('2026-03-20T08:00:00Z');

describe('dateArchivage (§3.7)', () => {
  it('retient dateDecharge pour un Départ', () => {
    expect(dateArchivage(MailType.Depart, DECHARGE, TRAITE)).toBe(DECHARGE);
  });

  it('retient dateTraited pour une Arrivée et un Interne', () => {
    expect(dateArchivage(MailType.Arrivee, DECHARGE, TRAITE)).toBe(TRAITE);
    expect(dateArchivage(MailType.Interne, DECHARGE, TRAITE)).toBe(TRAITE);
  });

  it("considère un Départ « Rédigé » comme archivé alors qu'il n'a jamais été déchargé", () => {
    // Quirk §3.1 : `markDepartRedige` stampe dateDecharge au passage à Rédigé. Le source s'en sert
    // comme date d'archivage du Départ — ce n'est donc pas un bug à corriger ici.
    expect(estArchive(MailType.Depart, DECHARGE, null)).toBe(true);
  });

  it("n'archive pas une Arrivée déchargée mais non traitée", () => {
    // Le symétrique : sans dateTraited, une Arrivée reste « en cours », même avec une décharge.
    expect(estArchive(MailType.Arrivee, DECHARGE, null)).toBe(false);
  });

  it('rend null quand la date pertinente manque', () => {
    expect(dateArchivage(MailType.Depart, null, TRAITE)).toBeNull();
    expect(dateArchivage(MailType.Arrivee, DECHARGE, null)).toBeNull();
  });
});

describe('delaiTraitementJours (KPI C3)', () => {
  it("mesure l'écart en jours entre enregistrement et archivage", () => {
    expect(delaiTraitementJours(new Date('2026-03-01T09:00:00Z'), TRAITE)).toBe(19);
  });

  it("ignore l'heure de la journée", () => {
    // 23h58 puis 00h02 le lendemain = 1 jour, pas 0 : on compare des dates civiles.
    expect(
      delaiTraitementJours(new Date('2026-03-01T23:58:00Z'), new Date('2026-03-02T00:02:00Z')),
    ).toBe(1);
  });

  it('rend null si une borne manque — un délai partiel serait un chiffre faux', () => {
    expect(delaiTraitementJours(null, TRAITE)).toBeNull();
    expect(delaiTraitementJours(TRAITE, null)).toBeNull();
  });

  it('laisse passer un délai négatif sans le masquer', () => {
    // Archivage antérieur à l'enregistrement : incohérence réelle, que l'hygiène doit voir.
    expect(delaiTraitementJours(TRAITE, DECHARGE)).toBe(-10);
  });
});

describe('joursEntre', () => {
  it('compte en jours calendaires UTC', () => {
    expect(joursEntre(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T23:59:59Z'))).toBe(0);
    expect(joursEntre(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-08T00:00:00Z'))).toBe(7);
  });
});
