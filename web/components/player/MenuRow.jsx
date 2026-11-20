'use client';
import Icon from '../Icon';

/**
 * One selectable row, shared by every player menu.
 *
 * MODULE SCOPE, deliberately - and now its own module so the quality and audio
 * menus cannot each grow a private copy that drifts. Defined inside a parent
 * component it was a new component TYPE on every render, so React unmounted and
 * remounted every row instead of updating it, and a click needs mousedown and
 * mouseup to land on the SAME element. The menus re-render constantly while
 * open (a 3s idle timer, plus subLoading and sourcesPending arriving from the
 * network), so a remount routinely landed mid-press and the click never fired.
 * The reported symptom was that the left of a row did nothing while the right
 * worked: pressing the label was simply likelier to straddle a remount.
 *
 * `loading` marks a row whose file is still downloading. A reliable subtitle
 * can cost several sequential attempts (measured: 12s across 18 candidates on
 * Baahubali 2), and without this the row looked identical whether it was
 * working or broken.
 *
 * The whole row is one <button>, so the label, the gap and the meta all
 * activate it - there is no dead zone by construction.
 */
const MenuRow = ({ label, meta, selected, loading, dim, onClick }) => (
  <button type="button" role="menuitemradio" aria-checked={Boolean(selected)}
          aria-current={selected ? 'true' : undefined}
          aria-busy={loading || undefined}
          className={`pmenu-item focusable ${selected ? 'on' : ''}${dim ? ' dim' : ''}`} data-focus=""
          onClick={onClick}>
    <span className="pmenu-marker" aria-hidden="true">
      {loading ? <span className="pmenu-spin" />
        : selected && <Icon name="check" size={16} className="pmenu-check" />}
    </span>
    <span className="pmenu-copy">
      <span className="pmenu-text">{label}</span>
      {loading ? <span className="pmenu-meta">Loading…</span>
        : meta && <span className="pmenu-meta">{meta}</span>}
    </span>
  </button>
);

export default MenuRow;
