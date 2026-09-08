'use client';

import '@ant-design/v5-patch-for-react-19';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { App, ConfigProvider } from 'antd';
import frFR from 'antd/locale/fr_FR';
import { MotionConfig } from 'motion/react';
import { buildTheme } from '../theme/antdTheme';

type Mode = 'light' | 'dark';

interface ThemeCtx {
  mode: Mode;
  toggle: () => void;
  setMode: (m: Mode) => void;
}

const ThemeContext = createContext<ThemeCtx>({
  mode: 'light',
  toggle: () => {},
  setMode: () => {},
});

/** Accès au mode clair/sombre et à son basculement, partout dans l'app. */
export function useThemeMode(): ThemeCtx {
  return useContext(ThemeContext);
}

const STORAGE_KEY = 'da-theme';

/**
 * Fournisseurs globaux : thème AntD (clair uniquement — le sombre n'est plus
 * proposé), locale FR, contexte App (toasts/confirm), et respect de
 * prefers-reduced-motion via MotionConfig.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Thème sombre retiré de l'interface : sa bascule ne figure plus dans la barre du haut
  // (cf. `TopBar`) et le choix persistant n'est plus relu au montage — un « dark » resté en
  // stockage d'une session précédente ne peut donc plus rendre l'application sombre sans
  // moyen d'en sortir. Le contexte reste en place (`StatTile`, `charts`… lisent `mode`).
  const [mode, setModeState] = useState<Mode>('light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
  }, [mode]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    window.localStorage.setItem(STORAGE_KEY, m);
  }, []);

  const toggle = useCallback(() => setMode(mode === 'dark' ? 'light' : 'dark'), [mode, setMode]);

  const theme = useMemo(() => buildTheme(mode), [mode]);
  const ctx = useMemo(() => ({ mode, toggle, setMode }), [mode, toggle, setMode]);

  return (
    <ThemeContext.Provider value={ctx}>
      <ConfigProvider locale={frFR} theme={theme}>
        <MotionConfig reducedMotion="user">
          <App>{children}</App>
        </MotionConfig>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
