import { NextFunction, Request, Response } from 'express';
import {
    getMediaDeliveryMetrics,
    markMediaRequestFinished,
    markMediaRequestRejected,
    markMediaRequestStarted
} from '../services/mediaDeliveryService';

const configuredPerIpLimit = Number(process.env.MAX_MEDIA_REQUESTS_PER_IP ?? 8);
const configuredGlobalLimit = Number(process.env.MAX_MEDIA_REQUESTS_GLOBAL ?? 200);
const perIpLimit = Number.isFinite(configuredPerIpLimit) && configuredPerIpLimit > 0
    ? Math.floor(configuredPerIpLimit)
    : 8;
const globalLimit = Number.isFinite(configuredGlobalLimit) && configuredGlobalLimit > 0
    ? Math.floor(configuredGlobalLimit)
    : 200;
const activeRequestsByIp = new Map<string, number>();

export const limitMediaConcurrency = (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || req.socket.remoteAddress || 'unknown';
    const clientActiveRequests = activeRequestsByIp.get(clientId) ?? 0;
    const globalActiveRequests = getMediaDeliveryMetrics().activeRequests;

    if (clientActiveRequests >= perIpLimit || globalActiveRequests >= globalLimit) {
        markMediaRequestRejected();
        res.setHeader('Retry-After', '2');
        return res.status(429).json({ message: 'Too many concurrent media requests.' });
    }

    activeRequestsByIp.set(clientId, clientActiveRequests + 1);
    markMediaRequestStarted();
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        res.off('finish', release);
        res.off('close', release);
        const remaining = (activeRequestsByIp.get(clientId) ?? 1) - 1;
        if (remaining <= 0) {
            activeRequestsByIp.delete(clientId);
        } else {
            activeRequestsByIp.set(clientId, remaining);
        }
        markMediaRequestFinished();
    };
    res.once('finish', release);
    res.once('close', release);
    return next();
};
