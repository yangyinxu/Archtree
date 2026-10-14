import { useRef, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Icon } from '../components/Icon';
import { useSearchQuery } from '../features/search/SearchQueryProvider';
import { useSearchHistoryRecorder } from '../features/search/useSearchHistoryRecorder';
import { useLocalization } from '../localization/LocalizationProvider';
import styles from './AppShell.module.css';

/** Loads search submission behavior independently without moving its shared draft state. */
export default function TopSearch() {
  const input = useRef<HTMLInputElement>(null);
  const { recordSubmittedQuery } = useSearchHistoryRecorder();
  const {
    commitDraft,
    draftQuery,
    finishComposition,
    isComposing,
    startComposition,
    updateDraft
  } = useSearchQuery();
  const { t } = useLocalization();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isComposing) return;
    const normalized = commitDraft();
    if (normalized) recordSubmittedQuery(normalized);
  };

  const preventCompositionSubmit = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) {
      event.preventDefault();
    }
  };

  const expandCompactSearch = (event: MouseEvent<HTMLButtonElement>) => {
    if (window.matchMedia?.('(max-width: 479px)').matches && document.activeElement !== input.current) {
      event.preventDefault();
      input.current?.focus();
    }
  };

  return (
    <form className={styles.search} role="search" aria-label={t('shell.search.global_label')} onSubmit={submit}>
      <button
        className={styles.searchSubmit}
        onClick={expandCompactSearch}
        type="submit"
        aria-label={t('shell.search.submit_label')}
      >
        <Icon name="search" />
      </button>
      <label className="visually-hidden" htmlFor="shell-search">{t('shell.search.field_label')}</label>
      <input
        enterKeyHint="search"
        id="shell-search"
        name="q"
        onChange={(event) => updateDraft(event.currentTarget.value)}
        onCompositionEnd={(event) => finishComposition(event.currentTarget.value)}
        onCompositionStart={startComposition}
        onKeyDown={preventCompositionSubmit}
        placeholder={t('shell.search.placeholder')}
        ref={input}
        type="search"
        value={draftQuery}
      />
    </form>
  );
}
