import { useRef, useState } from 'react';

import { Icon } from '../components/Icon';
import { ModalDialog } from '../components/ModalDialog';
import {
  localeDisplayName,
  useLocalization
} from './LocalizationProvider';
import type { LocalePreference } from './contract';
import styles from './LanguageSelector.module.css';

export interface LanguageSelectorProps {
  placement?: 'sidebar' | 'mobile';
}

/** Provides a Spotify-like quick language switch without coupling it to account state. */
export const LanguageSelector = ({ placement = 'sidebar' }: LanguageSelectorProps) => {
  const {
    availableLocales,
    clearSelectionError,
    errorPreference,
    locale,
    pendingPreference,
    preference,
    selectPreference,
    t
  } = useLocalization();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);
  const activeLanguage = availableLocales.find((entry) => entry.locale === locale)?.nativeName
    ?? localeDisplayName(locale, locale, t);
  const preferences: LocalePreference[] = availableLocales.map(
    ({ locale: availableLocale }) => availableLocale
  );

  const openDialog = () => {
    clearSelectionError();
    setOpen(true);
  };
  const closeDialog = () => {
    if (!pendingPreference) setOpen(false);
  };
  const choose = async (nextPreference: LocalePreference) => {
    if (nextPreference === preference) {
      setOpen(false);
      return;
    }
    const changed = await selectPreference(nextPreference);
    if (changed) setOpen(false);
  };
  const preferenceName = (value: LocalePreference) =>
    availableLocales.find((entry) => entry.locale === value)?.nativeName
      ?? localeDisplayName(value, locale, t);

  const trigger = (
    <button
      aria-haspopup="dialog"
      aria-label={t('language.button.change', { language: activeLanguage })}
      className={styles.trigger}
      onClick={openDialog}
      ref={triggerRef}
      type="button"
    >
      <Icon name="language" />
      <span className={styles.triggerText}>{activeLanguage}</span>
    </button>
  );

  return (
    <>
      {placement === 'sidebar'
        ? <div className={styles.footer}>{trigger}</div>
        : <div className={styles.mobileTrigger}>{trigger}</div>}
      {open && (
        <ModalDialog
          closeDisabled={Boolean(pendingPreference)}
          description={t('language.dialog.web_description')}
          initialFocusRef={firstOptionRef}
          kicker={t('language.dialog.kicker')}
          onClose={closeDialog}
          returnFocusRef={triggerRef}
          title={t('language.dialog.title')}
        >
          <fieldset className={styles.options} disabled={Boolean(pendingPreference)}>
            <legend className="visually-hidden">{t('language.dialog.title')}</legend>
            {preferences.map((option, index) => {
              const optionName = preferenceName(option);
              const localeMetadata = availableLocales.find((entry) => entry.locale === option);
              const optionDescription = localeMetadata?.englishName ?? optionName;
              const descriptionId = `finitude-language-${placement}-${option}-description`;
              const checked = preference === option;
              return (
                <label className={styles.option} key={option}>
                  <input
                    aria-describedby={descriptionId}
                    aria-label={optionName}
                    checked={checked}
                    name={`finitude-language-${placement}`}
                    onChange={() => void choose(option)}
                    ref={index === 0 ? firstOptionRef : undefined}
                    type="radio"
                    value={option}
                  />
                  <span className={styles.optionCopy}>
                    <span
                      className={styles.optionName}
                      dir="auto"
                      lang={option}
                    >
                      {optionName}
                    </span>
                    <span
                      className={styles.optionDescription}
                      dir="ltr"
                      id={descriptionId}
                      lang="en-US"
                    >
                      {optionDescription}
                    </span>
                  </span>
                  {checked && <Icon className={styles.optionCheck} name="check" />}
                </label>
              );
            })}
          </fieldset>
          {pendingPreference && (
            <p aria-live="polite" className={styles.status} role="status">
              {t('language.status.downloading', {
                language: preferenceName(pendingPreference)
              })}
            </p>
          )}
          {errorPreference && (
            <p className={`${styles.status} ${styles.error}`} role="alert">
              {t('language.status.unavailable', {
                language: preferenceName(errorPreference)
              })}
            </p>
          )}
          <div className={styles.actions}>
            <button
              className={styles.cancel}
              disabled={Boolean(pendingPreference)}
              onClick={closeDialog}
              type="button"
            >
              {t('common.action.cancel')}
            </button>
          </div>
        </ModalDialog>
      )}
    </>
  );
};
