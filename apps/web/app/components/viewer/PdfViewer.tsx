'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Button, Input, InputNumber, Select, Space, Spin, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { EmptyState } from '../EmptyState';
import { icons } from '../../theme/icons';
import { fontSize } from '../../theme/tokens';
import { loadPdfJs, PDFJS_ASSETS } from './pdfjs';
import './pdf-viewer.css';

/**
 * Visionneuse PDF complète (pdf.js), utilisée partout où l'on « visualise un courrier ».
 *
 * Remplace l'`<iframe src="blob:…#toolbar=0">` qui servait jusqu'ici : le rendu natif du
 * navigateur variait d'un poste à l'autre (Chrome, Firefox et Edge n'offrent ni la même
 * barre d'outils ni la même recherche, et certains WebView n'affichent rien du tout), et
 * on ne pouvait ni piloter le zoom, ni chercher dans le texte, ni afficher les vignettes.
 *
 * Fonctions : navigation page à page, zoom (+/‑, ajusté largeur/page), rotation, recherche
 * plein texte avec surlignage et navigation entre occurrences, vignettes, plein écran,
 * impression, téléchargement, sélection/copie du texte, raccourcis clavier.
 *
 * Le rendu est paresseux : une page n'est peinte que lorsqu'elle approche du viewport.
 */

export type PdfViewerProps = {
  /** URL du binaire (blob: généré par l'appelant, ou URL directe). `null` ⇒ état vide. */
  src: string | null;
  /** Nom proposé au téléchargement. */
  fileName?: string;
  /** Chargement amont (récupération du blob par l'appelant). */
  loading?: boolean;
  /** Hauteur du conteneur. Par défaut il occupe toute la hauteur disponible. */
  height?: number | string;
  /** Contenu affiché quand `src` est `null`. */
  empty?: ReactNode;
  /** Ouvre le panneau de vignettes dès l'affichage. */
  defaultThumbnails?: boolean;
  className?: string;
  style?: CSSProperties;
};

type FitMode = 'width' | 'page' | null;

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const SCROLL_PADDING = 16;

export function PdfViewer({
  src,
  fileName = 'document.pdf',
  loading = false,
  height = '100%',
  empty,
  defaultThumbnails = false,
  className,
  style,
}: PdfViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<InputRef>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);

  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.25);
  const [fit, setFit] = useState<FitMode>(null);
  const [rotation, setRotation] = useState(0);
  const [thumbs, setThumbs] = useState(defaultThumbnails);
  const [fullscreen, setFullscreen] = useState(false);
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);

  // Index plein texte : un tableau d'items (= un <span> de la couche texte) par page.
  // Compter les occurrences item par item garde le total de la barre de recherche
  // aligné sur ce que le surlignage sait réellement marquer dans le DOM.
  const [pageItems, setPageItems] = useState<string[][]>([]);
  const [query, setQuery] = useState('');
  const [matchPos, setMatchPos] = useState(0);

  // ---- Chargement du document ------------------------------------------------------

  useEffect(() => {
    if (!src) {
      setDoc(null);
      setDocError(null);
      return;
    }
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    setDocLoading(true);
    setDocError(null);
    setPageNum(1);
    setPageItems([]);

    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const loadingTask = pdfjs.getDocument({
          url: src,
          isEvalSupported: false,
          ...PDFJS_ASSETS,
        });
        task = loadingTask;
        const loaded = await loadingTask.promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) {
          setDoc(null);
          setDocError(
            (e as Error)?.message || "Ce fichier n'a pas pu être ouvert comme document PDF.",
          );
        }
      } finally {
        if (!cancelled) setDocLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [src]);

  // Le document détient un worker : on le libère quand il est remplacé ou démonté.
  useEffect(() => {
    return () => {
      void doc?.destroy();
    };
  }, [doc]);

  // Dimensions de référence (page 1 à l'échelle 1) : base des calculs « ajuster ».
  useEffect(() => {
    if (!doc) {
      setBase(null);
      return;
    }
    let cancelled = false;
    void doc.getPage(1).then((p) => {
      if (cancelled) return;
      const v = p.getViewport({ scale: 1, rotation });
      setBase({ w: v.width, h: v.height });
    });
    return () => {
      cancelled = true;
    };
  }, [doc, rotation]);

  // Extraction du texte pour la recherche — en tâche de fond, page après page.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void (async () => {
      const all: string[][] = [];
      for (let p = 1; p <= doc.numPages; p += 1) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        if (cancelled) return;
        all.push(content.items.map((it) => ('str' in it ? it.str : '')));
      }
      if (!cancelled) setPageItems(all);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // ---- Zoom / ajustement -----------------------------------------------------------

  const applyFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !base || !fit) return;
    // On retire le padding du conteneur et une marge pour l'ascenseur vertical.
    const availW = el.clientWidth - SCROLL_PADDING * 2 - 12;
    const availH = el.clientHeight - SCROLL_PADDING * 2;
    const next = fit === 'width' ? availW / base.w : Math.min(availW / base.w, availH / base.h);
    if (Number.isFinite(next) && next > 0) setScale(Math.max(0.1, Math.min(next, 6)));
  }, [base, fit]);

  /**
   * Ajustement initial à la largeur, sur mobile UNIQUEMENT (arbitrage validé du chantier
   * mobile-first). Sans lui, `fit` vaut `null` au montage et la page reste peinte à l'échelle
   * 1,25 — soit ~744 px de large dans un cadre de ~310 px sur un téléphone : le document est
   * illisible et aucune correction de la barre d'outils ou du rail de vignettes n'y changerait
   * rien. C'est formellement un changement d'état initial, d'où la condition de largeur : au
   *-dessus de 768 px le comportement est inchangé, bit à bit.
   *
   * Posé dans un effet et non dans l'initialiseur de `useState` : lire `window` au rendu
   * donnerait une valeur différente côté serveur et côté client, et `fit` alimente le sélecteur
   * de zoom de la barre d'outils — donc le HTML rendu. L'effet s'exécute après l'hydratation,
   * sans écart possible.
   *
   * L'utilisateur reste maître : tout zoom manuel repasse `fit` à `null` (`zoomTo`).
   */
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
      setFit('width');
    }
  }, []);

  useLayoutEffect(applyFit, [applyFit]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyFit]);

  const zoomTo = useCallback((next: number) => {
    setFit(null);
    setScale(Math.max(0.1, Math.min(next, 6)));
  }, []);

  const zoomStep = useCallback((dir: 1 | -1) => {
    setFit(null);
    setScale((s) =>
      dir > 0
        ? (ZOOM_STEPS.find((z) => z > s + 0.001) ?? ZOOM_MAX)
        : ([...ZOOM_STEPS].reverse().find((z) => z < s - 0.001) ?? ZOOM_MIN),
    );
  }, []);

  // ---- Navigation ------------------------------------------------------------------

  const goToPage = useCallback((n: number) => {
    const node = pageRefs.current.get(n);
    const el = scrollRef.current;
    if (!node || !el) return;
    el.scrollTo({ top: node.offsetTop - SCROLL_PADDING, behavior: 'smooth' });
    setPageNum(n);
  }, []);

  // Page courante = la dernière dont le haut est passé au-dessus du tiers haut du viewport.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const y = el.scrollTop + el.clientHeight * 0.3;
        let cur = 1;
        pageRefs.current.forEach((node, n) => {
          if (node.offsetTop <= y && n > cur) cur = n;
        });
        setPageNum(cur);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [doc]);

  // ---- Recherche -------------------------------------------------------------------

  /** Occurrences par page, dans l'ordre du document. */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || pageItems.length === 0) return [] as { page: number; index: number }[];
    const out: { page: number; index: number }[] = [];
    pageItems.forEach((items, p) => {
      let inPage = 0;
      items.forEach((raw) => {
        const hay = raw.toLowerCase();
        let from = 0;
        for (;;) {
          const at = hay.indexOf(needle, from);
          if (at < 0) break;
          out.push({ page: p + 1, index: inPage });
          inPage += 1;
          from = at + needle.length;
        }
      });
    });
    return out;
  }, [query, pageItems]);

  useEffect(() => setMatchPos(0), [query]);

  const current = matches[matchPos];

  // Amener la page de l'occurrence courante à l'écran (le surlignage précis est ensuite
  // recentré par la page elle-même, une fois rendue).
  useEffect(() => {
    if (current) goToPage(current.page);
    // Dépendances VOLONTAIREMENT réduites à l'identité de l'occurrence : `goToPage` est stable,
    // et dépendre de l'objet `current` relancerait le défilement à chaque re-calcul de la liste
    // des occurrences — la vue sauterait pendant la frappe.
  }, [current?.page, current?.index]);

  const stepMatch = useCallback(
    (dir: 1 | -1) => {
      if (matches.length === 0) return;
      setMatchPos((p) => (p + dir + matches.length) % matches.length);
    },
    [matches.length],
  );

  // ---- Actions ---------------------------------------------------------------------

  const download = useCallback(() => {
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = fileName;
    a.click();
  }, [src, fileName]);

  const print = useCallback(() => {
    if (!src) return;
    // On imprime le binaire d'origine via une iframe cachée : le moteur d'impression du
    // navigateur produit un meilleur résultat que nos canvas rastérisés.
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    frame.src = src;
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    };
    document.body.appendChild(frame);
    // L'iframe doit survivre au dialogue d'impression, qui est modal et asynchrone.
    window.setTimeout(() => frame.remove(), 120_000);
  }, [src]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // ---- Raccourcis clavier ----------------------------------------------------------

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') (target as HTMLInputElement).blur();
        return;
      }
      const total = doc?.numPages ?? 1;
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        zoomStep(1);
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        zoomStep(-1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        // Ciblage par ref : les <Select> d'Ant Design embarquent eux aussi un
        // `input[type=search]` caché, qui serait trouvé en premier par un sélecteur CSS.
        searchRef.current?.focus();
      } else if (e.key === 'PageDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        goToPage(Math.min(pageNum + 1, total));
      } else if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        goToPage(Math.max(pageNum - 1, 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        goToPage(total);
      }
    },
    [doc, pageNum, goToPage, zoomStep],
  );

  // ---- Rendu -----------------------------------------------------------------------

  const busy = loading || docLoading;

  if (!src && !busy) {
    return (
      <div className={`da-pdf ${className ?? ''}`} style={{ height, ...style }}>
        <div className="da-pdf__empty">
          {empty ?? <EmptyState compact icon="document" title="Aucun aperçu" />}
        </div>
      </div>
    );
  }

  const total = doc?.numPages ?? 0;

  return (
    <div
      ref={rootRef}
      className={`da-pdf ${className ?? ''}`}
      style={{ height: fullscreen ? '100%' : height, ...style }}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="da-pdf__toolbar">
        <Tooltip title="Vignettes">
          <Button
            size="small"
            type={thumbs ? 'primary' : 'text'}
            aria-label="Vignettes"
            aria-pressed={thumbs}
            icon={<icons.thumbnails size={16} />}
            onClick={() => setThumbs((v) => !v)}
          />
        </Tooltip>

        {/*
          Pas d'infobulle sur ces deux-là (ni sur les flèches de recherche) : Ant Design
          enveloppe un bouton DÉSACTIVÉ dans un <span> pour que le survol reste capté, et
          ce span casserait le groupement visuel de `Space.Compact`. L'`aria-label` porte
          seul le nom accessible.
        */}
        <Space.Compact size="small">
          <Button
            aria-label="Page précédente"
            icon={<icons.chevronUp size={16} />}
            disabled={pageNum <= 1}
            onClick={() => goToPage(pageNum - 1)}
          />
          <Button
            aria-label="Page suivante"
            icon={<icons.chevronDown size={16} />}
            disabled={pageNum >= total}
            onClick={() => goToPage(pageNum + 1)}
          />
        </Space.Compact>
        <Space size={4}>
          <InputNumber
            size="small"
            min={1}
            max={Math.max(total, 1)}
            value={pageNum}
            controls={false}
            aria-label="Numéro de page"
            style={{ width: 56 }}
            onChange={(v) => typeof v === 'number' && goToPage(v)}
          />
          <Typography.Text type="secondary">/ {total || '—'}</Typography.Text>
        </Space>

        <Space.Compact size="small">
          <Tooltip title="Zoom arrière (Ctrl -)">
            <Button
              aria-label="Zoom arrière"
              icon={<icons.zoomOut size={16} />}
              onClick={() => zoomStep(-1)}
            />
          </Tooltip>
          <Tooltip title="Zoom avant (Ctrl +)">
            <Button
              aria-label="Zoom avant"
              icon={<icons.zoomIn size={16} />}
              onClick={() => zoomStep(1)}
            />
          </Tooltip>
        </Space.Compact>
        <Select
          size="small"
          aria-label="Niveau de zoom"
          style={{ width: 116 }}
          value={fit ?? 'custom'}
          onChange={(v) => {
            if (v === 'width' || v === 'page') setFit(v);
            else zoomTo(Number(v));
          }}
          options={[
            { value: 'width', label: 'Pleine largeur' },
            { value: 'page', label: 'Page entière' },
            ...(fit === null ? [{ value: 'custom', label: `${Math.round(scale * 100)} %` }] : []),
            ...ZOOM_STEPS.map((z) => ({ value: String(z), label: `${Math.round(z * 100)} %` })),
          ]}
        />

        <Space.Compact size="small">
          <Tooltip title="Pivoter à gauche">
            <Button
              aria-label="Pivoter à gauche"
              icon={<icons.rotateLeft size={16} />}
              onClick={() => setRotation((r) => (r + 270) % 360)}
            />
          </Tooltip>
          <Tooltip title="Pivoter à droite">
            <Button
              aria-label="Pivoter à droite"
              icon={<icons.rotateRight size={16} />}
              onClick={() => setRotation((r) => (r + 90) % 360)}
            />
          </Tooltip>
        </Space.Compact>

        {/*
          `wrap` : sans lui, ce groupe est un SEUL bloc rigide (recherche + compteur + 3 boutons,
          ~276 px) — sur un panneau étroit (visionneuse en colonne, mobile), il ne rétrécit jamais
          (les enfants d'un `Space` ne réduisent pas) et débordait hors de la barre, invisible et
          incliquable puisque `.da-pdf` masque son dépassement (`overflow: hidden`). Avec `wrap`,
          le groupe entier se replie sur sa propre ligne, la recherche pouvant même passer sous les
          boutons d'action plutôt que de forcer la largeur de toute la barre.
        */}
        <Space size={[4, 4]} wrap style={{ marginInlineStart: 'auto', rowGap: 4 }}>
          <Input
            ref={searchRef}
            size="small"
            type="search"
            allowClear
            placeholder="Rechercher…"
            aria-label="Rechercher dans le document"
            prefix={<icons.search size={14} />}
            style={{ width: 140, minWidth: 0 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPressEnter={(e) => stepMatch(e.shiftKey ? -1 : 1)}
          />
          {query.trim() !== '' && (
            <>
              <Typography.Text
                type="secondary"
                // `aria-live` : le décompte est la seule restitution du résultat de la
                // recherche pour un lecteur d'écran, la frappe ne déplaçant pas le focus.
                aria-live="polite"
                style={{ whiteSpace: 'nowrap', fontSize: fontSize.xs }}
              >
                {matches.length === 0 ? 'aucun' : `${matchPos + 1} / ${matches.length}`}
              </Typography.Text>
              <Space.Compact size="small">
                <Button
                  aria-label="Occurrence précédente"
                  icon={<icons.chevronUp size={16} />}
                  disabled={matches.length === 0}
                  onClick={() => stepMatch(-1)}
                />
                <Button
                  aria-label="Occurrence suivante"
                  icon={<icons.chevronDown size={16} />}
                  disabled={matches.length === 0}
                  onClick={() => stepMatch(1)}
                />
              </Space.Compact>
            </>
          )}

          <Tooltip title="Imprimer">
            <Button
              size="small"
              type="text"
              aria-label="Imprimer"
              icon={<icons.print size={16} />}
              onClick={print}
            />
          </Tooltip>
          <Tooltip title="Télécharger">
            <Button
              size="small"
              type="text"
              aria-label="Télécharger"
              icon={<icons.download size={16} />}
              onClick={download}
            />
          </Tooltip>
          <Tooltip title={fullscreen ? 'Quitter le plein écran' : 'Plein écran'}>
            <Button
              size="small"
              type="text"
              aria-label={fullscreen ? 'Quitter le plein écran' : 'Plein écran'}
              icon={
                fullscreen ? <icons.fullscreenExit size={16} /> : <icons.fullscreen size={16} />
              }
              onClick={toggleFullscreen}
            />
          </Tooltip>
        </Space>
      </div>

      <div className="da-pdf__body">
        {thumbs && doc && (
          <div className="da-pdf__thumbs">
            {Array.from({ length: total }, (_, i) => (
              <PdfThumb
                key={i + 1}
                doc={doc}
                pageNumber={i + 1}
                active={pageNum === i + 1}
                onSelect={goToPage}
              />
            ))}
          </div>
        )}

        <div className="da-pdf__scroll" ref={scrollRef}>
          {busy || !doc ? (
            <div className="da-pdf__state">
              {docError ? (
                <EmptyState
                  compact
                  icon="alert"
                  title="Document illisible"
                  action={
                    src ? (
                      <Button size="small" onClick={download}>
                        Télécharger le fichier
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <Spin />
              )}
            </div>
          ) : (
            Array.from({ length: total }, (_, i) => (
              <PdfPageView
                key={i + 1}
                doc={doc}
                pageNumber={i + 1}
                scale={scale}
                rotation={rotation}
                query={query.trim()}
                activeMatch={current?.page === i + 1 ? current.index : -1}
                // Filet de sécurité : la page visée par une navigation (saisie du n° de page,
                // vignette, occurrence de recherche) est peinte sans attendre l'observateur
                // d'intersection, qui reste muet tant que l'onglet ne compose pas d'images.
                forceVisible={Math.abs(pageNum - (i + 1)) <= 1}
                register={(node) => {
                  if (node) pageRefs.current.set(i + 1, node);
                  else pageRefs.current.delete(i + 1);
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** Une page : canvas + couche texte, peinte seulement lorsqu'elle approche du viewport. */
function PdfPageView({
  doc,
  pageNumber,
  scale,
  rotation,
  query,
  activeMatch,
  forceVisible,
  register,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rotation: number;
  query: string;
  activeMatch: number;
  forceVisible: boolean;
  register: (node: HTMLDivElement | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 2 || forceVisible);

  useEffect(() => {
    if (forceVisible) setVisible(true);
  }, [forceVisible]);
  const [painted, setPainted] = useState(0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const node = hostRef.current;
    register(node);
    return () => register(null);
    // Dépendances VOLONTAIREMENT vides : inscription de la page auprès de l'observateur de
    // visibilité, au montage et au démontage seulement. Dépendre de `register` ré-inscrirait
    // toutes les pages à chaque rendu du parent, pour un observateur inchangé.
  }, []);

  // Réserve la place avant peinture pour que la barre de défilement ne saute pas.
  useEffect(() => {
    let cancelled = false;
    void doc.getPage(pageNumber).then((p) => {
      if (cancelled) return;
      const v = p.getViewport({ scale, rotation });
      setSize({ w: Math.floor(v.width), h: Math.floor(v.height) });
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, scale, rotation]);

  useEffect(() => {
    const node = hostRef.current;
    if (!node || visible || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) setVisible(true);
      },
      { root: node.closest('.da-pdf__scroll'), rootMargin: '400px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: RenderTask | null = null;

    void (async () => {
      const pdfjs = await loadPdfJs();
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale, rotation });
      const host = hostRef.current;
      const canvas = canvasRef.current;
      const layer = textRef.current;
      if (!host || !canvas || !layer) return;

      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);
      // pdf.js positionne la couche texte à partir de cette variable CSS.
      host.style.setProperty('--scale-factor', String(scale));

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      // Bitmap et couche texte sont peints en parallèle, sans se bloquer l'un l'autre :
      // pdf.js cadence le rendu canvas sur `requestAnimationFrame`, qui ne se déclenche pas
      // tant que l'onglet est masqué. Découplées, la sélection et la recherche restent
      // disponibles dès que le texte est extrait, même si le bitmap arrive plus tard.
      task = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });

      // La couche texte est peinte dans un conteneur détaché puis substituée d'un bloc :
      // deux rendus concurrents (StrictMode, zoom rapide) cumuleraient sinon leurs <span>
      // dans le même calque, et le surlignage de recherche viserait la mauvaise occurrence.
      const staging = document.createElement('div');
      const textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: staging,
        viewport,
      });

      await Promise.all([
        textLayer.render().then(() => {
          if (cancelled) {
            textLayer.cancel();
            return;
          }
          layer.replaceChildren(...staging.childNodes);
          setPainted((n) => n + 1);
        }),
        task.promise,
      ]);
    })().catch((e: unknown) => {
      // L'annulation est le cas nominal quand on zoome/pivote pendant un rendu.
      if ((e as Error)?.name !== 'RenderingCancelledException') {
        console.error(`[PdfViewer] page ${pageNumber}`, e);
      }
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, scale, rotation, visible]);

  // Surlignage des occurrences dans la couche texte (spans transparents ⇒ seul le fond
  // du <mark> est visible). Le texte d'origine est mémorisé pour pouvoir revenir en arrière.
  useEffect(() => {
    const layer = textRef.current;
    if (!layer || painted === 0) return;
    const spans = layer.querySelectorAll<HTMLElement>('span:not(.markedContent)');
    const needle = query.toLowerCase();
    let seen = 0;

    spans.forEach((span) => {
      span.dataset.raw ??= span.textContent ?? '';
      const raw = span.dataset.raw;
      const hay = raw.toLowerCase();
      if (!needle || !hay.includes(needle)) {
        if (span.childElementCount > 0) span.textContent = raw;
        return;
      }
      let html = '';
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) {
          html += escapeHtml(raw.slice(from));
          break;
        }
        html += escapeHtml(raw.slice(from, at));
        html += `<mark data-current="${seen === activeMatch}">${escapeHtml(
          raw.slice(at, at + needle.length),
        )}</mark>`;
        seen += 1;
        from = at + needle.length;
      }
      span.innerHTML = html;
    });

    layer
      .querySelector('mark[data-current="true"]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [query, activeMatch, painted]);

  return (
    <div
      ref={hostRef}
      className="da-pdf__page"
      data-page={pageNumber}
      style={size ? { width: size.w, height: size.h } : undefined}
    >
      <canvas ref={canvasRef} />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

/** Vignette cliquable d'une page. */
function PdfThumb({
  doc,
  pageNumber,
  active,
  onSelect,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
  onSelect: (n: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: RenderTask | null = null;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const viewport = page.getViewport({ scale: 130 / page.getViewport({ scale: 1 }).width });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, viewport });
      await task.promise;
    })().catch(() => {
      /* vignette best-effort : son échec ne doit pas casser la visionneuse */
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber]);

  return (
    <button
      type="button"
      className="da-pdf__thumb"
      data-active={active}
      onClick={() => onSelect(pageNumber)}
    >
      <canvas ref={canvasRef} />
      <span className="da-pdf__thumb-label">{pageNumber}</span>
    </button>
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
