import englishUi from '../../engineering/locales/en-US.json' with { type: 'json' };
import { engineeringLocales, engineeringPagePath } from './engineering-localization.mjs';

/** Escapes all authored text; guide content never executes HTML or Markdown. */
const escape = (value) => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const arrow = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const mark = '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 27V6M16 17 7 8m9 15 9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="5" r="2.5" fill="currentColor"/><circle cx="6" cy="7" r="2.5" fill="currentColor"/><circle cx="26" cy="13" r="2.5" fill="currentColor"/></svg>';

/** Source URLs are resolved and validated against the checkout by the builder. */
const renderSources = (sources, metadata) => !sources?.length ? '' : `
  <div class="source-links"><span class="source-label">${escape(metadata.t('ui.source.caption'))}</span>${sources.map(source => {
    const url = metadata.sourceLinks[`${source.path}#${source.find || ''}`];
    if (!url) throw new Error(`Unresolved engineering source: ${source.path}`);
    return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.label)}${arrow}<span class="sr-only">${escape(metadata.t('ui.source.new_tab'))}</span></a>`;
  }).join('')}</div>`;

/** Keeps the same topic navigation on every directly addressable guide page. */
const renderNavigation = (page, guide, metadata) => {
  const top = ['', 'start', 'architecture', 'modules', 'flows', 'development'];
  const labels = Object.fromEntries(top.map(slug => [slug, metadata.t(`ui.nav.${slug || 'overview'}`)]));
  return `<nav aria-label="${escape(metadata.t('ui.nav.label'))}"><p class="nav-label">${escape(metadata.t('ui.nav.caption'))}</p><ol class="nav-list">${top.map((slug, index) => {
    const entry = guide.pages.find(candidate => candidate.slug === slug);
    if (!entry) return '';
    const selected = slug === page.slug;
    const childActive = slug && page.slug.startsWith(`${slug}/`);
    const children = guide.pages.filter(candidate => candidate.slug.startsWith(`${slug}/`) && slug);
    return `<li><a class="nav-link${selected || childActive ? ' nav-link--active' : ''}" href="${metadata.path(slug)}"${selected ? ' aria-current="page"' : ''}><span class="nav-number">${String(index + 1).padStart(2, '0')}</span>${escape(labels[slug])}</a>${children.length ? `<ul class="nav-children">${children.map(child => `<li><a href="${metadata.path(child.slug)}"${child.slug === page.slug ? ' aria-current="page"' : ''}>${escape(child.title)}</a></li>`).join('')}</ul>` : ''}</li>`;
  }).join('')}</ol></nav>`;
};

const renderSection = (section, metadata, index) => `<section class="guide-section${section.layout ? ` guide-section--${escape(section.layout)}` : ''}" id="${escape(section.id)}" aria-labelledby="heading-${escape(section.id)}">
  <div class="section-heading"><span class="section-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><h2 id="heading-${escape(section.id)}">${escape(section.title)}</h2><a class="heading-anchor" href="#${escape(section.id)}" aria-label="${escape(metadata.t('ui.section.link', { title: section.title }))}">#</a></div>
  ${section.body?.map(paragraph => `<p>${escape(paragraph)}</p>`).join('') || ''}
  ${section.items?.length ? `<div class="item-grid${section.layout === 'map' ? ' system-map' : ''}">${section.items.map((item, itemIndex) => {
    const body = `<span class="card-kicker">${escape(metadata.t(section.layout === 'map' ? 'ui.card.system' : 'ui.card.explore', { number: String(itemIndex + 1).padStart(2, '0') }))}</span><span class="card-title">${escape(item.title)}${item.href ? arrow : ''}</span><span class="card-text">${escape(item.text)}</span>`;
    return item.href ? `<a class="guide-card" href="${escape(item.href.replace(/^\/engineering(?=\/|#|$)/, metadata.path('')))}">${body}</a>` : `<div class="guide-card guide-card--static">${body}</div>`;
  }).join('')}</div>` : ''}
  ${section.steps?.length ? `<ol class="walkthrough">${section.steps.map((step, stepIndex) => `<li><span class="step-number" aria-hidden="true">${String(stepIndex + 1).padStart(2, '0')}</span><div><h3>${escape(step.title)}</h3><p>${escape(step.text)}</p>${renderSources(step.sources, metadata)}</div></li>`).join('')}</ol>` : ''}
  ${section.code ? `<div class="code-example"><div class="code-toolbar"><span>${escape(section.code.language)}</span><button type="button" class="copy-button" data-copy-code data-copy-label="${escape(metadata.t('ui.code.copy'))}" data-copied-label="${escape(metadata.t('ui.code.copied'))}" data-copy-success="${escape(metadata.t('ui.code.success'))}" data-copy-failure="${escape(metadata.t('ui.code.failure'))}" hidden>${escape(metadata.t('ui.code.copy'))}</button></div><pre tabindex="0" aria-label="${escape(metadata.t('ui.code.label', { title: section.title }))}"><code>${escape(section.code.text)}</code></pre></div>` : ''}
  ${section.callout ? `<aside class="guide-callout"><span class="callout-symbol" aria-hidden="true">i</span><div><h3>${escape(section.callout.title)}</h3><p>${escape(section.callout.text)}</p></div></aside>` : ''}
  ${renderSources(section.sources, metadata)}
</section>`;

/** Generates one accessible, independent document without listener application code. */
export const renderEngineeringPage = (page, guide, metadata) => {
  const locale = metadata.locale || 'en-US';
  if (locale !== 'en-US' && !metadata.ui) throw new Error('Localized engineering interface messages are required.');
  const messages = metadata.ui || englishUi;
  const t = (key, variables = {}) => {
    if (typeof messages[key] !== 'string') throw new Error(`Missing engineering interface message: ${key}`);
    return messages[key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name) => {
      if (!Object.hasOwn(variables, name)) throw new Error(`Missing engineering message variable: ${name}`);
      return String(variables[name]);
    });
  };
  metadata = { ...metadata, t, path: slug => engineeringPagePath(slug, locale) };
  const isHome = page.slug === '';
  const revision = metadata.revision.commit;
  const currentIndex = guide.pages.indexOf(page);
  const next = guide.pages[currentIndex + 1];
  const parentSlug = page.slug.includes('/') ? page.slug.split('/')[0] : '';
  const parent = guide.pages.find(candidate => candidate.slug === parentSlug);
  return `<!doctype html>
<html lang="${escape(locale)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escape(page.description)}" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escape(page.title)} · ${escape(t('ui.site.title'))}</title>
  <link rel="stylesheet" href="/engineering/guide.css" />
  <script src="/engineering/guide.js" defer></script>
</head>
<body${isHome ? ' class="overview-page"' : ''}>
  <a class="skip-link" href="#main-content">${escape(t('ui.skip'))}</a>
  <aside class="guide-sidebar">
    <a class="brand" href="${metadata.path('')}" aria-label="${escape(t('ui.brand.label'))}">${mark}<span>archtree<span class="brand-caption">${escape(t('ui.brand.caption'))}</span></span></a>
    <details class="sidebar-menu" open><summary>${escape(t('ui.mobile.browse'))}<span aria-hidden="true">＋</span></summary>${renderNavigation(page, guide, metadata)}</details>
    <div class="sidebar-footer"><span class="status-dot" aria-hidden="true"></span><span>${escape(t('ui.sidebar.tagline'))}<br /><span class="sidebar-muted">${escape(t('ui.sidebar.description'))}</span></span></div>
  </aside>
  <div class="guide-workspace">
    <header class="guide-topbar"><div class="breadcrumbs"><a href="${metadata.path('')}">${escape(t('ui.breadcrumb.root'))}</a><span aria-hidden="true">/</span>${!isHome ? `${parentSlug && parent ? `<a href="${metadata.path(parentSlug)}">${escape(parent.title)}</a><span aria-hidden="true">/</span>` : ''}<span>${escape(page.title)}</span>` : `<span>${escape(t('ui.nav.overview'))}</span>`}</div><div class="topbar-actions"><nav class="language-selector" aria-label="${escape(t('ui.language.label'))}">${engineeringLocales.map(option => `<a data-language-link href="${engineeringPagePath(page.slug, option.locale)}" lang="${option.locale}" hreflang="${option.locale}"${locale === option.locale ? ' aria-current="true"' : ''}>${option.name}</a>`).join('')}</nav><a class="back-link" href="/">${escape(t('ui.back'))} ${arrow}</a></div></header>
    <div class="reading-layout">
      <main id="main-content" tabindex="-1">
        <div class="page-intro"><div class="page-eyebrow"><span class="eyebrow-line" aria-hidden="true"></span>${escape(page.eyebrow)}<span class="reading-time">${escape(t('ui.reading_time', { minutes: page.readingMinutes }))}</span></div><h1>${escape(page.title)}</h1><p class="page-description">${escape(page.description)}</p>${isHome ? `<div class="hero-actions"><a class="primary-link" href="${metadata.path('start')}">${escape(t('ui.start_action'))} ${arrow}</a><a class="text-link" href="${metadata.path('architecture')}">${escape(t('ui.architecture_action'))} ${arrow}</a></div>` : ''}</div>
        ${page.sections.map((section, index) => renderSection(section, metadata, index)).join('')}
        ${next ? `<a class="next-page" href="${metadata.path(next.slug)}"><span><span class="next-caption">${escape(t('ui.next'))}</span><strong>${escape(next.title)}</strong></span>${arrow}</a>` : `<a class="next-page" href="${metadata.path('')}"><span><span class="next-caption">${escape(t('ui.next.back'))}</span><strong>${escape(t('ui.next.overview'))}</strong></span>${arrow}</a>`}
        <footer class="page-footer"><span>${escape(t('ui.site.name'))}</span><span>${escape(t(metadata.revision.dirty ? 'ui.footer.working' : 'ui.footer.revision'))} <a href="https://github.com/yangyinxu/Archtree/tree/${escape(revision)}" target="_blank" rel="noopener noreferrer">${escape(revision.slice(0, 8))}<span class="sr-only">${escape(metadata.t('ui.source.new_tab'))}</span></a></span>${metadata.revision.dirty ? `<p>${escape(t('ui.footer.note'))}</p>` : ''}</footer>
      </main>
      <aside class="page-outline" aria-label="${escape(t('ui.outline.label'))}"><p class="nav-label">${escape(t('ui.outline.title'))}</p><nav>${page.sections.map(section => `<a href="#${escape(section.id)}">${escape(section.title)}</a>`).join('')}</nav><div class="outline-note"><span class="outline-note-title">${escape(t('ui.outline.note_title'))}</span><p>${escape(t('ui.outline.note'))}</p></div></aside>
    </div>
  </div>
  <div class="sr-only" role="status" aria-live="polite" id="copy-status"></div>
</body>
</html>`;
};
