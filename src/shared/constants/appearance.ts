/**
 * The window's background colour, in the one place both processes can reach.
 *
 * Electron paints `backgroundColor` before the renderer has produced a frame, so this value has to
 * exist in main — but it is the same colour as `--azir-bg` in renderer/ui/tokens.css, and the two
 * being written out separately is how a startup flash gets introduced by a palette change that
 * looked complete. Main imports this; the stylesheet cannot, so `test/tokens.test.ts` reads
 * tokens.css and fails if the literal there has drifted from this one.
 */
export const WINDOW_BACKGROUND = '#050506';
