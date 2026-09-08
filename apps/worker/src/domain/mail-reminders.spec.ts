import {
  dateButoireAlert,
  dateButoireMessage,
  daysUntil,
  shouldRemindInputation,
} from './mail-reminders';

describe('Rappels §03.5 — échéance courrier', () => {
  it('applique les paliers exacts du source', () => {
    expect(dateButoireAlert(7)).toBe('PREMIERE_ALERTE');
    expect(dateButoireAlert(3)).toBe('RAPPEL');
    expect(dateButoireAlert(1)).toBe('DERNIERE_CHANCE');
    expect(dateButoireAlert(0)).toBe('URGENCE');
    expect(dateButoireAlert(-1)).toBe('RETARD');
    expect(dateButoireAlert(-2)).toBe('RETARD');
    expect(dateButoireAlert(-3)).toBe('RETARD');
  });

  it('ne notifie pas hors paliers (le source ne relance pas à J-5 ni à J-2)', () => {
    for (const d of [10, 6, 5, 4, 2]) expect(dateButoireAlert(d)).toBeNull();
  });

  it('cesse de relancer au-delà de 3 jours de retard', () => {
    expect(dateButoireAlert(-4)).toBeNull();
    expect(dateButoireAlert(-30)).toBeNull();
  });

  it('daysUntil compare à la journée : l’heure ne décale pas le palier', () => {
    const now = new Date('2026-07-16T23:59:00.000Z');
    // Même si l'échéance est à 1 minute près, elle tombe le lendemain => 1 jour.
    expect(daysUntil(new Date('2026-07-17T00:00:00.000Z'), now)).toBe(1);
    expect(daysUntil(new Date('2026-07-16T00:01:00.000Z'), now)).toBe(0);
    expect(daysUntil(new Date('2026-07-23T06:00:00.000Z'), now)).toBe(7);
    expect(daysUntil(new Date('2026-07-13T06:00:00.000Z'), now)).toBe(-3);
  });

  it('le libellé porte le palier et l’objet', () => {
    expect(dateButoireMessage('URGENCE', 'Lettre A')).toContain('Lettre A');
    expect(dateButoireMessage('URGENCE', 'Lettre A')).toMatch(/[Uu]rgence/);
  });
});

describe('Rappels §03.5 — échéance d’imputation', () => {
  const now = new Date('2026-07-16T10:00:00.000Z');
  const inWindow = new Date('2026-07-17T10:00:00.000Z'); // +24 h, dans la fenêtre de 48 h

  it('relance une imputation jamais relancée dont l’échéance est dans la fenêtre', () => {
    expect(shouldRemindInputation({ deadline: inWindow, lastReminderSent: null }, now, 48, 6)).toBe(
      true,
    );
  });

  it('ignore une échéance au-delà de la fenêtre d’alerte', () => {
    const far = new Date('2026-07-20T10:00:00.000Z'); // +96 h
    expect(shouldRemindInputation({ deadline: far, lastReminderSent: null }, now, 48, 6)).toBe(
      false,
    );
  });

  it('ignore une échéance déjà passée (le source exige Deadline >= now)', () => {
    const past = new Date('2026-07-16T09:59:00.000Z');
    expect(shouldRemindInputation({ deadline: past, lastReminderSent: null }, now, 48, 6)).toBe(
      false,
    );
  });

  it('respecte l’intervalle anti-spam de 6 h', () => {
    const recent = new Date('2026-07-16T06:00:00.000Z'); // il y a 4 h
    expect(
      shouldRemindInputation({ deadline: inWindow, lastReminderSent: recent }, now, 48, 6),
    ).toBe(false);
    const old = new Date('2026-07-16T04:00:00.000Z'); // il y a 6 h pile
    expect(shouldRemindInputation({ deadline: inWindow, lastReminderSent: old }, now, 48, 6)).toBe(
      true,
    );
  });

  it('sans échéance, aucun rappel', () => {
    expect(shouldRemindInputation({ deadline: null, lastReminderSent: null }, now, 48, 6)).toBe(
      false,
    );
  });

  it('honore une fenêtre et un intervalle reconfigurés', () => {
    // Fenêtre réduite à 12 h : une échéance à +24 h sort du périmètre.
    expect(shouldRemindInputation({ deadline: inWindow, lastReminderSent: null }, now, 12, 6)).toBe(
      false,
    );
  });
});
