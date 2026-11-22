import { Tag } from 'antd';
import { icons, iconDefaults } from '../../../theme/icons';

/** Nature de l'élément : l'icône ET le libellé disent la même chose (la teinte ne porte jamais seule). */
export function NatureTag({ kind }: { kind: number }) {
  return kind === 1 ? (
    <Tag color="purple" icon={<icons.sparkle {...iconDefaults} size={12} aria-hidden="true" />}>
      Validation d’agent
    </Tag>
  ) : (
    <Tag icon={<icons.users {...iconDefaults} size={12} aria-hidden="true" />}>Tâche humaine</Tag>
  );
}
