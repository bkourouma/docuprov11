/**
 * Construction du thème Ant Design à partir des tokens du design system.
 *
 * - cssVar: true → variables CSS (theming fluide + mode sombre).
 * - tokens globaux (theme.token) + tokens par composant (theme.components).
 * - darkAlgorithm en mode sombre, defaultAlgorithm sinon.
 *
 * Design « Registre » : coins nets (badges 4 · tout le reste 6), aucune ombre de carte,
 * réglure bleu-gris. Les champs re-épinglent leurs trois rayons pour que la valeur tienne
 * à toutes les tailles.
 */
import { theme as antdAlgorithm, type ThemeConfig } from 'antd';
import { colors, colorsDark, fonts, fontSize, radii, shadows, type ColorScheme } from './tokens';

type Mode = 'light' | 'dark';

function buildToken(c: ColorScheme, mode: Mode): ThemeConfig['token'] {
  return {
    colorPrimary: c.primary,
    colorInfo: c.info,
    colorSuccess: c.success,
    colorWarning: c.warning,
    colorError: c.danger,
    colorLink: c.primary,
    colorLinkHover: c.primaryHover,
    // La toile est très sombre : les dérivés calculés par l'algorithme d'AntD (survol, fonds
    // pâles) partiraient vers des verts éteints. On les épingle sur la palette.
    colorPrimaryHover: c.primaryHover,
    colorPrimaryActive: c.primaryActive,
    colorPrimaryBg: c.primarySoft,
    colorPrimaryBgHover: mode === 'dark' ? c.primarySoft : '#D3E5DA',

    colorBgLayout: c.bgLayout,
    colorBgContainer: c.bgContainer,
    colorBgElevated: c.bgElevated,
    colorBgSpotlight: c.bgSpotlight,

    colorBorder: c.border,
    colorBorderSecondary: c.borderSecondary,

    colorText: c.text,
    colorTextSecondary: c.textSecondary,
    colorTextTertiary: c.textTertiary,
    colorTextQuaternary: c.textQuaternary,

    fontFamily: fonts.sans,
    fontFamilyCode: fonts.mono,
    fontSize: fontSize.base,
    fontSizeHeading1: fontSize.xxl,
    fontSizeHeading2: fontSize.xl,
    fontSizeHeading3: fontSize.lg,

    borderRadius: radii.base, // 4
    borderRadiusLG: radii.lg, // 6
    borderRadiusSM: radii.xs, // 2

    controlHeight: 36,
    // Plus aucun `size`/`componentSize` « large » dans l'app (densite de champs UNIQUE a 36 px) :
    // ce token n'est plus consomme, il n'est garde que pour rester coherent si
    // un composant AntD interne demande la variante haute.
    controlHeightLG: 46,
    controlHeightSM: 28,

    wireframe: false,
    // Design plat : l'ombre de base sert aux surfaces flottantes (Modal/Drawer),
    // boxShadowSecondary aux popups. Les cartes n'en portent aucune (voir Card).
    boxShadow: shadows.modal,
    boxShadowSecondary: shadows.popover,
    boxShadowTertiary: 'none',

    // Focus net (accessibilité) — anneau primaire.
    colorPrimaryBorder: mode === 'dark' ? c.primaryActive : '#8FBBA6',
  };
}

function buildComponents(c: ColorScheme, mode: Mode): ThemeConfig['components'] {
  return {
    Button: {
      controlHeight: 36,
      fontWeight: 600,
      contentFontSize: fontSize.sm,
      primaryShadow: 'none',
      defaultShadow: 'none',
      // Un bouton secondaire est un contrôle : sa bordure doit se voir (3:1), comme celle
      // d'un champ. Le filet décoratif des cartes ne suffit pas.
      defaultBorderColor: c.borderControl,
      // `radii.field` à toutes les tailles : les boutons suivent les champs auxquels ils sont
      // collés.
      borderRadius: radii.field,
      borderRadiusLG: radii.field,
      borderRadiusSM: radii.field,
    },
    Card: {
      // Cartes plates bordées : AUCUNE ombre (la bordure structure). Rayon `radii.card`, plus
      // ouvert que celui des champs pour que la carte les enveloppe visuellement.
      borderRadiusLG: radii.card,
      boxShadowTertiary: 'none',
      headerFontSize: fontSize.md,
      colorTextHeading: c.textStrong,
      colorBorderSecondary: c.border,
    },
    Table: {
      // Le registre : en-tête sur papier blanc, souligné d'un filet d'encre (globals.css),
      // lignes séparées par la réglure bleu-gris.
      headerBg: c.theadBg,
      headerColor: c.textSecondary,
      headerSplitColor: 'transparent',
      headerSortActiveBg: c.theadBg,
      headerSortHoverBg: c.panelBg,
      bodySortBg: 'transparent',
      borderColor: c.border,
      rowHoverBg: c.primarySoft,
      rowSelectedBg: c.primarySoft,
      rowSelectedHoverBg: c.primarySoft,
      footerBg: c.panelBg,
      // Pas de ligne du registre : 11 px de garde, soit une ligne d'environ 44 px ;
      // les tables de production passent en size="small" (7 px).
      cellPaddingBlock: 11,
      cellPaddingBlockSM: 7,
      headerBorderRadius: radii.card,
      fontWeightStrong: 700,
    },
    // Champs : rayon `radii.field` à TOUTES les tailles, bordure neutre calibrée AA
    // (la convention « bordure primaire » de l'ancien thème disparaît).
    Input: {
      borderRadius: radii.field,
      borderRadiusLG: radii.field,
      borderRadiusSM: radii.field,
      controlHeight: 36,
      activeShadow: 'none',
      colorBorder: c.borderControl,
      inputFontSize: fontSize.base,
    },
    InputNumber: {
      borderRadius: radii.field,
      borderRadiusLG: radii.field,
      borderRadiusSM: radii.field,
      controlHeight: 36,
      colorBorder: c.borderControl,
    },
    Select: {
      borderRadius: radii.field,
      borderRadiusLG: radii.field,
      borderRadiusSM: radii.field,
      controlHeight: 36,
      colorBorder: c.borderControl,
    },
    TreeSelect: { borderRadius: radii.field, colorBorder: c.borderControl },
    DatePicker: {
      borderRadius: radii.field,
      borderRadiusLG: radii.field,
      borderRadiusSM: radii.field,
      controlHeight: 36,
      colorBorder: c.borderControl,
    },
    Cascader: { borderRadius: radii.field, colorBorder: c.borderControl },
    Mentions: { borderRadius: radii.field, colorBorder: c.borderControl },
    Tag: {
      borderRadiusSM: radii.base,
      fontSizeSM: 11,
      defaultBg: c.bgLayout,
      defaultColor: c.textSecondary,
    },
    Steps: { dotSize: 10, iconSize: 32, titleLineHeight: 22 },
    // Une modale est une carte flottante : meme rayon qu'une carte.
    Modal: { borderRadiusLG: radii.card, titleFontSize: fontSize.lg, headerBg: 'transparent' },
    Form: { labelFontSize: fontSize.base, verticalLabelPadding: '0 0 8px' },
    Menu: {
      // Panneau des écrans : l'écran courant est un aplat de toile à libellé blanc, aux coins
      // nets ; les titres de groupe (Traiter, Suivre…) sont stylés dans globals.css.
      itemBorderRadius: radii.field,
      itemMarginInline: 0,
      itemMarginBlock: 2,
      itemHeight: 34,
      itemBg: 'transparent',
      subMenuItemBg: 'transparent',
      itemColor: c.sidebarLabel,
      itemHoverColor: c.sidebarLabel,
      itemSelectedBg: c.menuSelectedBg,
      itemSelectedColor: c.menuSelectedColor,
      itemActiveBg: c.primarySoft,
      itemHoverBg: c.primarySoft,
      iconSize: 18,
      collapsedIconSize: 20,
      groupTitleColor: c.textSecondary,
      groupTitleFontSize: 11.5,
    },
    Tabs: { titleFontSize: fontSize.base, horizontalItemPadding: '10px 0', inkBarColor: c.primary },
    // La piste doit se détacher du fond de page (lui-même teinté) : un cran plus soutenu.
    Segmented: {
      borderRadius: radii.field,
      itemSelectedBg: c.bgContainer,
      itemSelectedColor: c.primary,
      trackBg: mode === 'dark' ? c.bgElevated : '#DCE7E0',
    },
    Collapse: { borderRadiusLG: radii.base, headerPadding: '10px 0' },
    // Surfaces flottantes, infobulle comprise : toutes au rayon des cartes.
    // `Tooltip` consomme le rayon de BASE, pas `borderRadiusLG` — d'ou la cle differente.
    Tooltip: { borderRadius: radii.card },
    Popover: { borderRadiusLG: radii.card },
    Dropdown: { borderRadiusLG: radii.card },
    // Toasts et notifications : cartes flottantes elles aussi.
    Message: { borderRadiusLG: radii.card },
    Notification: { borderRadiusLG: radii.card },
    // Zone de depot (Upload.Dragger) : bloc encarte, rayon de carte.
    Upload: { borderRadiusLG: radii.card },
    // Les bandeaux d'alerte encadrent un bloc de page comme une carte : même rayon qu'elle.
    Alert: { borderRadiusLG: radii.card },
    Progress: { defaultColor: c.primary },
    Badge: { borderRadiusSM: radii.base },
    Avatar: { borderRadius: radii.base },
    Layout: {
      bodyBg: c.bgLayout,
      headerBg: c.topbarBg,
      siderBg: c.panelBg,
      headerHeight: 56,
      headerPadding: '0 16px',
    },
  };
}

export function buildTheme(mode: Mode): ThemeConfig {
  const c = mode === 'dark' ? colorsDark : colors;
  return {
    cssVar: true,
    hashed: true,
    algorithm: mode === 'dark' ? antdAlgorithm.darkAlgorithm : antdAlgorithm.defaultAlgorithm,
    token: buildToken(c, mode),
    components: buildComponents(c, mode),
  };
}
