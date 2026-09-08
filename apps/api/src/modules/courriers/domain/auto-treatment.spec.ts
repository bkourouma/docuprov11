import { MailStatus } from '@archivage/types';
import {
  allInputationsProcessed,
  computeAutomaticValidation,
  computeManualTreatment,
  type InputationView,
} from './auto-treatment';

const now = new Date('2026-07-15T10:00:00.000Z');
const past = new Date('2026-06-01T00:00:00.000Z');

function inp(id: number, suivi: boolean, treated: Date | null = null): InputationView {
  return { mailInputationId: id, suivi, dateTreated: treated };
}

describe('auto-treatment (§03.1 / quirk §03.6-2)', () => {
  describe('allInputationsProcessed', () => {
    it('faux si la liste est vide', () => {
      expect(allInputationsProcessed([])).toBe(false);
    });
    it('vrai si toutes traitées', () => {
      expect(allInputationsProcessed([inp(1, false, past), inp(2, true, past)])).toBe(true);
    });
    it('faux si au moins une non traitée', () => {
      expect(allInputationsProcessed([inp(1, false, past), inp(2, true, null)])).toBe(false);
    });
  });

  describe('computeAutomaticValidation', () => {
    it('ne traite QUE les imputations non traitées de type suivi==true', () => {
      const r = computeAutomaticValidation([inp(1, true), inp(2, false), inp(3, true, past)], now);
      expect(r.inputationsToTreat).toEqual([1]); // 2=suivi false ignoré, 3 déjà traité
    });

    it('bascule en Traité (+DateTraited) si toutes deviennent traitées', () => {
      const r = computeAutomaticValidation([inp(1, true), inp(2, true, past)], now);
      expect(r.inputationsToTreat).toEqual([1]);
      expect(r.allTreated).toBe(true);
      expect(r.mailPatch).toEqual({ status: MailStatus.Traite, dateTraited: now });
    });

    it('ne bascule pas si une imputation suivi==false reste non traitée', () => {
      const r = computeAutomaticValidation([inp(1, true), inp(2, false)], now);
      expect(r.inputationsToTreat).toEqual([1]);
      expect(r.allTreated).toBe(false);
      expect(r.mailPatch).toBeNull();
    });

    it('liste vide → rien à traiter, pas de bascule', () => {
      const r = computeAutomaticValidation([], now);
      expect(r).toEqual({ inputationsToTreat: [], allTreated: false, mailPatch: null });
    });
  });

  describe('computeManualTreatment', () => {
    it('traite TOUTES les imputations non traitées et bascule en Traité', () => {
      const r = computeManualTreatment([inp(1, false), inp(2, true, past), inp(3, false)], now);
      expect(r.inputationsToTreat).toEqual([1, 3]);
      expect(r.allTreated).toBe(true);
      expect(r.mailPatch).toEqual({ status: MailStatus.Traite, dateTraited: now });
    });
  });
});
