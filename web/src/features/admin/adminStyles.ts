import page from '../../styles/Pages.module.css';
import local from './Admin.module.css';
/** Administrator presentation reuses listener primitives with isolated compact overrides. */
const styles: Record<string, string> = {
  ...local,
  page: `${page.page} ${local.page}`, title: page.pageTitle,
  muted: page.lede, meta: page.identityMeta,
  nav: `${page.actions} ${local.nav}`, header: `${page.sectionHeader} ${local.header}`, sectionHeader: `${page.sectionHeader} ${local.header}`,
  actions: `${page.actions} ${local.actions}`, toolbar: `${page.actions} ${local.toolbar}`,
  filters: `${page.chipList} ${local.filters}`,
  button: `${page.button} ${page.buttonSecondary} ${local.button}`,
  link: `${page.secondaryLink} ${local.button}`, primary: local.primary,
  filter: `${page.button} ${local.filter}`, badge: local.badge,
  field: local.field, input: `${local.input}`,
  panel: `${page.formCard} ${local.panel}`, card: `${page.formCard} ${local.card}`,
  notice: `${page.compactState} ${local.notice}`, recovery: `${page.compactState} ${local.notice}`,
  target: `${page.compactState} ${local.target}`, error: page.error
};
export default styles;
