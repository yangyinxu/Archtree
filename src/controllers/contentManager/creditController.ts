/** Adapts Organization and role-bearing Credit forms while preserving explicit attribution choices. */
import { Request, Response, NextFunction } from 'express';
import { Album } from '../../models/album';
import { AudioTrack } from '../../models/audioTrack';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';
import { ObjectId } from 'mongodb';
import { normalizeUtf8Text } from '../../utils/textEncoding';
import {
    catalogCreditRoles,
    catalogCreditSubjectTypes,
    createCatalogCreditId
} from '../../models/catalogCredit';
import { Organization, organizationTypes } from '../../models/organization';
import { deleteUnreferencedOrganization } from '../../services/organizationLifecycleService';
import {
    addCatalogCredit,
    addSoundtrackCredit,
    removeCatalogCredit,
    reorderCatalogCredits,
    replaceCatalogCredits
} from '../../services/catalogCreditService';
import { rejectNonAdminManagerRequest, redirectWithMessage, parseDateInput } from './requestHelpers';
import { organizationCreditRoleOptions } from '../../views/contentManager/managePageView';

const creditOwnerRedirect = (
    res: Response,
    ownerType: 'album' | 'audioTrack',
    ownerId: string,
    message: string
) => res.redirect(`/content/manage?view=catalog&prefillType=${ownerType}&prefillId=${encodeURIComponent(ownerId)}&message=${encodeURIComponent(message)}#${ownerType === 'album' ? 'album-update-card' : 'audio-track-update-card'}`);

/** Creates a non-Artist institution that can receive release Credits. */
export const createOrganizationWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const name = String(req.body.name ?? '').trim();
        const organizationType = String(req.body.organizationType ?? 'other');
        if (!name || !organizationTypes.includes(organizationType as any)) {
            return redirectWithMessage(res, 'Enter an Organization name and valid type.');
        }
        const organization = new Organization(
            name,
            organizationType as any,
            String(req.body.description ?? ''),
            authReq.auth.userId
        );
        const result = await organization.save();
        return redirectWithMessage(res, `Organization created: ${String(result.insertedId)}.`);
    } catch (error) {
        return next(error);
    }
};

/** Creates an Organization-only Album with its institutional Credit fenced in the insert transaction. */
export const createOrganizationReleaseWeb = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const organizationId = String(req.body.organizationId ?? '').trim().toLowerCase();
        const title = normalizeUtf8Text(String(req.body.title ?? '').trim());
        const role = String(req.body.role ?? 'publisher');
        if (!ObjectId.isValid(organizationId) || !title || title.length > 300
            || !organizationCreditRoleOptions.some(([value]) => value === role)) {
            return redirectWithMessage(res, 'Choose a valid Organization, Album title, and institutional role.');
        }
        const albumId = new ObjectId();
        const album = new Album(
            title,
            '',
            [] as unknown as [string],
            parseDateInput(String(req.body.releaseDate ?? '')),
            authReq.auth.userId,
            albumId
        );
        album.credits = [{
            creditId: createCatalogCreditId(),
            subjectType: 'organization',
            subjectId: organizationId,
            role: role as any,
            order: 0
        }];
        album.attributionStatus = 'documented';
        album.creditRevision = 1;
        await album.save();
        const message = `Organization release created: ${title}.`;
        return res.redirect(`/content/manage?view=catalog&prefillType=album&prefillId=${albumId.toHexString()}&message=${encodeURIComponent(message)}#album-update-card`);
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Updates Organization metadata without changing any Catalog Credits. */
export const updateOrganizationWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const organizationId = String(req.body.organizationId ?? '').trim();
        const organizationType = String(req.body.organizationType ?? '');
        const name = String(req.body.name ?? '').trim();
        if (!name || !organizationTypes.includes(organizationType as any)) {
            return redirectWithMessage(res, 'Enter an Organization name and valid type.');
        }
        await Organization.updateById(organizationId, {
            name,
            organizationType,
            description: String(req.body.description ?? '')
        });
        return redirectWithMessage(res, 'Organization updated successfully.');
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Deletes only an Organization that no Album or MediaTrack still credits. */
export const deleteOrganizationWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        await deleteUnreferencedOrganization(String(req.body.organizationId ?? '').trim());
        return redirectWithMessage(res, 'Organization deleted successfully.');
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return redirectWithMessage(res, String((error as Error).message));
        }
        return next(error);
    }
};

/** Adds one ordered role-bearing Credit from a named Content Manager selection. */
export const addCatalogCreditWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        const subjectType = String(req.body.subjectType ?? '');
        const subjectId = String(req.body.subjectId ?? '').trim();
        const role = String(req.body.role ?? '');
        if (!catalogCreditSubjectTypes.includes(subjectType as any)
            || !catalogCreditRoles.includes(role as any)) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Choose a valid Credit subject and role.');
        }
        const credit = {
            creditId: createCatalogCreditId(),
            subjectType,
            subjectId,
            role,
            order: 0
        };
        if (ownerType === 'audioTrack') {
            await addSoundtrackCredit(
                ownerId,
                credit,
                req.body.promoteToAlbumPrimary === 'true'
            );
        } else {
            await addCatalogCredit(ownerType, ownerId, credit);
        }
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit added successfully.');
    } catch (error) {
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
            return creditOwnerRedirect(
                res,
                ownerType,
                String(req.body.ownerId ?? ''),
                String((error as Error).message)
            );
        }
        return next(error);
    }
};

/** Removes one Credit and explicitly marks an empty owner as attribution unknown. */
export const removeCatalogCreditWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        await removeCatalogCredit(
            ownerType,
            ownerId,
            String(req.body.creditId ?? '').trim(),
            'unknown'
        );
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit removed successfully.');
    } catch (error) {
        return next(error);
    }
};

const loadCreditOwner = (ownerType: 'album' | 'audioTrack', ownerId: string) => ownerType === 'album'
    ? Album.findById(ownerId)
    : AudioTrack.findById(ownerId);

/** Changes one Credit role while preserving its stable ID and order. */
export const updateCatalogCreditRoleWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        const creditId = String(req.body.creditId ?? '').trim();
        const role = String(req.body.role ?? '').trim();
        if (!catalogCreditRoles.includes(role as any)) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Choose a valid Credit role.');
        }
        const owner: any = await loadCreditOwner(ownerType, ownerId);
        const credits = Array.isArray(owner?.credits) ? owner.credits : [];
        if (!credits.some((credit: any) => credit.creditId === creditId)) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Credit not found. Reload and try again.');
        }
        await replaceCatalogCredits(
            ownerType,
            ownerId,
            credits.map((credit: any) => credit.creditId === creditId ? { ...credit, role } : credit),
            'documented',
            Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0
        );
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit role updated successfully.');
    } catch (error) {
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return creditOwnerRedirect(res, ownerType, String(req.body.ownerId ?? ''), String((error as Error).message));
        }
        return next(error);
    }
};

/** Moves one Credit by one position using optimistic revision control. */
export const reorderCatalogCreditWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        const creditId = String(req.body.creditId ?? '').trim();
        const owner: any = await loadCreditOwner(ownerType, ownerId);
        const credits = Array.isArray(owner?.credits) ? owner.credits : [];
        const from = credits.findIndex((credit: any) => credit.creditId === creditId);
        const delta = req.body.direction === 'up' ? -1 : req.body.direction === 'down' ? 1 : 0;
        const to = from + delta;
        if (from < 0 || delta === 0 || to < 0 || to >= credits.length) {
            return creditOwnerRedirect(res, ownerType, ownerId, 'Credit cannot be moved in that direction.');
        }
        const orderedIds = credits.map((credit: any) => String(credit.creditId));
        [orderedIds[from], orderedIds[to]] = [orderedIds[to], orderedIds[from]];
        await reorderCatalogCredits(
            ownerType,
            ownerId,
            orderedIds,
            Number.isInteger(owner.creditRevision) ? owner.creditRevision : 0
        );
        return creditOwnerRedirect(res, ownerType, ownerId, 'Credit order updated successfully.');
    } catch (error) {
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        if (Number((error as any)?.statusCode) >= 400 && Number((error as any)?.statusCode) < 500) {
            return creditOwnerRedirect(res, ownerType, String(req.body.ownerId ?? ''), String((error as Error).message));
        }
        return next(error);
    }
};

/** Explicitly records that attribution is undocumented instead of creating a fake subject. */
export const markCatalogAttributionUnknownWeb = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.auth) return res.redirect('/auth/login-web?returnTo=%2Fcontent%2Fmanage');
        if (rejectNonAdminManagerRequest(authReq, res)) return;
        const ownerType = req.body.ownerType === 'audioTrack' ? 'audioTrack' : 'album';
        const ownerId = String(req.body.ownerId ?? '').trim();
        await replaceCatalogCredits(ownerType, ownerId, [], 'unknown');
        return creditOwnerRedirect(res, ownerType, ownerId, 'Attribution marked as not documented.');
    } catch (error) {
        return next(error);
    }
};
