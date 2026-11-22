import { asstClarificationSchema, type AsstClarificationDto } from '@archivage/types';

// Format de repli d'une question de précision dans `content` d'un message assistant (aucune table ne stocke
// `clarification` : elle est relue depuis ce texte). Forme : la question, une ligne vide, puis une liste numérotée
// « 1. choix », « 2. choix »… (une ligne par choix). `parseClarificationContent` lit exactement ce format.

const CHOICE_LINE = /^(\d{1,2})\. (.+)$/;

/** Texte affiché (et stocké) pour une question de précision. */
export function formatClarificationContent(question: string, choices: readonly string[]): string {
  return `${question.trim()}\n\n${choices.map((c, i) => `${i + 1}. ${c.trim()}`).join('\n')}`;
}

/**
 * Relit la question de précision depuis `content` ; `null` si le texte n'a pas exactement le format
 * (question, ligne vide, liste numérotée de 2 à 6 choix valides jusqu'à la fin du texte).
 */
export function parseClarificationContent(content: string): AsstClarificationDto | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  let start = lines.length;
  while (start > 0 && CHOICE_LINE.test(lines[start - 1] ?? '')) start--;
  const choiceLines = lines.slice(start);
  if (choiceLines.length < 2 || start < 2 || (lines[start - 1] ?? '') !== '') return null;
  const choices: string[] = [];
  for (let i = 0; i < choiceLines.length; i++) {
    const m = CHOICE_LINE.exec(choiceLines[i] ?? '');
    if (!m || Number(m[1]) !== i + 1) return null;
    choices.push((m[2] ?? '').trim());
  }
  const question = lines.slice(0, start - 1).join('\n').trim();
  const parsed = asstClarificationSchema.safeParse(question ? { question, choices } : { choices });
  return parsed.success ? parsed.data : null;
}
