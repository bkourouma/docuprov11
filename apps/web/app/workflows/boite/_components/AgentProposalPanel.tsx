import { Alert } from 'antd';
import type { WfInboxItemDto } from '@archivage/types';
import { formatConfidence } from '../../_lib/format';
import { describeSources, prettyJson, proposalText } from '../../_lib/inbox-logic';

type ProposalItem = Pick<WfInboxItemDto, 'explanation' | 'proposal' | 'sources' | 'confidence'>;

/**
 * Explication d'une proposition d'agent (élément de boîte de nature « validation d'agent »).
 *
 * Tout ce qui vient de l'agent est du TEXTE BRUT (React échappe : aucun `dangerouslySetInnerHTML`, aucun
 * lien cliquable, y compris dans les sources). Le composant n'a ni état ni effet : il se rend aussi côté
 * serveur et se teste avec `renderToStaticMarkup`.
 */
export function AgentProposalPanel({ item }: { item: ProposalItem }) {
  const explanation = typeof item.explanation === 'string' && item.explanation.trim() !== '' ? item.explanation : null;
  const text = proposalText(item.proposal);
  const json = text === null ? prettyJson(item.proposal) : '';
  const hasProposal = text !== null || json !== '';
  const sources = describeSources(item.sources);
  const confidence = formatConfidence(item.confidence);

  return (
    <section className="wfb-agent" aria-labelledby="wfb-agent-title">
      <h3 id="wfb-agent-title" className="wfb-agent-title">
        Ce que l’agent propose et pourquoi
      </h3>

      {!explanation && !hasProposal ? (
        <p className="wf-muted wfb-agent-empty">
          L’agent n’a fourni ni explication ni proposition lisible. Vous pouvez saisir vous-même le résultat, ou
          refuser la tâche.
        </p>
      ) : (
        <>
          {explanation && (
            <div className="wfb-agent-block">
              <h4 className="wfb-sub">Explication</h4>
              <p className="wfb-text">{explanation}</p>
            </div>
          )}
          {hasProposal && (
            <div className="wfb-agent-block">
              <h4 className="wfb-sub">Proposition</h4>
              {text !== null ? <p className="wfb-text wfb-proposal">{text}</p> : <pre className="wf-pre">{json}</pre>}
            </div>
          )}
        </>
      )}

      {sources.length > 0 && (
        <div className="wfb-agent-block">
          <h4 className="wfb-sub">Sources</h4>
          <ul className="wfb-sources">
            {sources.map((s, i) => (
              <li key={`${i}-${s}`}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="wfb-confidence">
        {confidence ? (
          <span role="img" aria-label={`Confiance : ${confidence}`}>
            Confiance : <strong>{confidence}</strong>
          </span>
        ) : (
          <span className="wf-muted">Confiance : non indiquée</span>
        )}
      </p>

      <Alert
        type="info"
        showIcon
        message="Cette proposition n’a aucun effet tant que vous ne l’avez pas acceptée."
      />
    </section>
  );
}
