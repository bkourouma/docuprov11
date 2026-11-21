import { editeurApi, type GedCollabMentionCandidate } from '../../lib/editeur';
import styles from './editeur.module.css';

/** Délai avant l'appel API : on n'interroge pas le serveur à chaque frappe. */
export const MENTION_DEBOUNCE_MS = 250;

export const MENTION_HELP = 'Mentionner une personne ne lui donne pas accès au document.';

/**
 * Recherche débouncée et annulable. Un nouvel appel annule le minuteur ET la requête en vol du
 * précédent ; l'appel remplacé se résout avec les derniers résultats connus (pas de clignotement
 * « liste vide » entre deux frappes).
 */
export function createDebouncedSearch<T>(
  fetcher: (q: string, signal: AbortSignal) => Promise<T[]>,
  delay = MENTION_DEBOUNCE_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;
  let last: T[] = [];
  let settlePrevious: (() => void) | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    ctrl?.abort();
    ctrl = null;
    settlePrevious?.();
    settlePrevious = null;
  };

  return {
    search(q: string): Promise<T[]> {
      cancel();
      return new Promise<T[]>((resolve) => {
        settlePrevious = () => resolve(last);
        timer = setTimeout(() => {
          timer = null;
          const c = new AbortController();
          ctrl = c;
          fetcher(q, c.signal)
            .then((items) => {
              if (c.signal.aborted) return;
              last = items;
              settlePrevious = null;
              resolve(items);
            })
            .catch(() => {
              if (c.signal.aborted) return;
              settlePrevious = null;
              resolve(last);
            });
        }, delay);
      });
    },
    cancel,
  };
}

/** Source de candidats de mention d'un document (GET /collab/documents/:id/mention-candidates). */
export function createMentionSearch(documentId: number) {
  return createDebouncedSearch<GedCollabMentionCandidate>((q, signal) =>
    editeurApi.mentionCandidates(documentId, q, signal),
  );
}

interface SuggestionRenderProps {
  items: GedCollabMentionCandidate[];
  command: (attrs: { id: string; label: string }) => void;
  clientRect?: (() => DOMRect | null) | null;
  editor: { view: { dom: Element } };
}

let popupSeq = 0;

/**
 * Option `suggestion` du nœud mention (Tiptap) : liste ARIA (listbox) rendue en DOM natif, sans
 * dépendance React. Le texte d'aide rappelle qu'une mention n'ouvre aucun droit.
 */
export function createMentionSuggestion(documentId: number) {
  const source = createMentionSearch(documentId);

  return {
    char: '@',
    allowSpaces: false,
    items: ({ query }: { query: string }) => source.search(query),
    render: () => {
      let root: HTMLDivElement | null = null;
      let list: HTMLUListElement | null = null;
      let props: SuggestionRenderProps | null = null;
      let selected = 0;
      const listId = `mention-list-${++popupSeq}`;

      const place = () => {
        if (!root || !props?.clientRect) return;
        const rect = props.clientRect();
        if (!rect) return;
        root.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 280))}px`;
        root.style.top = `${rect.bottom + 6}px`;
      };

      const pick = (index: number) => {
        const item = props?.items[index];
        if (item && props) props.command({ id: String(item.userGroupId), label: item.name });
      };

      const paint = () => {
        if (!root || !list || !props) return;
        list.textContent = '';
        if (props.items.length === 0) {
          const li = document.createElement('li');
          li.className = styles.mentionEmpty ?? '';
          li.setAttribute('role', 'presentation');
          li.textContent = 'Aucune personne trouvée';
          list.appendChild(li);
          return;
        }
        props.items.forEach((item, i) => {
          const li = document.createElement('li');
          li.id = `${listId}-${i}`;
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', String(i === selected));
          li.className = styles.mentionItem ?? '';
          li.textContent = item.name; // textContent : jamais d'HTML issu des données
          li.addEventListener('mousedown', (e) => {
            e.preventDefault(); // garde le focus dans l'éditeur
            pick(i);
          });
          list!.appendChild(li);
        });
        list.setAttribute('aria-activedescendant', `${listId}-${selected}`);
      };

      return {
        onStart(p: SuggestionRenderProps) {
          props = p;
          selected = 0;
          root = document.createElement('div');
          root.className = styles.mentionPopup ?? '';
          list = document.createElement('ul');
          list.id = listId;
          list.className = styles.mentionList ?? '';
          list.setAttribute('role', 'listbox');
          list.setAttribute('aria-label', 'Personnes à mentionner');
          const help = document.createElement('p');
          help.className = styles.mentionHelp ?? '';
          help.textContent = MENTION_HELP;
          root.append(list, help);
          // Dans le shell (là où vivent les variables du thème), sinon dans le body.
          const host = p.editor.view.dom.closest('[data-editeur-root]') ?? document.body;
          host.appendChild(root);
          paint();
          place();
        },
        onUpdate(p: SuggestionRenderProps) {
          props = p;
          selected = Math.min(selected, Math.max(0, p.items.length - 1));
          paint();
          place();
        },
        onKeyDown({ event }: { event: KeyboardEvent }) {
          if (!props) return false;
          const n = props.items.length;
          if (event.key === 'ArrowDown' && n > 0) {
            selected = (selected + 1) % n;
            paint();
            return true;
          }
          if (event.key === 'ArrowUp' && n > 0) {
            selected = (selected + n - 1) % n;
            paint();
            return true;
          }
          if ((event.key === 'Enter' || event.key === 'Tab') && n > 0) {
            pick(selected);
            return true;
          }
          return false; // Échap : Tiptap ferme la suggestion
        },
        onExit() {
          source.cancel();
          root?.remove();
          root = null;
          list = null;
          props = null;
        },
      };
    },
  };
}
