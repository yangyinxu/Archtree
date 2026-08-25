import { Request, Response } from 'express';

import {
  LocalizationRepresentation,
  LocalizationService
} from '../services/localizationService';

const matchesIfNoneMatch = (header: string | undefined, etag: string) => {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*'
      || normalized === etag
      || normalized.replace(/^W\//, '') === etag;
  });
};

/** Sends a bounded generated representation with conditional-request metadata. */
const sendRepresentation = (
  req: Request,
  res: Response,
  representation: LocalizationRepresentation
) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('ETag', representation.etag);
  if (representation.locale) res.setHeader('Content-Language', representation.locale);
  if (matchesIfNoneMatch(req.get('If-None-Match'), representation.etag)) {
    return res.status(304).end();
  }
  return res.status(200).type('application/json').send(representation.body);
};

/** Creates public localization handlers backed by one explicit generated-artifact root. */
export const createLocalizationController = (service: LocalizationService) => ({
  manifest: (req: Request, res: Response) =>
    sendRepresentation(req, res, service.getManifest()),

  bundle: (req: Request, res: Response) => {
    const representation = service.getBundle(req.params.locale);
    if (!representation) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ message: 'Localization bundle not found.' });
    }
    return sendRepresentation(req, res, representation);
  }
});
