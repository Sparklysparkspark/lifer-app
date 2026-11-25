import { preloadablePage } from "../../lib/preloadablePage";

// Its own module, so Stats can load the page's code ahead without bundling the page itself.
export const ExplorerPage = preloadablePage(() => import("../TaxaExplorer"));
