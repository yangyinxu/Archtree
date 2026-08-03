import express, { Application, NextFunction, Request, Response } from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';

import adminRoutes from './routes/adminRoutes';
import authRoutes from './routes/authRoutes';
import contentRoutes from './routes/contentRoutes';
import feedRoutes from './routes/feedRoutes';
import listenerRoutes from './routes/listenerRoutes';
import videoRoutes from './routes/videoRoutes';
import { attachOptionalAuth, AuthenticatedRequest } from './middleware/authMiddleware';
import { getDb } from './infrastructure/database';
import { escapeHtml } from './views/html';
import { maxAudioUploadMb } from './middleware/audioUpload';
import { maxAvatarUploadMb, maxImageUploadMb } from './middleware/imageUpload';
import { applySecurityHeaders } from './middleware/securityHeadersMiddleware';
import { getMediaDeliveryMetrics } from './services/mediaDeliveryService';
import { requireSameOriginCookieMutation } from './services/authCookieService';

export interface CreateAppOptions {
  /** Overrides the production listener bundle location for isolated route tests. */
  listenerDistPath?: string;
  /** Retains explicit runtime context for existing isolated application callers. */
  environment?: string;
}

/** Resolves only files emitted in Vite's manifest for immutable caching. */
const readListenerManifestAssets = (listenerDistPath: string) => {
  const manifestPath = path.join(listenerDistPath, '.vite', 'manifest.json');
  const assets = new Set<string>();
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    for (const value of Object.values(manifest)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const chunk = value as { file?: unknown; css?: unknown; assets?: unknown };
      const filenames = [
        ...(typeof chunk.file === 'string' ? [chunk.file] : []),
        ...(Array.isArray(chunk.css) ? chunk.css : []),
        ...(Array.isArray(chunk.assets) ? chunk.assets : [])
      ];
      for (const filename of filenames) {
        if (typeof filename !== 'string') continue;
        const resolved = path.resolve(listenerDistPath, filename.replace(/^\/+/, ''));
        const relative = path.relative(listenerDistPath, resolved);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          assets.add(resolved);
        }
      }
    }
  } catch {
    // A missing or malformed manifest safely disables long-lived caching.
  }
  return assets;
};

/** Distinguishes missing bundle resources from extensionless listener routes. */
const isListenerAssetRequest = (req: Request) => {
  const listenerPath = req.path.replace(/^\/listen\/?/, '');
  return listenerPath === 'assets'
    || listenerPath.startsWith('assets/')
    || path.posix.extname(listenerPath) !== '';
};

/** Mounts the built listener SPA without allowing its fallback to capture backend routes. */
const mountListenerApplication = (app: Application, listenerDistPath: string) => {
  const indexPath = path.join(listenerDistPath, 'index.html');
  if (!fs.existsSync(indexPath)) {
    app.use('/listen', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        message: 'The Finitude Web listener bundle is unavailable. Build web/dist before starting the listener.'
      });
    });
    return;
  }

  const immutableAssets = readListenerManifestAssets(listenerDistPath);

  app.use('/listen', express.static(listenerDistPath, {
    index: false,
    redirect: false,
    setHeaders: (res, filePath) => {
      if (path.resolve(filePath) === path.resolve(indexPath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      if (immutableAssets.has(path.resolve(filePath))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));

  const sendListenerIndex = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath, (error) => {
      if (error) next(error);
    });
  };
  app.get('/listen', sendListenerIndex);
  app.get('/listen/*', (req, res, next) => {
    if (isListenerAssetRequest(req)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ message: 'The requested listener asset was not found.' });
    }
    return sendListenerIndex(req, res, next);
  });
};

/** Constructs the Express application without connecting to MongoDB or opening a socket. */
export const createApp = (options: CreateAppOptions = {}): Application => {
  const app: Application = express();
  app.disable('x-powered-by');
  const defaultProxyHops = 1;
  const configuredProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? defaultProxyHops);
  app.set('trust proxy', Number.isFinite(configuredProxyHops) && configuredProxyHops >= 0
    ? Math.floor(configuredProxyHops)
    : defaultProxyHops);

  app.use(applySecurityHeaders);
  app.use('/assets', express.static(path.join(__dirname, 'public')));

  // Parse JSON APIs and browser form submissions before their routers.
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, PATCH, DELETE');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Idempotency-Key, If-Match, If-None-Match'
    );
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    next();
  });

  app.use(requireSameOriginCookieMutation);

  app.use('/admin', adminRoutes);
  app.use('/auth', authRoutes);
  app.use('/content', contentRoutes);
  app.use('/feed', feedRoutes);
  app.use('/video', videoRoutes);
  app.use('/api/listener/v1', listenerRoutes);

  const listenerDistPath = options.listenerDistPath
    ?? path.resolve(__dirname, '..', 'web', 'dist');
  mountListenerApplication(app, listenerDistPath);

  app.get('/', attachOptionalAuth, async (req, res, next) => {
    try {
      const auth = (req as AuthenticatedRequest).auth;
      const template = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
      const headerActions = auth
        ? `<div class="header-actions">
          <span class="muted">${escapeHtml(auth.email)}</span>
          <a class="button" href="/content/manage">Content Manager</a>
          <form method="POST" action="/auth/logout-web"><button class="button--secondary" type="submit">Log out</button></form>
        </div>`
        : `<div class="header-actions">
          <a class="button button--secondary" href="/auth/login-web">Log in</a>
          <a class="button" href="/auth/signup-web">Create account</a>
        </div>`;
      const heroActions = auth
        ? `<div class="action-row">
          <a class="button" href="/content/manage">Open Content Manager</a>
          <a class="button button--secondary" href="/content/manage/audio-tracks">Browse my audio tracks</a>
        </div>`
        : `<div class="action-row">
          <a class="button" href="/auth/signup-web">Create account</a>
          <a class="button button--secondary" href="/auth/login-web">Log in</a>
        </div>`;

      return res.status(200).send(
        template
          .replace('{{HEADER_ACTIONS}}', headerActions)
          .replace('{{HERO_ACTIONS}}', heroActions)
      );
    } catch (error) {
      return next(error);
    }
  });

  app.get('/health', async (_req, res) => {
    try {
      const db = getDb();
      if (!db) throw new Error('Database is unavailable.');
      await db.command({ ping: 1 }, { maxTimeMS: 1_000 });
      return res.status(200).json({
        status: 'ok',
        mediaDelivery: getMediaDeliveryMetrics(),
        memory: {
          rssBytes: process.memoryUsage().rss,
          heapUsedBytes: process.memoryUsage().heapUsed
        }
      });
    } catch {
      return res.status(503).json({
        status: 'unavailable',
        mediaDelivery: getMediaDeliveryMetrics()
      });
    }
  });

  app.use((error: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(error);
    }

    const isFileTooLarge = error?.code === 'LIMIT_FILE_SIZE';
    const isTooManyFiles = error?.code === 'LIMIT_FILE_COUNT';
    const isMulterInputError = typeof error?.code === 'string' && error.code.startsWith('LIMIT_');
    const status: number = isFileTooLarge || isTooManyFiles
      ? 413
      : isMulterInputError ? 400 : error.statusCode || 500;
    const message: string = isFileTooLarge
      ? error?.field === 'avatar'
        ? `Avatar is too large. The maximum size is ${maxAvatarUploadMb} MB.`
        : error?.field === 'coverArtFile'
          ? `Cover art is too large. The maximum size is ${maxImageUploadMb} MB.`
          : `Audio file is too large. The maximum size per file is ${maxAudioUploadMb} MB.`
      : isTooManyFiles
        ? 'Too many files were included in this upload.'
        : isMulterInputError
          ? 'Invalid multipart upload.'
          : error.message;
    const data: any = error.data;

    if (status >= 500) {
      console.log(`Caught unexpected request: ${req.originalUrl}`);
      console.log(error);
    }

    if (status >= 500) {
      return res.status(status).json({
        message: 'The service could not complete the request.'
      });
    }
    return res.status(status).json({ message, data });
  });

  return app;
};

// Keep `tsx src/app.ts` as the runtime entry while imports remain side-effect free.
if (typeof require !== 'undefined' && require.main === module) {
  void import('./server')
    .then(({ startServer }) => startServer())
    .catch((error) => {
      console.log(`Error starting Archtree: ${error}`);
      process.exitCode = 1;
    });
}
