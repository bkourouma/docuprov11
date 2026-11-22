import { WF_TRIGGER_MAX_CONSECUTIVE_FAILURES } from '../domain/contracts';
import { TriggerFailureTracker, WF_TRIGGER_TRACKER_MAX_ENTRIES } from './trigger-failure-tracker';

describe('TriggerFailureTracker', () => {
  it('compte les échecs consécutifs et atteint le seuil', () => {
    const t = new TriggerFailureTracker();
    t.observe(1, 1000);
    for (let i = 1; i < WF_TRIGGER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      expect(t.fail(1, 'launcher_inactive')).toBe(i);
      expect(t.reached(1)).toBe(false);
    }
    expect(t.fail(1, 'launcher_inactive')).toBe(WF_TRIGGER_MAX_CONSECUTIVE_FAILURES);
    expect(t.reached(1)).toBe(true);
    expect(t.lastReason(1)).toBe('launcher_inactive');
  });

  it('success remet le compteur à zéro', () => {
    const t = new TriggerFailureTracker();
    t.observe(1, 1000);
    t.fail(1, 'x');
    t.fail(1, 'x');
    t.success(1);
    expect(t.count(1)).toBe(0);
    expect(t.reached(1)).toBe(false);
  });

  it("observe remet à zéro si l'horodatage de mise à jour a changé, pas sinon", () => {
    const t = new TriggerFailureTracker();
    t.observe(1, 1000);
    t.fail(1, 'x');
    t.fail(1, 'x');
    t.observe(1, 1000);
    expect(t.count(1)).toBe(2);
    t.observe(1, 2000);
    expect(t.count(1)).toBe(0);
  });

  it('les déclencheurs sont indépendants', () => {
    const t = new TriggerFailureTracker();
    t.observe(1, 1);
    t.observe(2, 1);
    t.fail(1, 'x');
    expect(t.count(2)).toBe(0);
  });

  it("borne la mémoire à 10 000 entrées et garde les séries d'échecs en cours", () => {
    const t = new TriggerFailureTracker();
    t.observe(1, 1);
    t.fail(1, 'x');
    for (let i = 2; i < WF_TRIGGER_TRACKER_MAX_ENTRIES + 500; i += 1) t.observe(i, 1);
    expect(t.size).toBeLessThanOrEqual(WF_TRIGGER_TRACKER_MAX_ENTRIES);
    expect(t.count(1)).toBe(1);
  });
});
