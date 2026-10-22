/**
 * The Artist and label Organization records administrator writers create: import publications and applied existing-Album reviews.
 * A new record is ready, names its creating administrator, takes the visibility its writer gives it (the Album's) and the catalog
 * search projection of its name, and keeps a MusicBrainz ID only when its identity records one. No I/O.
 */
import { ObjectId } from 'mongodb';
import { catalogSearchProjection } from '../../utils/catalogSearch';

type NewRecordInput = { id: string; name: string; actorId: string; visibility: 'public' | 'hidden'; musicBrainzId?: string | null };

/** A new Artist; `albumIds` holds the Albums it is a primary Artist of (Credit writes keep it in sync afterwards). */
export const newArtistRecord = ({ id, name, albumIds, actorId, visibility, musicBrainzId = null }: NewRecordInput & { albumIds: string[] }) => ({
    _id: new ObjectId(id), name, bio: '', birthDate: {}, coverArtUrl: '', albumIds, createdBy: actorId, lifecycleStatus: 'ready', lifecycleUpdatedAt: new Date(),
    lifecycleError: null, referenceRevision: 0, visibility, ...catalogSearchProjection(name), ...(musicBrainzId ? { musicBrainzId } : {})
});

/** A new Organization of type label. */
export const newLabelOrganizationRecord = ({ id, name, actorId, visibility, musicBrainzId = null }: NewRecordInput) => ({
    _id: new ObjectId(id), name, organizationType: 'label', description: '', createdBy: actorId, lifecycleStatus: 'ready', lifecycleUpdatedAt: new Date(),
    lifecycleError: null, referenceRevision: 0, visibility, ...catalogSearchProjection(name), ...(musicBrainzId ? { musicBrainzId } : {})
});
