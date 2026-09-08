// Fiche d'Imputation (§09) — table de substitution du gabarit. Logique PURE : aucune I/O, aucun
// zip, aucun rendu. C'est ici que vit la fidélité au source, et c'est ce que couvrent les tests.
//
// Les règles ci-dessous ne sont PAS déductibles du seul gabarit ; elles sont relevées du source
// (`MailTabsController.GenerateFicheImputation`) et sont contre-intuitives :
//   1. `%description%` ne reçoit PAS la description du courrier mais le NOM DU FICHIER JOINT, sans
//      extension (le libellé du gabarit est « Pièces jointes »).
//   2. Deux gabarits : si le courrier n'a aucune imputation « réelle » (hors « En Copie »), on bascule
//      sur `FICHE_IMPUTATION - Copie.docx`, un formulaire vierge à remplir à la main — et on
//      n'injecte alors NI %imputations%, NI %instructions%, NI %datebutoire%, NI %copies%
//      (ce gabarit ne les porte pas).
//   3. Sur le gabarit normal, un %imputations% vide est remplacé par la liste de TOUS les rôles en
//      cases à cocher (« ☐ Rôle »), et un %instructions% vide par tous les types d'imputation
//      (« - ☐ Type ») : la fiche imprimée sert alors de bordereau à cocher.

/** Libellé du type d'imputation « en copie » — c'est sur le NOM que le source discrimine. */
const EN_COPIE = 'En Copie';

export interface FicheImputationRow {
  typeName: string;
  userFullName: string | null;
  instructions: string | null;
  deadline: Date | null;
}

export interface FicheHistoriqueRow {
  date: Date;
  userName: string | null;
  actionName: string | null;
  details: string | null;
}

export interface FicheInputs {
  dateEnregistrementCourrier: Date | null;
  date: Date | null;
  nReference: string | null;
  reference: string | null;
  externalEntityName: string | null;
  destinataireFullName: string | null;
  title: string;
  /** Nom du 1er fichier joint, SANS extension — alimente %description% (cf. règle 1). */
  attachedFileName: string;
  imputations: readonly FicheImputationRow[];
  userCreated: string | null;
  historique: readonly FicheHistoriqueRow[];
  /** Repli de %imputations% quand aucune imputation ne le renseigne (cf. règle 3). */
  allRoleNames: readonly string[];
  /** Repli de %instructions% dans le même cas. */
  allInputationTypeNames: readonly string[];
  now: Date;
}

export interface FicheRender {
  /** Gabarit à remplir (cf. règle 2). */
  template: 'FICHE_IMPUTATION.docx' | 'FICHE_IMPUTATION - Copie.docx';
  replacements: Record<string, string>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `dd/MM/yyyy` — format du source. Vide si la date est absente. */
export function frDate(d: Date | null | undefined): string {
  if (!d) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** `dd/MM/yyyy HH:mm` — format du source pour l'historique et %date_traitement%. */
export function frDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  return `${frDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const blank = (s: string) => s.trim().length === 0;

/**
 * Ligne d'historique du gabarit (`%grid_historique%`) : en-tête + lignes séparées par des
 * tabulations doubles. Malgré le nom « grid », le source n'insère PAS un vrai tableau Word — c'est
 * du texte tabulé (`BuildHistoriqueTableAsText`). On reste fidèle à ce choix.
 */
export function buildHistoriqueGrid(rows: readonly FicheHistoriqueRow[]): string {
  if (rows.length === 0) return 'Aucun historique disponible';
  const header = 'Date/Heure\t\tUtilisateur\t\tAction\t\tDétails';
  const lines = rows.map(
    (r) =>
      `${frDateTime(r.date)}\t\t${r.userName ?? ''}\t\t${r.actionName ?? ''}\t\t${r.details ?? ''}`,
  );
  return [header, ...lines].join('\n');
}

/**
 * Construit le gabarit à utiliser et la table de substitution complète (§09).
 * Reproduit `GenerateFicheImputation` du source, y compris ses alias de placeholders : le gabarit
 * n'en porte que 15, mais le source en remplace davantage (`%destinataires%`, `%historique%`…),
 * ce qui laisse le gabarit évoluer sans toucher au code.
 */
export function buildFiche(input: FicheInputs): FicheRender {
  // « Imputations » = tout SAUF les copies ; la discrimination se fait sur le libellé du type.
  const imputations = input.imputations.filter((i) => i.typeName !== EN_COPIE);
  const copies = input.imputations.filter((i) => i.typeName === EN_COPIE);

  const imputationsPrincipales = imputations
    .map((x) => `- ${x.userFullName ?? ''} (${x.typeName}): ${x.instructions ?? ''}`)
    .join('\n');

  // Valeurs « originales » : ce sont ELLES qui décident du gabarit, avant tout repli.
  const imputationsOriginal = imputations[0]?.userFullName ?? '';
  const instructionsOriginal = imputations
    .map((x) => x.typeName)
    .filter((t) => !blank(t))
    .join('\n');

  const useAlternate = blank(imputationsOriginal) && blank(instructionsOriginal);

  const replacements: Record<string, string> = {
    // I. INFORMATIONS GÉNÉRALES
    '%date_arrivee%': frDate(input.dateEnregistrementCourrier),
    '%date_courrier%': frDate(input.date),
    '%numero_enregistrement%': input.nReference ?? '',
    '%numero_origine%': input.reference ?? '',
    '%correspondant%': input.externalEntityName ?? '',
    '%destinataire%': input.destinataireFullName ?? '',
    '%objet%': input.title ?? '',
    '%description%': input.attachedFileName, // règle 1 : le nom du fichier joint
    // II. IMPUTATION DU COURRIER (alias non portés par le gabarit, conservés comme le source)
    '%imputations_principales%': imputationsPrincipales,
    '%destinataires%': imputationsPrincipales,
    '%instruction%': imputations
      .map((x) => `- ${x.userFullName ?? ''}: ${x.instructions ?? ''}`)
      .join('\n'),
    '%copie_a%': copies.map((x) => x.userFullName ?? '').join(', '),
    // III. TRAITEMENT DU COURRIER
    '%agent_service_courrier%': input.userCreated ?? '',
    '%name_stamp%': input.userCreated ?? '',
    '%date_now%': frDate(input.now),
    '%date_traitement%': frDateTime(input.now),
    // IV. HISTORIQUE
    '%historique%': input.historique
      .map(
        (x) =>
          `- ${frDateTime(x.date)} - ${x.userName ?? ''} - ${x.actionName ?? ''}: ${x.details ?? ''}`,
      )
      .join('\n'),
    '%historique_traitement%': input.historique
      .map(
        (x) =>
          `- ${frDateTime(x.date)} - ${x.userName ?? ''} - ${x.actionName ?? ''}: ${x.details ?? ''}`,
      )
      .join('\n'),
    '%grid_historique%': buildHistoriqueGrid(input.historique),
  };

  // Champs conditionnels : absents du gabarit alternatif, donc jamais injectés dans ce cas.
  if (!useAlternate) {
    const deadline = frDate(imputations[0]?.deadline ?? null);
    replacements['%imputations%'] = blank(imputationsOriginal)
      ? input.allRoleNames.map((r) => `☐ ${r}`).join('\n')
      : imputationsOriginal;
    replacements['%instructions%'] = blank(instructionsOriginal)
      ? input.allInputationTypeNames.map((t) => `- ☐ ${t}`).join('\n')
      : instructionsOriginal;
    replacements['%datebutoire%'] = deadline;
    replacements['%date_butoire%'] = deadline;
    replacements['%copies%'] = copies.map((x) => `- ${x.userFullName ?? ''}`).join('\n');
  }

  return {
    template: useAlternate ? 'FICHE_IMPUTATION - Copie.docx' : 'FICHE_IMPUTATION.docx',
    replacements,
  };
}
