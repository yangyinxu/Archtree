import { Request, Response, NextFunction } from 'express';
import { boundedSearchQuery } from '../utils/search';
import { getPublicOrganization, searchPublicCatalog } from '../services/publicCatalogService';
import { boundedLimit } from '../utils/pagination';

/** Returns the existing allowlisted public search projection with bounded results. */
export const searchContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const rawQuery = boundedSearchQuery(req.query.q);
        if (!rawQuery) {
            return res.status(400).json({ message: 'Missing required query parameter: q' });
        }

        const limit = boundedLimit(req.query.limit, 10, 50);

        return res.status(200).json(await searchPublicCatalog(rawQuery, limit));
    } catch (error) {
        return next(error);
    }
};

/** Returns an allowlisted legacy-client Organization detail envelope. */
export const getOrganization = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const result = await getPublicOrganization(String(req.params.organizationId ?? ''));
        if (!result) return res.status(404).json({ message: 'Organization not found.' });
        return res.status(200).json(result);
    } catch (error) {
        return next(error);
    }
};
