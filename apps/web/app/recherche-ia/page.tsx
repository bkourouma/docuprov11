'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, Button, Card, Input, Typography } from 'antd';
import {
  GED_QA_UNKNOWN_ANSWER,
  GED_SEMANTIC_QUERY_MAX_CHARS,
  GED_SEMANTIC_QUERY_MIN_CHARS,
  type GedAskResponse,
  type GedSemanticSearchResponse,
} from '@archivage/types';
import { PageHeader } from '../components/PageHeader';
import { icons, iconDefaults } from '../theme/icons';
import { space } from '../theme/tokens';
import { SemanticApiError, errorMessage, semanticApi } from './semantic-api';
import {
  AnswerText,
  CitationList,
  EmptyResults,
  FulltextBanner,
  HitList,
  ResultsSkeleton,
  UnknownState,
} from './ResultViews';
import './recherche-ia.css';

const { Text } = Typography;

/** La question exige au moins 3 caractères côté API, la recherche 2. */
const ASK_MIN_CHARS = 3;

const EXAMPLES = [
  'Quelles sont les conditions de résiliation du contrat de maintenance ?',
  'Quel est le délai de conservation des factures fournisseurs ?',
  'Que dit le dernier procès-verbal sur le budget de l’année ?',
];

type View =
  | { kind: 'idle' }
  | { kind: 'loading'; action: 'ask' | 'search' }
  | { kind: 'error'; message: string }
  | { kind: 'ask'; data: GedAskResponse }
  | { kind: 'search'; data: GedSemanticSearchResponse };

/**
 * Docu-GED lot 3 : recherche sémantique et questions-réponses.
 *
 * La page n'applique aucun filtre de droits : l'API ne renvoie que des sources autorisées. Le
 * texte de la réponse vient d'un modèle : il est rendu comme texte (jamais en HTML) et seuls
 * les marqueurs [n] correspondant à une citation reçue deviennent des boutons.
 * La garde d'authentification est celle de l'AuthShell (redirection vers /login).
 */
export default function RechercheIaPage() {
  const [text, setText] = useState('');
  const [view, setView] = useState<View>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const loading = view.kind === 'loading';
  const loadingAction = view.kind === 'loading' ? view.action : null;

  // Annule la requête en cours au démontage de la page.
  useEffect(() => () => abortRef.current?.abort(), []);

  const trimmed = text.trim();
  const canAsk = !loading && trimmed.length >= ASK_MIN_CHARS;
  const canSearch = !loading && trimmed.length >= GED_SEMANTIC_QUERY_MIN_CHARS;

  const run = useCallback(async (action: 'ask' | 'search', value: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setView({ kind: 'loading', action });
    try {
      if (action === 'ask') {
        const data = await semanticApi.ask(value, controller.signal);
        setView({ kind: 'ask', data });
      } else {
        const data = await semanticApi.search(value, controller.signal);
        setView({ kind: 'search', data });
      }
    } catch (e) {
      if (controller.signal.aborted) return; // remplacée par une requête plus récente
      const err = e instanceof SemanticApiError ? e : new SemanticApiError('generic');
      setView({ kind: 'error', message: errorMessage(err) });
    }
  }, []);

  const submit = (action: 'ask' | 'search') => {
    if (action === 'ask' ? canAsk : canSearch) void run(action, trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // Maj+Entrée : saut de ligne (comportement natif). Entrée seule et Ctrl/Cmd+Entrée : question.
    if (e.shiftKey) return;
    e.preventDefault();
    submit('ask');
  };

  const useExample = (q: string) => {
    setText(q);
    void run('ask', q);
  };

  const goToSource = (marker: number) => {
    const el = document.getElementById(`ria-source-${marker}`);
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  };

  const Ask = icons.sparkle;
  const Find = icons.search;

  return (
    <div>
      <PageHeader title="Recherche IA" icon="sparkle" />

      <Card>
        <label htmlFor="ria-question" style={{ display: 'block', marginBottom: space.sm, fontWeight: 600 }}>
          Votre question
        </label>
        <Input.TextArea
          id="ria-question"
          aria-label="Votre question"
          aria-describedby="ria-hint ria-count"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={GED_SEMANTIC_QUERY_MAX_CHARS}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder="Posez une question sur vos documents, en langage courant"
        />
        <div className="ria-actions">
          <Text id="ria-hint" type="secondary" style={{ fontSize: 12 }}>
            Entrée pour envoyer, Maj+Entrée pour un saut de ligne.
          </Text>
          <span id="ria-count" className="ria-counter">
            {text.length} / {GED_SEMANTIC_QUERY_MAX_CHARS}
          </span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
          <Button
            type="primary"
            icon={<Ask size={iconDefaults.size} />}
            disabled={!canAsk}
            loading={loadingAction === 'ask'}
            onClick={() => submit('ask')}
          >
            Poser la question
          </Button>
          <Button
            icon={<Find size={iconDefaults.size} />}
            disabled={!canSearch}
            loading={loadingAction === 'search'}
            onClick={() => submit('search')}
          >
            Rechercher
          </Button>
        </div>
      </Card>

      <div aria-live="polite" style={{ marginTop: space.lg }}>
        {view.kind === 'idle' && (
          <Card>
            <Text strong style={{ display: 'block', marginBottom: space.md }}>
              Exemples de questions
            </Text>
            <div className="ria-examples">
              {EXAMPLES.map((q) => (
                <button key={q} type="button" className="ria-example" onClick={() => useExample(q)}>
                  {q}
                </button>
              ))}
            </div>
          </Card>
        )}

        {view.kind === 'loading' && <ResultsSkeleton />}

        {view.kind === 'error' && <Alert type="error" showIcon message={view.message} />}

        {view.kind === 'ask' && <AskResult data={view.data} onMarker={goToSource} />}

        {view.kind === 'search' && <SearchResult data={view.data} />}
      </div>
    </div>
  );
}

function AskResult({ data, onMarker }: { data: GedAskResponse; onMarker: (n: number) => void }) {
  if (data.mode === 'fulltext') {
    return (
      <>
        <FulltextBanner message={data.message} />
        {data.hits.length === 0 ? (
          <EmptyResults />
        ) : (
          <Card title="Documents trouvés">
            <HitList hits={data.hits} label="Documents trouvés par recherche plein texte" />
          </Card>
        )}
      </>
    );
  }
  if (!data.answered) {
    return (
      <Card>
        <UnknownState answer={data.answer || GED_QA_UNKNOWN_ANSWER} />
      </Card>
    );
  }
  const markers = new Set(data.citations.map((c) => c.marker));
  return (
    <>
      <Card title="Réponse">
        <AnswerText text={data.answer} markers={markers} onMarker={onMarker} />
      </Card>
      {data.citations.length > 0 && (
        <Card title="Sources citées" style={{ marginTop: space.lg }}>
          <CitationList citations={data.citations} />
        </Card>
      )}
    </>
  );
}

function SearchResult({ data }: { data: GedSemanticSearchResponse }) {
  const fulltext = data.mode === 'fulltext';
  return (
    <>
      {fulltext && <FulltextBanner message={data.message} />}
      {data.hits.length === 0 ? (
        <EmptyResults />
      ) : (
        <Card title={fulltext ? 'Documents trouvés' : 'Passages pertinents'}>
          <HitList
            hits={data.hits}
            label={fulltext ? 'Documents trouvés par recherche plein texte' : 'Passages pertinents'}
          />
        </Card>
      )}
    </>
  );
}
