import type { BrandConfig } from './template';
import type { InlineLogo } from './logo';

/**
 * Chargement de l'identité e-mail depuis la base (`email_template_setting`), partagé par l'API et
 * le worker — sans quoi un rappel planifié porterait une marque différente d'une notification
 * d'enregistrement.
 *
 * Ce module ne dépend PAS de `@prisma/client` : il reçoit un accesseur minimal (typage structurel).
 * `@archivage/mailer` reste ainsi installable sans base — le canal e-mail doit pouvoir tourner en
 * test avec un simple objet littéral.
 */

/**
 * Ligne de paramétrage telle qu'elle sort de la base ; tous les champs peuvent être `null`.
 *
 * Volontairement réduite à l'essentiel : nom de l'organisation, logo déposé, coordonnées. Le
 * sous-titre institutionnel, la baseline, le nom du produit, un logo externe, une couleur d'accent
 * et une mention de bas de page ont existé un temps comme champs éditables, mais l'écran de
 * paramétrage en portait trop — retirés plutôt que masqués, pour ne pas garder de colonnes ni de
 * code mort inutilisés.
 */
export interface EmailBrandRow {
  orgName: string | null;
  logoFileName: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
}

/** Accesseur minimal attendu — satisfait par `prisma.emailTemplateSetting`. */
export interface EmailBrandSource {
  findFirst(args?: unknown): Promise<EmailBrandRow | null>;
}

/**
 * Construit l'identité TEXTE pour le gabarit. Les valeurs de la base l'emportent sur `fallback`
 * (les variables `MAIL_*`) CHAMP PAR CHAMP : une organisation qui n'a saisi qu'un nom garde le reste
 * hérité de l'environnement plutôt que de le perdre.
 *
 * Le LOGO n'est PAS résolu ici : un logo déposé sur le serveur est embarqué dans le message (CID),
 * pas référencé par URL (cf. `InlineLogo`). Seul un logo d'environnement déjà PUBLIC (`MAIL_LOGO_URL`,
 * ex. un CDN) reste une URL — il est joignable de partout, contrairement au fichier local.
 *
 * `productName` n'a pas de source en base (champ retiré de l'écran de paramétrage) : il vient
 * uniquement de `fallback`, comme avant l'existence de cette table.
 */
export function brandFromRow(row: EmailBrandRow | null, fallback: BrandConfig = {}): BrandConfig {
  if (!row) return fallback;
  const pick = (v: string | null, f: string | null | undefined): string | null =>
    v?.trim() ? v.trim() : (f?.trim() ?? null);

  return {
    orgName: pick(row.orgName, fallback.orgName),
    productName: fallback.productName?.trim() || null,
    // Un logo local (row.logoFileName) est embarqué en CID par la couche d'envoi, pas ici. Reste
    // donc uniquement le repli d'environnement public.
    logoUrl: fallback.logoUrl?.trim() || null,
    contactEmail: pick(row.contactEmail, fallback.contactEmail),
    websiteUrl: pick(row.websiteUrl, fallback.websiteUrl),
  };
}

/** Identité + logo embarqué, prêts à passer à `send`. */
export interface LoadedBrand {
  brand: BrandConfig;
  inlineLogo: InlineLogo | null;
}

export interface BrandLoaderOptions {
  /** Identité de repli (variables `MAIL_*`) tant que rien n'est saisi en base. */
  fallback?: BrandConfig;
  /** Lit le logo déposé sur disque à embarquer (le worker le branche sur son dossier ARCHIVES). */
  loadInlineLogo?: (row: EmailBrandRow) => Promise<InlineLogo | null>;
  /** Durée de mise en cache. Défaut 60 s. */
  ttlMs?: number;
}

/**
 * Charge l'identité (et le logo embarqué) avec un cache court. Un envoi groupé touche la même ligne
 * autant de fois qu'il y a de destinataires : sans cache, une imputation à quinze personnes
 * déclencherait quinze lectures identiques (base + fichier). Le TTL reste court pour qu'une
 * correction se voie sans redémarrage — l'écran de paramétrage invalide en plus le cache.
 */
export function createBrandLoader(
  source: EmailBrandSource,
  options: BrandLoaderOptions = {},
): { load(): Promise<LoadedBrand>; invalidate(): void } {
  const ttl = options.ttlMs ?? 60_000;
  let cached: LoadedBrand | null = null;
  let expiresAt = 0;
  let inFlight: Promise<LoadedBrand> | null = null;

  const fetchBrand = async (now: number): Promise<LoadedBrand> => {
    try {
      const row = await source.findFirst();
      const brand = brandFromRow(row, options.fallback);
      const inlineLogo = row && options.loadInlineLogo ? await options.loadInlineLogo(row) : null;
      cached = { brand, inlineLogo };
    } catch {
      // La base indisponible ne doit pas empêcher l'envoi : on retombe sur l'identité
      // d'environnement, quitte à envoyer un e-mail moins personnalisé.
      cached = { brand: options.fallback ?? {}, inlineLogo: null };
    }
    expiresAt = now + ttl;
    return cached;
  };

  return {
    async load(): Promise<LoadedBrand> {
      const now = Date.now();
      if (cached && now < expiresAt) return cached;
      // Les envois d'un même lot partent en parallèle : sans dédoublonnage, tous rateraient le
      // cache ensemble et lanceraient chacun leur requête.
      inFlight ??= fetchBrand(now).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    invalidate(): void {
      cached = null;
      expiresAt = 0;
    },
  };
}
