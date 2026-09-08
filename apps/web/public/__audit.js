// OUTIL D'AUDIT TEMPORAIRE — mesure du comportement mobile des 57 routes.
// Chargé depuis le navigateur via `await import('/__audit.js')`.
// À SUPPRIMER une fois l'audit terminé. Ne fait aucune écriture, aucune requête réseau.
//
// Note : pas de requestAnimationFrame ici — le volet navigateur peut être masqué,
// et rAF ne se déclenche alors jamais (la mesure resterait suspendue indéfiniment).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attend que la page ait fini de charger : readyState, spinners AntD, squelettes. */
async function pret(timeout = 7000) {
  const t0 = performance.now();
  while (document.readyState !== 'complete' && performance.now() - t0 < timeout) await sleep(100);
  let calme = 0;
  while (performance.now() - t0 < timeout) {
    const occupe =
      document.querySelector('.ant-spin-spinning') ||
      document.querySelector('.ant-skeleton-active') ||
      document.querySelector('.ant-table-placeholder .ant-spin');
    calme = occupe ? 0 : calme + 1;
    if (calme >= 3) break;
    await sleep(150);
  }
  await sleep(250);
  return Math.round(performance.now() - t0);
}

const sel = (el) => {
  const cls =
    el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
  return el.tagName.toLowerCase() + cls;
};

export async function mesure(route) {
  const attente = await pret();
  const t0 = performance.now();
  const vw = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const overflow = sw > vw + 1;

  const tous = [...document.querySelectorAll('body *')];

  // UNE seule passe : un getComputedStyle et un getBoundingClientRect par élément.
  const info = new Map();
  for (const el of tous) {
    const cs = getComputedStyle(el);
    info.set(el, {
      r: el.getBoundingClientRect(),
      pos: cs.position,
      ox: cs.overflowX,
      fs: parseFloat(cs.fontSize),
    });
  }

  // Un ancêtre qui défile horizontalement rend le débordement légitime. Mémoïsé.
  const cacheScroll = new Map();
  function scrollAncetre(el) {
    if (cacheScroll.has(el)) return cacheScroll.get(el);
    const p = el.parentElement;
    let res = null;
    if (p && p !== document.body && p !== document.documentElement) {
      const i = info.get(p);
      if (i && (i.ox === 'auto' || i.ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) {
        res = sel(p);
      } else {
        res = scrollAncetre(p);
      }
    }
    cacheScroll.set(el, res);
    return res;
  }

  const offenseurs = new Set();
  let dansScroll = 0;
  for (const el of tous) {
    const { r } = info.get(el);
    if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
      if (scrollAncetre(el)) dansScroll++;
      else offenseurs.add(el);
    }
  }

  // « Externes » : aucun ancêtre n'est lui-même coupable — le parent explique ses enfants.
  const externes = [];
  for (const el of offenseurs) {
    let p = el.parentElement,
      couvert = false;
    while (p && p !== document.body) {
      if (offenseurs.has(p)) {
        couvert = true;
        break;
      }
      p = p.parentElement;
    }
    if (!couvert) externes.push(el);
  }
  externes.sort((a, b) => info.get(b).r.right - info.get(a).r.right);

  const fmt = (el) => {
    const { r } = info.get(el);
    return {
      sel: sel(el),
      largeur: Math.round(r.width),
      droite: Math.round(r.right),
      txt: (el.textContent || '').trim().slice(0, 40),
    };
  };

  const cibles = [
    ...document.querySelectorAll(
      'button,a,[role="button"],.ant-btn,input,select,.ant-switch,.ant-checkbox-input,.ant-tabs-tab',
    ),
  ].filter((el) => {
    const i = info.get(el);
    return i && i.r.width > 0 && i.r.height > 0;
  });
  const petitesCibles = cibles.filter((el) => {
    const { r } = info.get(el);
    return r.height < 44 || r.width < 44;
  });

  const petitTexteEls = tous.filter(
    (el) => el.children.length === 0 && el.textContent.trim() && info.get(el).fs < 12,
  );

  const tableaux = [...document.querySelectorAll('.ant-table-wrapper')].map((w) => {
    const body = w.querySelector('.ant-table-body') || w.querySelector('.ant-table-content');
    const i = body ? info.get(body) : null;
    const ox = i ? i.ox : null;
    const defilable = ox === 'auto' || ox === 'scroll';
    return {
      colonnes: w.querySelectorAll('thead th').length,
      lignes: w.querySelectorAll('tbody tr.ant-table-row').length,
      defilable,
      contenu: body ? Math.round(body.scrollWidth) : null,
      visible: body ? Math.round(body.clientWidth) : null,
      tronque: !!body && body.scrollWidth > body.clientWidth + 1 && !defilable,
      colonneFigee:
        w.querySelectorAll('.ant-table-cell-fix-right, .ant-table-cell-fix-left').length > 0,
      largeur: Math.round(w.getBoundingClientRect().width),
    };
  });

  const champsZoomIos = [...document.querySelectorAll('input,textarea,select')].filter((el) => {
    const i = info.get(el);
    return i && i.r.width > 0 && i.fs < 16;
  }).length;

  const fixes = tous
    .filter((el) => {
      const i = info.get(el);
      return (i.pos === 'fixed' || i.pos === 'sticky') && i.r.width > 0 && i.r.height > 0;
    })
    .map((el) => {
      const { r, pos } = info.get(el);
      return {
        sel: sel(el),
        pos,
        l: Math.round(r.width),
        h: Math.round(r.height),
        y: Math.round(r.top),
      };
    });

  const texte = document.body.innerText || '';
  const erreur =
    !!document.querySelector('nextjs-portal') ||
    /Application error|Unhandled Runtime Error|This page could not be found/i.test(texte);

  const h1 = document.querySelector('.da-page h1, h1');

  return {
    route: route || location.pathname,
    url: location.pathname,
    vw,
    sw,
    overflow,
    depassement: overflow ? sw - vw : 0,
    coupables: externes.slice(0, 10).map(fmt),
    coupablesTotal: offenseurs.size,
    debordantsDansScroll: dansScroll,
    petitesCibles: petitesCibles.length,
    petitesCiblesEx: petitesCibles.slice(0, 4).map((el) => {
      const { r } = info.get(el);
      return {
        sel: sel(el),
        l: Math.round(r.width),
        h: Math.round(r.height),
        txt: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 22),
      };
    }),
    petitTexte: petitTexteEls.length,
    petitTexteMin: petitTexteEls.length
      ? Math.min(...petitTexteEls.map((el) => info.get(el).fs))
      : null,
    tableaux,
    champsZoomIos,
    fixes,
    erreur,
    titre: (h1 && h1.textContent.trim().slice(0, 60)) || document.title,
    corpsVide: texte.trim().length < 40,
    nbEls: tous.length,
    attente,
    ms: Math.round(performance.now() - t0),
  };
}

/** Résumé compact d'une route, pour les balayages. */
export async function court(route) {
  const m = await mesure(route);
  return {
    r: m.route,
    vw: m.vw,
    ov: m.overflow,
    px: m.depassement,
    n: m.coupablesTotal,
    top: m.coupables.slice(0, 4).map((c) => `${c.sel} ${c.largeur}w→${c.droite}`),
    tbl: m.tableaux.map(
      (t) => `${t.colonnes}col ${t.defilable ? 'scroll' : 'FIGE'}${t.tronque ? ' TRONQUE' : ''} ${t.contenu}/${t.visible}${t.colonneFigee ? ' fix' : ''}`,
    ),
    cib: m.petitesCibles,
    txt: m.petitTexte,
    ios: m.champsZoomIos,
    fx: m.fixes.length,
    err: m.erreur,
    vide: m.corpsVide,
    t: m.titre,
  };
}
