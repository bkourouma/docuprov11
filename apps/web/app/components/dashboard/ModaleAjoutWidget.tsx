'use client';

import { Button, List, Modal, Typography } from 'antd';
import { EmptyState } from '../EmptyState';
import { fontSize } from '../../theme/tokens';

/**
 * Modale « Ajouter un widget ». Partagée entre Docu-Courriers et Docu-Archives.
 *
 * Elle n'affiche que le catalogue **autorisé** renvoyé par le serveur, duquel on retire ce qui est
 * déjà placé — un widget ne pouvant figurer qu'une fois. Le filtrage par permission est fait côté
 * API : cette liste ne fait que le refléter, elle ne le décide pas.
 *
 * Le type d'entrée est réduit à ce que la modale affiche réellement : les catalogues des deux
 * modules portent des champs supplémentaires (périmètre, jeu de données) qui ne la regardent pas.
 */
export interface WidgetAjoutable {
  id: string;
  titre: string;
  description: string;
}

export function ModaleAjoutWidget<T extends WidgetAjoutable>({
  ouvert,
  disponibles,
  dejaPlaces,
  onAjouter,
  onFermer,
}: {
  ouvert: boolean;
  disponibles: T[];
  dejaPlaces: string[];
  onAjouter: (def: T) => void;
  onFermer: () => void;
}) {
  const ajoutables = disponibles.filter((d) => !dejaPlaces.includes(d.id));

  return (
    <Modal
      open={ouvert}
      onCancel={onFermer}
      footer={<Button onClick={onFermer}>Fermer</Button>}
      title="Ajouter un widget"
      width={620}
    >
      {ajoutables.length === 0 ? (
        <EmptyState compact icon="analytics" title="Tous les widgets sont déjà affichés" />
      ) : (
        <List
          dataSource={ajoutables}
          renderItem={(d) => (
            <List.Item
              actions={[
                <Button key="add" type="primary" size="small" onClick={() => onAjouter(d)}>
                  Ajouter
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={d.titre}
                description={
                  <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                    {d.description}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
}
