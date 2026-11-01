import { formatLocalizedMessage } from '../../localization/LocalizationProvider';
import { useAdminText } from './AdminAccess';
import { useAdminWebMessages } from './adminWebMessages';
import type { EvidenceBasis } from './lookupProgressModel';
import styles from './adminStyles';

/**
 * A step row in the words of the review's import evidence: one of its identifier searches, or Track titles found not needed after
 * one, or not run because those searches used the room under the query bound.
 */
export type EvidenceStepText = EvidenceBasis | 'trackTitleNotNeeded' | 'trackTitleNoRoom';
const STEPS: Record<EvidenceStepText, string> = {
  releaseIdImport: 'admin.lookup_evidence.step_release_id_import', releaseIdTags: 'admin.lookup_evidence.step_release_id_tags',
  barcode: 'admin.lookup_evidence.step_barcode', catalogNumber: 'admin.lookup_evidence.step_catalog_number',
  trackTitleNotNeeded: 'admin.lookup_evidence.track_title_not_needed', trackTitleNoRoom: 'admin.lookup_evidence.track_title_no_room'
};
const CHOSEN: Record<EvidenceBasis, string> = {
  releaseIdImport: 'admin.lookup_evidence.chosen_release_id_import', releaseIdTags: 'admin.lookup_evidence.chosen_release_id_tags',
  barcode: 'admin.lookup_evidence.chosen_barcode', catalogNumber: 'admin.lookup_evidence.chosen_catalog_number'
};

/**
 * The words of an existing-Album review run that used the import evidence it captured (its own lazy chunk, loaded only for such a
 * run): each identifier search's step, naming only its basis and never a value, inside the step's runtime mark (`mark`: done,
 * unconfirmed, active, pending, not run or skipped), and the Track-title row of such a run that did not need them or had no room
 * for them. The words are release-packaged `web-admin` copy; when it cannot load, the row renders nothing and
 * LookupEvidenceAlert asks for a reload once.
 */
export function LookupEvidenceStep({ text, mark }: { text: EvidenceStepText; mark: string }) {
  const t = useAdminText(), bundle = useAdminWebMessages();
  if (!bundle) return null;
  return <>{t(`catalog_review.lookup_step_${mark}`, { step: formatLocalizedMessage(bundle, STEPS[text]) })}</>;
}

/** The line saying which captured identifier chose the release the run applied as its preselection; nothing without the bundle. */
export function LookupEvidenceBasis({ basis }: { basis: EvidenceBasis }) {
  const bundle = useAdminWebMessages();
  return bundle ? <p className={styles.meta}>{formatLocalizedMessage(bundle, CHOSEN[basis])}</p> : null;
}

/** A bridge row's second line when the titles it names came back from iTunes for the captured barcode; nothing without the bundle. */
export function LookupEvidenceBridgeNote({ titles }: { titles: string }) {
  const bundle = useAdminWebMessages();
  return bundle ? <>{formatLocalizedMessage(bundle, 'admin.lookup_evidence.bridge_note_barcode', { titles })}</> : null;
}

/** The one reload alert of a run whose evidence words cannot load (the bundle is missing); nothing once they can. */
export function LookupEvidenceAlert() {
  const t = useAdminText(), bundle = useAdminWebMessages();
  if (bundle) return null;
  return <div role="alert"><p>{t('common.reload')}</p>
    <button className={styles.button} type="button" onClick={() => window.location.reload()}>{t('common.reload_action')}</button></div>;
}
