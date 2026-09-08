import { Injectable } from '@nestjs/common';
import {
  AgencementService,
  GRILLE_COLONNES,
  type OptionsAgencement,
  type PlacementWidget,
} from '../../common/agencement.service';
import type { AuthUser } from '../auth/auth.types';
import {
  AGENCEMENT_PAR_DEFAUT,
  CLE_AGENCEMENT,
  WIDGETS_PAR_ID,
  catalogueAutorise,
  widgetAutorise,
  type WidgetDefinition,
} from './dashboard-widgets';

export interface WidgetResolu extends PlacementWidget {
  titre: string;
  description: string;
  minW: number;
  minH: number;
}

export interface AgencementResponse {
  colonnes: number;
  /** Widgets effectivement affichables, position comprise. */
  widgets: WidgetResolu[];
  /** Catalogue autorisé — alimente la modale « Ajouter un widget ». */
  disponibles: WidgetDefinition[];
  /** `true` quand l'utilisateur n'a rien personnalisé. */
  parDefaut: boolean;
}

/**
 * Agencement personnalisable du tableau de bord Docu-Archives.
 *
 * Toute la mécanique — stockage JSON dans `user_setting`, garde de forme, bornage des positions,
 * re-filtrage des permissions à la lecture — vit dans {@link AgencementService}. Ce service ne
 * garde que ce qui est propre au module : son catalogue, sa règle d'autorisation et la forme de sa
 * réponse.
 *
 * La règle d'autorisation est ici la plus simple des deux : **aucune notion de périmètre**. Les
 * données d'analyse sont déjà filtrées par ACL dans `AnalyticsService`, et tous les widgets se
 * nourrissent du même agrégat — l'unique condition est donc l'accès à l'écran.
 */
@Injectable()
export class DashboardLayoutService {
  constructor(private readonly agencement: AgencementService) {}

  /** Options du socle, fermées sur le contexte de permission de l'utilisateur. */
  private async options(user: AuthUser): Promise<{
    options: OptionsAgencement<WidgetDefinition>;
    menuKeys: string[];
    isAdmin: boolean;
  }> {
    const { menuKeys, isAdmin } = await this.agencement.menuContexte(user);
    return {
      menuKeys,
      isAdmin,
      options: {
        cle: CLE_AGENCEMENT,
        parDefaut: AGENCEMENT_PAR_DEFAUT,
        widgetsParId: WIDGETS_PAR_ID,
        autorise: (def) => widgetAutorise(def, menuKeys, isAdmin),
      },
    };
  }

  async getForUser(user: AuthUser): Promise<AgencementResponse> {
    const { options, menuKeys, isAdmin } = await this.options(user);
    const { places, parDefaut } = await this.agencement.resoudre(user.userId, options);

    return {
      colonnes: GRILLE_COLONNES,
      widgets: places.map(({ placement, def }) => ({
        ...placement,
        // Titre et bornes viennent TOUJOURS du catalogue, jamais du JSON : sinon un agencement
        // ancien figerait un libellé corrigé depuis.
        titre: def.titre,
        description: def.description,
        minW: def.minW,
        minH: def.minH,
      })),
      disponibles: catalogueAutorise(menuKeys, isAdmin),
      parDefaut,
    };
  }

  async save(user: AuthUser, placements: PlacementWidget[]): Promise<AgencementResponse> {
    const { options } = await this.options(user);
    await this.agencement.enregistrer(user.userId, placements, options);
    return this.getForUser(user);
  }

  async reset(user: AuthUser): Promise<AgencementResponse> {
    await this.agencement.supprimer(user.userId, CLE_AGENCEMENT);
    return this.getForUser(user);
  }
}
