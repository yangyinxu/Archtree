import type { AuthContext } from '../../middleware/authMiddleware';
import type { PortfolioProject } from '../../portfolio/projectCatalog';
import { escapeHtml } from '../html';

type LandingViewer = Pick<AuthContext, 'userId' | 'email' | 'role'>;

export interface LandingActions {
    headerActions: string;
    /** Administrator shortcuts shown above the project list; empty for everyone else. */
    adminTools: string;
}

/** Account actions for every visitor, plus management shortcuts only for administrators. */
export const renderLandingActions = (auth?: LandingViewer): LandingActions => {
    if (!auth) {
        return {
            headerActions: `<div class="header-actions">
      <a class="button button--secondary" href="/auth/login-web"><i class="ph ph-sign-in" aria-hidden="true"></i>Log in</a>
      <a class="button" href="/finitude/register"><i class="ph ph-user-plus" aria-hidden="true"></i>Create account</a>
    </div>`,
            adminTools: ''
        };
    }

    const adminTools = auth.role === 'admin'
        ? `<nav class="admin-tools" aria-label="Administrator tools">
      <span class="admin-tools__label"><i class="ph ph-lock-simple" aria-hidden="true"></i>Admin</span>
      <a class="button" href="/admin/projects"><i class="ph ph-squares-four" aria-hidden="true"></i>Manage projects</a>
      <a class="button button--secondary" href="/content/manage"><i class="ph ph-stack" aria-hidden="true"></i>Content Manager</a>
      <a class="button button--secondary" href="/content/manage/audio-tracks"><i class="ph ph-waveform" aria-hidden="true"></i>MediaTracks</a>
      <a class="button button--secondary" href="/engineering"><i class="ph ph-tree-structure" aria-hidden="true"></i>Engineering Guide</a>
    </nav>`
        : '';
    return {
        headerActions: `<div class="header-actions">
      <span class="muted header-actions__email">${escapeHtml(auth.email)}</span>
      <form method="POST" action="/auth/logout-web"><input type="hidden" name="viewerId" value="${escapeHtml(auth.userId)}" /><button class="button--secondary" type="submit"><i class="ph ph-sign-out" aria-hidden="true"></i>Log out</button></form>
    </div>`,
        adminTools
    };
};

const projectNumber = (index: number) => String(index + 1).padStart(2, '0');

/** One project row; all copy comes from the code catalog but is still escaped. */
const renderProject = (project: PortfolioProject, index: number) => {
    const action = project.link
        ? `<a class="button project-row__link" href="${escapeHtml(project.link.href)}">${escapeHtml(project.link.label)}<i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>`
        : '<span class="project-row__unlinked">No public link yet</span>';
    return `<li class="project-row">
        <p class="project-row__index" aria-hidden="true">${projectNumber(index)}</p>
        <div class="project-row__body">
          <h2 class="project-row__name"><i class="ph ph-${escapeHtml(project.icon)}" aria-hidden="true"></i>${escapeHtml(project.name)}</h2>
          <p class="project-row__tagline">${escapeHtml(project.tagline)}</p>
          <p class="project-row__description">${escapeHtml(project.description)}</p>
          <ul class="tag-list" aria-label="Platforms and stack">${project.tags.map((tag) => `<li>${escapeHtml(tag)}</li>`).join('')}</ul>
        </div>
        <div class="project-row__action">${action}</div>
      </li>`;
};

export interface HomePageInput {
    auth?: LandingViewer;
    /** Public projects in display order. */
    projects: readonly PortfolioProject[];
    year?: number;
}

/** The kashewt.com homepage: a portfolio of public projects. */
export const renderHomePage = ({ auth, projects, year = new Date().getUTCFullYear() }: HomePageInput) => {
    const { headerActions, adminTools } = renderLandingActions(auth);
    const list = projects.length
        ? `<ol class="project-list">${projects.map(renderProject).join('')}</ol>`
        : '<p class="empty-state project-list__empty">No projects are public right now.</p>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>kashewt · Projects</title>
    <meta name="description" content="Apps and tools by kashewt, from the services to the native clients." />
    <link rel="stylesheet" href="/assets/archtree.css" />
    <link rel="stylesheet" href="/assets/portfolio.css" />
</head>
<body class="landing-page portfolio-page">
    <main class="page-shell">
        <header class="site-header landing-header">
            <a class="brand" href="/">
                <span class="brand-mark" aria-hidden="true">k</span>
                <span>kashewt</span>
            </a>
            ${headerActions}
        </header>

        <section class="portfolio-intro" aria-labelledby="portfolio-title">
            <p class="eyebrow">Portfolio</p>
            <h1 id="portfolio-title">Things I build and run.</h1>
            <p class="lede">Apps and tools made end to end: the services, the web apps, and the native clients that use them.</p>
        </section>

        ${adminTools}

        <section class="portfolio-projects" aria-labelledby="projects-title">
            <div class="portfolio-projects__heading">
                <h2 id="projects-title">Projects</h2>
                <p class="muted">${projects.length} ${projects.length === 1 ? 'project' : 'projects'}</p>
            </div>
            ${list}
        </section>

        <footer class="site-footer"><span>kashewt</span><span class="muted">© ${year}</span></footer>
    </main>
    <script src="/assets/browser-session-forms.js"></script>
</body>
</html>`;
};
