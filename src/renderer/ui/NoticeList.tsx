import type { Notice } from '../app/state';
import { useDispatch } from '../app/react';
import './NoticeList.css';

export interface NoticeListProps {
  readonly notices: readonly Notice[];
}

/**
 * Overlaid rather than laid out: a subsystem failure must not reflow the
 * workspace, because the panels the user is reading are still usable
 * (docs/architecture.md, Error handling).
 */
export const NoticeList = ({ notices }: NoticeListProps): React.JSX.Element | null => {
  const dispatch = useDispatch();

  if (notices.length === 0) {
    return null;
  }

  return (
    <div className="notices" data-testid="notices">
      {notices.map((notice) => (
        <div key={notice.id} className="notice" data-severity={notice.severity}>
          <div className="notice__body">
            <span className="notice__message">{notice.message}</span>
            {notice.detail !== undefined && (
              <span className="notice__detail azir-selectable">{notice.detail}</span>
            )}
          </div>
          <button
            type="button"
            className="notice__dismiss"
            aria-label="Dismiss"
            onClick={() => dispatch({ type: 'notice/dismissed', id: notice.id })}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};
