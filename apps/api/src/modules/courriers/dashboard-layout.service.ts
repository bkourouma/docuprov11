import { Injectable } from '@nestjs/common';
import {
  AgencementService,
  GRILLE_COLONNES,
  type OptionsAgencement,
  type PlacementWidget,
} from '../../common/agencement.service';
import type { AuthUser } from '../auth/auth.types';
import { mailScopeFromMenuKeys, type MailScope } from './domain';
import {
  AGENCEMENT_PAR_DEFAUT,
  CLE_AGENCEMENT,
  WIDGETS_PAR_ID,
  catalogueAutorise,
  widgetAutorise,
  type WidgetDataKey,
  type WidgetDefinition,
} from './dashboard-widgets';

export interface WidgetResolu extends PlacementWidget {
  titre: string;
  description: string;
  dataKey: WidgetDataKey;
  minW: number;
  minH: number;
}

export interface AgencementResponse {
  scope: MailScope;
  colonnes: number;
  /** Widgets effectivement affichables, position comprise. */
  widgets: WidgetResolu[];
  /** Catalogue autorisé — alimente la modale « Ajouter un widget ». */
  disponibles: WidgetDefinition[];
  /** `true` quand l'utilisateur n'a rien personnalisé : l'écran peut proposer « Personnaliser ». */
  parDefaut: boolean;
  /** Jeux de données à charger — dérivés des seuls widgets placés. */
  dataKeys: WidgetDataKey[];
}

/**
 * Agencement personnalisable du tableau de bord Docu-Courriers.
 *
 * Toute la mécanique — stockage JSON dans `user_setting`, garde de forme, bornage des positions,
 * re-filtrage des permissions à la lecture — vit dans {@link AgencementService}. Ce service ne
 * garde que ce qui est propre au module :
 *
 *  - le **périmètre** `MailScope`, qui conditionne certains widgets (la charge nominative n'est
 *    jamais servie hors suivi permanent) et que l'écran doit connaître pour s'expliquer ;
 *  - les **jeux de données** (`dataKeys`) des seuls widgets placés : retirer un widget supprime
 *    aussi sa requête, au lieu d'appeler les neuf endpoints en toutes circonstances.
 */
@Injectable()
export class DashboardLayoutService {
  constructor(private readonly agencement: AgencementService) {}

  /** Options du socle, fermées sur le contexte de permission ET de périmètre de l'utilisateur. */
  private async options(user: AuthUser): Promise<{
    options: OptionsAgencement<WidgetDefinition>;
    menuKeys: string[];
    scope: MailScope;
    isAdmin: boolean;
  }> {
    const { menuKeys, isAdmin } = await this.agencement.menuContexte(user);
    const scope = mailScopeFromMenuKeys(menuKeys);
    return {
      menuKeys,
      scope,
      isAdmin,
      options: {
        cle: CLE_AGENCEMENT,
        parDefaut: AGENCEMENT_PAR_DEFAUT,
        widgetsParId: WIDGETS_PAR_ID,
        autorise: (def) => widgetAutorise(def, menuKeys, scope, isAdmin),
      },
    };
  }

  async getForUser(user: AuthUser): Promise<AgencementResponse> {
    const { options, menuKeys, scope, isAdmin } = await this.options(user);
    const { places, parDefaut } = await this.agencement.resoudre(user.userId, options);

    const widgets: WidgetResolu[] = places.map(({ placement, def }) => ({
      ...placement,
      // Titre et bornes viennent TOUJOURS du catalogue, jamais du JSON : sinon un agencement
      // ancien figerait un libellé corrigé depuis.
      titre: def.titre,
      description: def.description,
      dataKey: def.dataKey,
      minW: def.minW,
      minH: def.minH,
    }));

    return {
      scope,
      colonnes: GRILLE_COLONNES,
      widgets,
      disponibles: catalogueAutorise(menuKeys, scope, isAdmin),
      parDefaut,
      dataKeys: [...new Set(widgets.map((w) => w.dataKey))],
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
