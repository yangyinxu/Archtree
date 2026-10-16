import type { AuthContext } from '../../middleware/authMiddleware';
import {
    portfolioFocus,
    portfolioGitHubUrl,
    portfolioStack,
    type PortfolioPreview,
    type PortfolioProject
} from '../../portfolio/projectCatalog';
import { escapeHtml } from '../html';

type LandingViewer = Pick<AuthContext, 'userId' | 'email' | 'role'>;

export interface LandingActions {
    headerActions: string;
    /** Administrator shortcuts shown above the project grid; empty for everyone else. */
    adminTools: string;
}

/** Account actions for every visitor, plus management shortcuts only for administrators. */
export const renderLandingActions = (auth?: LandingViewer): LandingActions => {
    if (!auth) {
        return {
            headerActions: `<nav class="pf-header__actions" aria-label="Account">
      <a class="pf-button pf-button--ghost" href="/auth/login-web"><i class="ph ph-sign-in" aria-hidden="true"></i>Log in</a>
      <a class="pf-button pf-button--light" href="/account/register"><i class="ph ph-user-plus" aria-hidden="true"></i>Create account</a>
    </nav>`,
            adminTools: ''
        };
    }

    const adminTools = auth.role === 'admin'
        ? `<nav class="pf-admin" aria-label="Administrator tools">
      <span class="pf-admin__label"><i class="ph ph-lock-simple" aria-hidden="true"></i>Admin</span>
      <a class="pf-button pf-button--accent" href="/admin/projects"><i class="ph ph-squares-four" aria-hidden="true"></i>Manage projects</a>
      <a class="pf-button pf-button--ghost" href="/content/manage"><i class="ph ph-stack" aria-hidden="true"></i>Content Manager</a>
      <a class="pf-button pf-button--ghost" href="/content/manage/audio-tracks"><i class="ph ph-waveform" aria-hidden="true"></i>MediaTracks</a>
      <a class="pf-button pf-button--ghost" href="/engineering"><i class="ph ph-tree-structure" aria-hidden="true"></i>Engineering Guide</a>
    </nav>`
        : '';
    return {
        headerActions: `<nav class="pf-header__actions" aria-label="Account">
      <span class="pf-header__email">${escapeHtml(auth.email)}</span>
      <form method="POST" action="/auth/logout-web"><input type="hidden" name="viewerId" value="${escapeHtml(auth.userId)}" /><button class="pf-button pf-button--ghost" type="submit"><i class="ph ph-sign-out" aria-hidden="true"></i>Log out</button></form>
    </nav>`,
        adminTools
    };
};

/** Where a tile sits in the bento grid. */
export type PortfolioTileSlot = 'feature' | 'side' | 'side-tall' | 'half' | 'wide';

/**
 * Lays public projects into the bento grid: the first is featured, the next
 * one or two sit beside it, and the rest pair up, with an odd last tile
 * spanning the full width.
 */
export const portfolioTileSlots = (count: number): PortfolioTileSlot[] => {
    if (count <= 0) return [];
    if (count === 1) return ['wide'];
    const sideCount = Math.min(2, count - 1);
    const restCount = count - 1 - sideCount;
    const slots: PortfolioTileSlot[] = ['feature', ...Array<PortfolioTileSlot>(sideCount).fill(sideCount === 1 ? 'side-tall' : 'side')];
    for (let index = 0; index < restCount; index += 1) {
        slots.push(restCount % 2 === 1 && index === restCount - 1 ? 'wide' : 'half');
    }
    return slots;
};

const bars = (classes: string[]) => classes.map((modifier) => `<span class="art-bar ${modifier}"></span>`).join('');

const garmentPaths = [
    'M8 3 4 6l2 4 2-1v12h8V9l2 1 2-4-4-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3Z',
    'M7 3h10l1 18h-5l-1-10-1 10H6L7 3Z',
    'M3 15c3 0 5-2 6-5l3 1c0 2 1 3 3 3h4a2 2 0 0 1 2 2v2H3v-3Z'
];

/** Decorative, text-free illustrations; screen readers skip them. */
const renderPreview = (preview: PortfolioPreview) => {
    switch (preview) {
        case 'player':
            return `<div class="art art--player" aria-hidden="true">
            <div class="art-player__nav">${bars(['art-bar--ink art-bar--w70', 'art-bar--w60', 'art-bar--w80', 'art-bar--accent art-bar--w50', 'art-bar--w65'])}</div>
            <div class="art-player__main">
              <div class="art-player__covers">${[1, 2, 3, 4, 5, 6].map((tone) => `<span class="art-cover art-cover--${tone}"></span>`).join('')}</div>
              <div class="art-player__bar"><span class="art-player__play"></span><span class="art-player__meta">${bars(['art-bar--ink art-bar--w40'])}<span class="art-progress"><span></span></span></span></div>
            </div>
          </div>`;
        case 'iphone':
            return `<div class="art art--phone art--iphone" aria-hidden="true">${bars(['art-bar--ink art-bar--w50'])}<span class="art-cover art-cover--1"></span>${bars(['art-bar--w80', 'art-bar--w60'])}<span class="art-phone__dock"></span></div>`;
        case 'android':
            return `<div class="art art--phone art--android" aria-hidden="true">${bars(['art-bar--ink art-bar--w60'])}<span class="art-android__grid">${[6, 3, 5, 2].map((tone) => `<span class="art-cover art-cover--${tone}"></span>`).join('')}</span><span class="art-android__nav"><span></span><span></span><span></span></span></div>`;
        case 'comments':
            return `<div class="art art--comments" aria-hidden="true">${['triage', 'detail', 'uncertain'].map((label) => `<span class="art-comment art-comment--${label}"><span class="art-bar"></span><span class="art-chip">${label}</span></span>`).join('')}</div>`;
        case 'wardrobe':
            return `<div class="art art--wardrobe" aria-hidden="true">${garmentPaths.map((d) => `<span class="art-garment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="${d}"></path></svg></span>`).join('')}</div>`;
    }
};

/** One bento tile; all copy comes from the code catalog but is still escaped. */
const renderTile = (project: PortfolioProject, index: number, slot: PortfolioTileSlot) => {
    const action = project.link
        ? `<a class="pf-button ${slot === 'feature' ? 'pf-button--accent' : 'pf-button--ghost'} tile__link" href="${escapeHtml(project.link.href)}">${escapeHtml(project.link.label)}<i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>`
        : '<p class="tile__unlinked">No public link yet</p>';
    return `<li class="tile tile--${slot} tile--${project.accent}">
          <p class="tile__meta"><span>${String(index + 1).padStart(2, '0')}</span><span>${project.tags.map(escapeHtml).join(' · ')}</span></p>
          <div class="tile__text">
            <h3 class="tile__name">${escapeHtml(project.name)}</h3>
            <p class="tile__tagline">${escapeHtml(project.tagline)}</p>
            <p class="tile__description">${escapeHtml(project.description)}</p>
          </div>
          ${renderPreview(project.preview)}
          <div class="tile__action">${action}</div>
        </li>`;
};

export interface HomePageInput {
    auth?: LandingViewer;
    /** Public projects in display order. */
    projects: readonly PortfolioProject[];
    year?: number;
}

/** The kashewt.com homepage: a dark bento portfolio of public projects. */
export const renderHomePage = ({ auth, projects, year = new Date().getUTCFullYear() }: HomePageInput) => {
    const { headerActions, adminTools } = renderLandingActions(auth);
    const slots = portfolioTileSlots(projects.length);
    const grid = projects.length
        ? `<ol class="bento">${projects.map((project, index) => renderTile(project, index, slots[index])).join('')}</ol>`
        : '<p class="pf-empty">No projects are public right now.</p>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#0e0f12" />
    <title>Kashewt · Projects</title>
    <meta name="description" content="Kashewt projects: web, iOS, and Android apps and the services behind them." />
    <link rel="stylesheet" href="/assets/archtree.css" />
    <link rel="stylesheet" href="/assets/portfolio.css" />
</head>
<body class="portfolio-page">
    <main class="pf-shell">
        <header class="site-header pf-header">
            <a class="pf-brand" href="/">
                <span class="pf-brand__mark" aria-hidden="true">K</span>
                <span>Kashewt</span>
            </a>
            ${headerActions}
        </header>

        <section class="pf-hero" aria-labelledby="portfolio-title">
            <div class="pf-hero__copy">
                <p class="pf-kicker">Portfolio</p>
                <h1 id="portfolio-title">Web and mobile apps, and the services behind them.</h1>
                <p class="pf-hero__lede">Current projects across web, iOS, and Android, together with the backend services that support them.</p>
                <ul class="pf-stack" aria-label="Stack">${portfolioStack.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
            </div>
            <aside class="pf-focus" aria-label="In progress">
                <p class="pf-focus__label"><span class="pf-focus__dot" aria-hidden="true"></span>In progress</p>
                <p class="pf-focus__name">${escapeHtml(portfolioFocus.name)}</p>
                <p class="pf-focus__description">${escapeHtml(portfolioFocus.description)}</p>
            </aside>
        </section>

        ${adminTools}

        <section class="pf-work" aria-labelledby="projects-title">
            <div class="pf-work__heading">
                <h2 id="projects-title">Projects</h2>
                <p>${projects.length} ${projects.length === 1 ? 'project' : 'projects'}</p>
            </div>
            ${grid}
        </section>

        <footer class="pf-footer">
            <p class="pf-footer__wordmark" aria-hidden="true">Kashewt</p>
            <p class="pf-footer__links"><a href="${escapeHtml(portfolioGitHubUrl)}">GitHub</a><span>© ${year}</span></p>
        </footer>
    </main>
    <script src="/assets/browser-session-forms.js"></script>
</body>
</html>`;
};
