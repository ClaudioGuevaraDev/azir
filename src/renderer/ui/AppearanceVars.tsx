import { useEffect } from 'react';
import { lineHeightFor } from '@shared/models/settings';
import { useAppState } from '../app/react';
import { selectSettings } from '../app/state';

/**
 * Publishes the appearance settings as CSS custom properties on the root element.
 *
 * Renders nothing. A component rather than a call inside `main.tsx` because the value comes from
 * the store, and this is the one place allowed to write it — the properties are set here and
 * nowhere else, so there is never a question of which write won.
 *
 * The row height is computed by the same `lineHeightFor` the virtual lists use. That is the whole
 * point of routing it through here: the stylesheet and the windowing arithmetic are derived from
 * one number instead of maintained in parallel.
 */
export const AppearanceVars = (): null => {
  const { codeFontSize } = useAppState(selectSettings).appearance;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--azir-code-font-size', `${codeFontSize}px`);
    root.style.setProperty('--azir-code-line-height', `${lineHeightFor(codeFontSize)}px`);
  }, [codeFontSize]);

  return null;
};
