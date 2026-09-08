'use client';

import { DatePicker, Segmented } from 'antd';
import dayjs from 'dayjs';

const { RangePicker } = DatePicker;
const ISO = 'YYYY-MM-DD';

export type PeriodPreset = 'today' | '7d' | '30d' | 'month' | 'quarter' | 'year' | 'custom';
export interface Period {
  from: string;
  to: string;
}
export interface PeriodState {
  preset: PeriodPreset;
  period: Period;
}

const OPTIONS: { label: string; value: PeriodPreset }[] = [
  { label: "Aujourd'hui", value: 'today' },
  { label: '7 j', value: '7d' },
  { label: '30 j', value: '30d' },
  { label: 'Mois', value: 'month' },
  { label: 'Trim.', value: 'quarter' },
  { label: 'Année', value: 'year' },
  { label: 'Perso.', value: 'custom' },
];

/** Calcule les bornes (incluses) d'un préset, sans plugin dayjs externe. */
export function presetToPeriod(p: PeriodPreset): Period {
  const to = dayjs();
  switch (p) {
    case 'today':
      return { from: to.format(ISO), to: to.format(ISO) };
    case '7d':
      return { from: to.subtract(6, 'day').format(ISO), to: to.format(ISO) };
    case '30d':
      return { from: to.subtract(29, 'day').format(ISO), to: to.format(ISO) };
    case 'month':
      return { from: to.startOf('month').format(ISO), to: to.format(ISO) };
    case 'quarter': {
      // startOf('quarter') nécessite un plugin → on calcule le 1er mois du trimestre.
      const qStartMonth = Math.floor(to.month() / 3) * 3;
      return { from: to.month(qStartMonth).startOf('month').format(ISO), to: to.format(ISO) };
    }
    case 'year':
      return { from: to.startOf('year').format(ISO), to: to.format(ISO) };
    case 'custom':
      return { from: to.subtract(29, 'day').format(ISO), to: to.format(ISO) };
  }
}

/** Filtre de période global : présets + plage personnalisée (fr-FR, JJ/MM/AAAA). */
export function PeriodFilter({
  value,
  onChange,
}: {
  value: PeriodState;
  onChange: (v: PeriodState) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <Segmented<PeriodPreset>
        size="small"
        options={OPTIONS}
        value={value.preset}
        onChange={(p) =>
          onChange(
            p === 'custom'
              ? { preset: 'custom', period: value.period }
              : { preset: p, period: presetToPeriod(p) },
          )
        }
      />
      {value.preset === 'custom' && (
        <RangePicker
          size="small"
          format="DD/MM/YYYY"
          allowClear={false}
          value={[dayjs(value.period.from), dayjs(value.period.to)]}
          onChange={(vals) => {
            if (vals?.[0] && vals?.[1]) {
              onChange({
                preset: 'custom',
                period: { from: vals[0].format(ISO), to: vals[1].format(ISO) },
              });
            }
          }}
        />
      )}
    </div>
  );
}
