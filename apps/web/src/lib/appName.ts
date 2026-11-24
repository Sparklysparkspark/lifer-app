import { SUGGESTED_APPS } from "./suggestedApps";

// An app has two names on purpose: a short label in the sidebar (for an app Lifer suggests, what it
// does for you) and its own name wherever the app itself is shown (toolbar, page title, Settings).
// Every surface asks here, so none invents a third.

interface AppLike {
  id: string;
  name?: string;
  page?: { label?: string };
}

/** The sidebar entry, its menu and its hide toast. */
export function appNavLabel(app: AppLike): string {
  return SUGGESTED_APPS.find((a) => a.id === app.id)?.label || app.page?.label || app.name || app.id;
}

/** The app's own name: the toolbar, the page heading, the offer page and Connected apps. */
export function appTitle(app: AppLike): string {
  return SUGGESTED_APPS.find((a) => a.id === app.id)?.name || app.name || app.page?.label || app.id;
}
