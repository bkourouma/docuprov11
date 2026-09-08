import { Injectable } from '@nestjs/common';
import { PrismaService } from '../modules/prisma/prisma.service';
import { effectiveMenuKeys } from '../modules/auth/menu-access';
import type { AuthUser } from '../modules/auth/auth.types';

/**
 * Socle commun des **agencements de tableau de bord personnalisables** (Docu-Courriers et
 * Docu-Archives), transposition du `DashboardCustomizationAppService` d'AspNetZero.
 *
 * Ce service ne connaît AUCUN widget. Il ne sait que trois choses, et c'est précisément ce qui est
 * identique d'un module à l'autre :
 *
 * 1. **Aucune table de widgets.** L'agencement complet est un document JSON rangé dans
 *    `user_setting` sous une clé unique par module. Modéliser les positions en relationnel
 *    obligerait à une migration à chaque évolution d'un catalogue.
 *
 * 2. **Catalogue et instance sont séparés.** Le JSON ne contient qu'un identifiant et une
 *    position ; titre, taille minimale et permission viennent du code. Un widget retiré du
 *    catalogue s'évapore des agencements existants sans nettoyage de données.
 *
 * 3. **Re-filtrage des permissions à la LECTURE**, pas seulement à l'écriture. Un droit retiré
 *    après coup doit masquer le widget immédiatement — et sans l'effacer de l'agencement, pour
 *    qu'il revienne en place si le droit est rendu.
 *
 * Ce qui reste PROPRE à chaque module — le catalogue, la règle d'autorisation (le périmètre
 * `MailScope` côté courrier n'a pas d'équivalent côté archives) et la forme de la réponse — est
 * injecté par l'appelant via {@link OptionsAgencement}. `resoudre` renvoie donc des couples
 * `(placement, définition)` plutôt qu'une réponse toute faite : chaque module y ajoute ensuite ses
 * champs propres (`scope`, `dataKeys`…) sans que ce socle ait à les connaître.
 */
@Injectable()
export class AgencementService {
  constructor(private readonly prisma: PrismaService) {}

  /** Menus effectifs de l'utilisateur, relus en base : le JWT ne les porte pas. */
  async menuContexte(user: AuthUser): Promise<{ menuKeys: string[]; isAdmin: boolean }> {
    const row = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        role: { select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } } },
      },
    });
    const isAdmin = row?.isAdmin ?? user.isAdmin ?? false;
    return { menuKeys: effectiveMenuKeys(isAdmin, row?.role ?? null), isAdmin };
  }

  /**
   * Agencement de l'utilisateur, résolu contre le catalogue et re-filtré par permission.
   *
   * Le JSON stocké est traité comme une donnée suspecte : il a pu être écrit par une version
   * antérieure du catalogue, et les identifiants inconnus sont ignorés silencieusement plutôt que
   * de faire échouer l'écran.
   */
  async resoudre<D extends DefinitionWidget>(
    userId: number,
    options: OptionsAgencement<D>,
  ): Promise<{ places: WidgetPlace<D>[]; parDefaut: boolean }> {
    const { placements, parDefaut } = await this.lire(userId, options);
    return { places: this.apparier(placements, options), parDefaut };
  }

  /**
   * Enregistre l'agencement. Deux validations, pour que le stockage ne devienne pas une porte
   * dérobée : les identifiants inconnus sont refusés, et un widget que l'utilisateur n'a pas le
   * droit de voir ne peut pas être placé — sans quoi il suffirait d'écrire soi-même le JSON.
   */
  async enregistrer<D extends DefinitionWidget>(
    userId: number,
    placements: PlacementWidget[],
    options: OptionsAgencement<D>,
  ): Promise<void> {
    const retenus = this.apparier(placements, options).map(({ placement, def }) => ({
      id: placement.id,
      x: borne(placement.x, 0, GRILLE_COLONNES - 1),
      y: Math.max(0, Math.trunc(placement.y)),
      w: borne(placement.w, def.minW, GRILLE_COLONNES),
      h: Math.max(def.minH, Math.trunc(placement.h)),
    }));

    // Dédoublonnage : un même widget deux fois afficherait deux blocs identiques et rendrait
    // l'identifiant ambigu comme clé de grille.
    const uniques = [...new Map(retenus.map((p) => [p.id, p])).values()];

    await this.prisma.userSetting.upsert({
      where: { userId_settingKey: { userId, settingKey: options.cle } },
      create: { userId, settingKey: options.cle, value: uniques },
      update: { value: uniques },
    });
  }

  /**
   * Retour au défaut : on SUPPRIME le réglage plutôt que d'y recopier le défaut du moment — ainsi
   * l'utilisateur suivra les évolutions futures de l'agencement livré.
   */
  async supprimer(userId: number, cle: string): Promise<void> {
    await this.prisma.userSetting.deleteMany({ where: { userId, settingKey: cle } });
  }

  /** Lecture brute du réglage, avec repli sur l'agencement livré. */
  private async lire<D extends DefinitionWidget>(
    userId: number,
    options: OptionsAgencement<D>,
  ): Promise<{ placements: PlacementWidget[]; parDefaut: boolean }> {
    const row = await this.prisma.userSetting.findUnique({
      where: { userId_settingKey: { userId, settingKey: options.cle } },
      select: { value: true },
    });

    if (!row) return { placements: [...options.parDefaut], parDefaut: true };

    const brut = Array.isArray(row.value) ? (row.value as unknown[]) : [];
    const placements = brut
      .filter(estPlacement)
      .map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h }));

    // Agencement vidé ou devenu illisible : on retombe sur le défaut plutôt que sur un écran nu,
    // qui ressemblerait à une panne.
    if (placements.length === 0) return { placements: [...options.parDefaut], parDefaut: true };
    return { placements, parDefaut: false };
  }

  /**
   * Apparie chaque position à sa définition de catalogue, en écartant l'inconnu et l'interdit.
   * Utilisé à la lecture ET à l'écriture : c'est ce qui garantit que les deux appliquent
   * exactement la même règle, sans qu'on ait à s'en souvenir des deux côtés.
   */
  private apparier<D extends DefinitionWidget>(
    placements: PlacementWidget[],
    options: OptionsAgencement<D>,
  ): WidgetPlace<D>[] {
    return placements
      .map((placement) => ({ placement, def: options.widgetsParId.get(placement.id) }))
      // Identifiant absent du catalogue (widget retiré depuis) → ignoré, sans migration.
      .filter((x): x is WidgetPlace<D> => x.def !== undefined)
      // Re-filtrage permission : le cœur de la règle 3.
      .filter((x) => options.autorise(x.def));
  }
}

/** Nombre de colonnes de la grille. Partagé : les agencements persistés y sont exprimés. */
export const GRILLE_COLONNES = 12;

/** Position d'un widget — la seule chose qui soit persistée, avec son identifiant. */
export interface PlacementWidget {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ce que le socle exige d'une définition de widget. Chaque module étend ce contrat avec ce qui lui
 * est propre (permission de menu, périmètre, jeu de données…).
 */
export interface DefinitionWidget {
  id: string;
  titre: string;
  description: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

/** Couple « position × définition de catalogue » — la sortie du socle. */
export interface WidgetPlace<D extends DefinitionWidget> {
  placement: PlacementWidget;
  def: D;
}

export interface OptionsAgencement<D extends DefinitionWidget> {
  /** Clé de réglage sous laquelle l'agencement est rangé (ex. `dashboard.archives.layout`). */
  cle: string;
  /** Agencement livré, servi tant que l'utilisateur n'a rien personnalisé. */
  parDefaut: readonly PlacementWidget[];
  widgetsParId: ReadonlyMap<string, D>;
  /** Règle d'autorisation du module, déjà fermée sur le contexte de l'utilisateur. */
  autorise: (def: D) => boolean;
}

/** Garde de forme sur le JSON stocké — il vient de la base, pas d'un type TypeScript. */
function estPlacement(v: unknown): v is PlacementWidget {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.x === 'number' &&
    typeof o.y === 'number' &&
    typeof o.w === 'number' &&
    typeof o.h === 'number'
  );
}

const borne = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.trunc(v)));
