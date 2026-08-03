import { NextFunction, Request, Response } from 'express';

import { setBrowserSessionPrivacyHeaders } from '../services/authCookieService';
import {
    ListenerTelemetryValidationError,
    recordListenerTelemetryBatch
} from '../services/listenerTelemetryService';

/** Accepts anonymous, bounded listener diagnostics without reflecting event data. */
export const ingestListenerTelemetry = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    setBrowserSessionPrivacyHeaders(res);
    try {
        recordListenerTelemetryBatch(req.body);
        return res.status(204).send();
    } catch (error) {
        if (error instanceof ListenerTelemetryValidationError) {
            return res.status(error.statusCode).json({ message: error.message });
        }
        return next(error);
    }
};
