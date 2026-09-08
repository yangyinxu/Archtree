/** Shared Content Manager request decoding and response helpers; no catalog persistence belongs here. */
import { Request, Response } from 'express';
import { SimpleDate } from '../../models/simpleDate';
import { AuthenticatedRequest } from '../../middleware/authMiddleware';

/** Decodes legacy comma-separated form relationships before their domain validation. */
export const parseCsv = (value: string) => {
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean) as [string];
};

/** Preserves the form contract for empty and invalid calendar inputs. */
export const parseDateInput = (value: string) => {
    if (!value) {
        return new SimpleDate();
    }

    const [yearRaw, monthRaw, dayRaw] = value.split('-');
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);

    if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
        return new SimpleDate();
    }

    return new SimpleDate(year, month, day);
};

/** Reads stored provenance; it never grants authorization to mutate shared content. */
export const getContentProvenanceId = (doc: any) => {
    return String(doc?.createdBy ?? '');
};

/** Returns an encoded administrator outcome to the Catalog workspace. */
export const redirectWithMessage = (res: Response, message: string) => {
    res.redirect(`/content/manage?view=catalog&message=${encodeURIComponent(message)}`);
};

/** Keeps controller-level Content Manager access admin-only if route guards are bypassed. */
export const rejectNonAdminManagerRequest = (req: AuthenticatedRequest, res: Response) => {
    if (req.auth?.role === 'admin') return false;
    res.status(403).type('text/plain').send('Administrator access is required.');
    return true;
};

/** Keeps asynchronous uploads and ordinary forms on their existing error response contracts. */
export const respondToUploadError = (req: Request, res: Response, message: string, status: number = 400) => {
    if (req.get('X-Requested-With') === 'XMLHttpRequest') {
        return res.status(status).json({ message });
    }
    return redirectWithMessage(res, message);
};
