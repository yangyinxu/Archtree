/** Moves keyboard focus after a skip action or route change has committed. */
export const focusMainContent = () => {
  window.setTimeout(() => {
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, 0);
};
