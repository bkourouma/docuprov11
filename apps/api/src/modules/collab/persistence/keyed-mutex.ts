/**
 * Exclusion mutuelle par clé (ici : l'identifiant du document), dans le processus. Sérialise les
 * créations de version et les écritures d'état de travail d'un même document, sans bloquer les
 * autres. Une tâche en échec libère toujours la clé pour la suivante.
 */
export class KeyedMutex {
  private readonly tails = new Map<number, Promise<void>>();

  async run<T>(key: number, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      // Ménage : on ne garde la clé que si personne d'autre n'attend derrière nous.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
