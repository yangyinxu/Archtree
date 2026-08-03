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
import {
  attachOptionalAuth,
  requireAdmin,
  requireAdminForWeb,
  requireAuth,
  requireAuthForWeb,
  type AuthContext,
  type AuthenticatedRequest
} from './middleware/authMiddleware';
import { getHealth } from './controllers/healthController';
import { escapeHtml } from './views/html';
import { maxAudioUploadMb } from './middleware/audioUpload';
import { maxAvatarUploadMb, maxImageUploadMb } from './middleware/imageUpload';
import { applySecurityHeaders } from './middleware/securityHeadersMiddleware';
import {
  requireStrictSameOriginBrowserMutation,
  requireSameOriginCookieMutation
} from './services/authCookieService';
import {
  listenerTelemetryConcurrencyLimit,
  listenerTelemetryRateLimit
} from './middleware/requestProtectionMiddleware';

export interface CreateAppOptions {
  /** Overrides the production listener bundle location for isolated route tests. */
  listenerDistPath?: string;
  /** Retains explicit runtime context for existing isolated application callers. */
  environment?: string;
}

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Identifies shared-content mutations that must authorize before body parsing. */
export const requiresEarlySharedContentAdmin = (method: string, originalUrl: string) => {
  if (!unsafeMethods.has(method.toUpperCase())) return false;
  const pathname = originalUrl.split('?', 1)[0];
  if (pathname === '/feed/post' || pathname.startsWith('/feed/post/')) return true;
  if (!pathname.startsWith('/content/') || pathname.startsWith('/content/me/')) return false;
  return pathname !== '/content/manage' && !pathname.startsWith('/content/manage/');
};

/** Installs an authoritative admin context before JSON, form, or multipart work. */
export const requireSharedContentAdminBeforeBody = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!requiresEarlySharedContentAdmin(req.method, req.originalUrl)) return next();
  return requireAuth(req, res, () => requireAdmin(req, res, next));
};

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

export interface LandingActions {
  headerActions: string;
  heroActions: string;
}

/** Keeps public listening visible while exposing management actions only to administrators. */
export const renderLandingActions = (
  auth?: Pick<AuthContext, 'email' | 'role'>
): LandingActions => {
  const listenerButton = '<a class="button button--listener" href="/listen">Open Finitude</a>';
  if (auth) {
    const contentManagerHeaderAction = auth.role === 'admin'
      ? '<a class="button" href="/content/manage">Content Manager</a>'
      : '';
    const adminHeroActions = auth.role === 'admin'
      ? `<a class="button" href="/content/manage">Open Content Manager</a>
        <a class="button button--secondary" href="/content/manage/audio-tracks">Browse audio tracks</a>`
      : '';
    return {
      headerActions: `<div class="header-actions">
        ${listenerButton}
        <span class="muted">${escapeHtml(auth.email)}</span>
        ${contentManagerHeaderAction}
        <form method="POST" action="/auth/logout-web"><button class="button--secondary" type="submit">Log out</button></form>
      </div>`,
      heroActions: `<div class="action-row">
        ${listenerButton}
        ${adminHeroActions}
      </div>`
    };
  }

  return {
    headerActions: `<div class="header-actions">
      ${listenerButton}
      <a class="button button--secondary" href="/auth/login-web">Log in</a>
      <a class="button" href="/auth/signup-web">Create account</a>
    </div>`,
    heroActions: `<div class="action-row">
      ${listenerButton}
      <a class="button" href="/auth/signup-web">Create account</a>
      <a class="button button--secondary" href="/auth/login-web">Log in</a>
    </div>`
  };
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

  // Cookie mutation proof and shared-content authorization must run before a
  // rejected request can consume application body-parser or upload work.
  app.use(requireSameOriginCookieMutation);
  app.use('/content/manage', requireAuthForWeb, requireAdminForWeb);
  app.use(requireSharedContentAdminBeforeBody);

  // Protect and bound anonymous diagnostics before the general JSON parser can
  // consume a larger request. The listener router owns the final controller.
  app.post(
    '/api/listener/v1/telemetry',
    requireStrictSameOriginBrowserMutation,
    listenerTelemetryRateLimit,
    listenerTelemetryConcurrencyLimit,
    bodyParser.json({ limit: '16kb', strict: true })
  );

  // Parse JSON APIs and browser form submissions before their routers.
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));

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
      const { headerActions, heroActions } = renderLandingActions(auth);

      return res.status(200).send(
        template
          .replace('{{HEADER_ACTIONS}}', headerActions)
          .replace('{{HERO_ACTIONS}}', heroActions)
      );
    } catch (error) {
      return next(error);
    }
  });

  app.get('/health', getHealth);

  app.use((error: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(error);
    }

    const isFileTooLarge = error?.code === 'LIMIT_FILE_SIZE';
    const isTooManyFiles = error?.code === 'LIMIT_FILE_COUNT';
    const isMulterInputError = typeof error?.code === 'string' && error.code.startsWith('LIMIT_');
    const isInvalidJson = error?.type === 'entity.parse.failed';
    const status: number = isFileTooLarge || isTooManyFiles
      ? 413
      : isMulterInputError || isInvalidJson ? 400 : error.statusCode || 500;
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
          : isInvalidJson
            ? 'Invalid JSON request.'
            : error.message;
    const data: any = error.data;

    if (status >= 500) {
      const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
        .includes(req.method) ? req.method : 'OTHER';
      const requestArea = req.path === '/api/listener/v1/telemetry'
        ? 'listener_telemetry'
        : req.path.startsWith('/api/listener/v1')
          ? 'listener_api'
          : req.path === '/listen' || req.path.startsWith('/listen/')
            ? 'listener_page'
            : req.path.startsWith('/auth')
              ? 'auth'
              : req.path.startsWith('/content')
                ? 'content'
                : req.path.startsWith('/feed')
                  ? 'feed'
                  : req.path.startsWith('/video')
                    ? 'video'
                    : req.path.startsWith('/admin')
                      ? 'admin'
                      : req.path === '/'
                        ? 'root'
                        : 'other';
      console.error(JSON.stringify({
        category: 'server_error',
        requestArea,
        method,
        status: Number.isInteger(status) && status <= 599 ? status : 500,
        occurredAt: new Date().toISOString()
      }));
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
    .catch(() => {
      console.error(JSON.stringify({
        category: 'server_start_failed',
        occurredAt: new Date().toISOString()
      }));
      process.exitCode = 1;
    });
}
