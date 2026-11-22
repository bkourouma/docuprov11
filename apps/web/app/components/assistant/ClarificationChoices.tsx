'use client';

// Questions de précision de l'assistant : choix rendus en boutons natifs. Rien n'est envoyé sans clic.
// Texte uniquement (échappé par React). CSS : ./assistant-card.css (importé par le drawer).

export interface ClarificationChoicesProps {
  question?: string | null;
  choices: string[];
  disabled?: boolean;
  onChoose: (choice: string) => void;
}

export function ClarificationChoices({ question, choices, disabled, onChoose }: ClarificationChoicesProps) {
  const list = (Array.isArray(choices) ? choices : []).filter((c) => typeof c === 'string' && c.trim() !== '');
  if (list.length === 0) return null;
  return (
    <div className="asst-choices">
      {typeof question === 'string' && question.trim() !== '' && <p className="asst-choices-question">{question}</p>}
      <div role="group" aria-label="Choix proposés" className="asst-choices-list">
        {list.map((c, i) => (
          <button
            key={`${i}-${c}`}
            type="button"
            className="asst-choice"
            disabled={disabled}
            onClick={() => {
              if (!disabled) onChoose(c);
            }}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
