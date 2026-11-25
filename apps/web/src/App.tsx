import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { useTaskbarProgress } from "./hooks/useTaskbarProgress";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import { useLocaleSync } from "./hooks/useLocalePreference";
import LoginPage from "./pages/LoginPage";
import CollectionPage from "./pages/CollectionPage";
import StatusTray from "./components/StatusTray";
import LibraryFolderBanner from "./components/LibraryFolderBanner";
import LowSpaceBanner from "./components/LowSpaceBanner";
import LibraryLocationBanner from "./components/LibraryLocationBanner";
import OfflineBanner from "./components/OfflineBanner";
import TitleBarDragRegion from "./components/TitleBarDragRegion";
import AppNav from "./components/AppNav";
import { pluginIdFromPath, useDarkChrome } from "./lib/plugins";
import { useTheme } from "./hooks/useTheme";
import PluginFrames from "./components/PluginFrames";
import { AppSidebar, AppToolbar, useSidebarHidden, useSidebarLayout } from "./components/AppSidebar";
import PairingConsentModal from "./components/PairingConsentModal";
import HostOpenListener from "./components/HostOpenListener";
import UpdatesBanner from "./components/UpdatesBanner";
import { useCommandPalette } from "./hooks/useCommandPalette";
import { isTauri } from "./lib/tauri";
import { ignore } from "./lib/ignore";
import { countryBoundariesResource } from "./lib/countryBoundaries";
import SwipeBack from "./components/SwipeBack";
import { LoadingScreen } from "./components/LoadingScreen";
import { ToastProvider } from "./components/ToastProvider";
import { ConfirmProvider } from "./components/ConfirmProvider";
import { PlaceStepProvider } from "./components/PlaceStep";
import ShortcutSheet from "./components/ShortcutSheet";
import Tour from "./components/Tour";
import { PhotoVersionsHost } from "./components/PhotoVersions";
import { CommandPaletteProvider } from "./components/CommandPaletteProvider";
import CrashBoundary from "./components/CrashBoundary";
import { SPECIES_DOWNLOADS_PATH } from "./lib/speciesDownloads";
import { preloadablePage } from "./lib/preloadablePage";
import { ExplorerPage as TaxaExplorer } from "./pages/explorer/explorerPage";

// Every page but the collection (where the app opens) and login loads on first visit, so opening
// Lifer doesn't wait for the code of 20 pages you may never open this session.
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const SpeciesDetailPage = lazy(() => import("./pages/SpeciesDetailPage"));
const GalleryPage = preloadablePage(() => import("./pages/GalleryPage"));
const SimilarPhotosPage = lazy(() => import("./pages/SimilarPhotosPage"));
const StatsPage = preloadablePage(() => import("./pages/StatsPage"));
const RegionPage = lazy(() => import("./pages/RegionPage"));
const BulkImportPage = lazy(() => import("./pages/BulkImportPage"));
const LightroomImport = lazy(() => import("./pages/import/LightroomImport"));
const SettingsPage = preloadablePage(() => import("./pages/SettingsPage"));
const CollectionsPage = preloadablePage(() => import("./pages/CollectionsPage"));
const TripDetailPage = lazy(() => import("./pages/TripDetailPage"));
const AlbumDetailPage = preloadablePage(() => import("./pages/AlbumDetailPage"));
const SharePage = lazy(() => import("./pages/SharePage"));
const ApiKeysPage = lazy(() => import("./pages/ApiKeysPage"));
const InaturalistPage = preloadablePage(() => import("./pages/InaturalistPage"));
const ArchivedSpeciesPage = lazy(() => import("./pages/ArchivedSpeciesPage"));
const HiddenSpeciesPage = lazy(() => import("./pages/HiddenSpeciesPage"));
const ArchiveHealthPage = lazy(() => import("./pages/ArchiveHealthPage"));
const SensitiveSpeciesPage = lazy(() => import("./pages/SensitiveSpeciesPage"));
const ManageTagsPage = lazy(() => import("./pages/ManageTagsPage"));
const ManagePlacesPage = lazy(() => import("./pages/ManagePlacesPage"));
const PortfolioPage = lazy(() => import("./pages/PortfolioPage"));
const TrashedPhotosPage = lazy(() => import("./pages/TrashedPhotosPage"));
const PluginPage = lazy(() => import("./pages/PluginPage"));
const PluginOfferPage = preloadablePage(() => import("./pages/PluginOfferPage"));
const GuidePage = lazy(() => import("./pages/GuidePage"));
const ReviewPage = lazy(() => import("./pages/ReviewPage"));
const YearInReviewPage = lazy(() => import("./pages/YearInReviewPage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));

// A few seconds after opening, the sidebar pages' code (and in the desktop app, where it's a local
// read, the Regions map's country outlines) loads in the background, so no first visit waits on it.
const PRELOAD_DELAY_MS = 3000;
function usePreloadPages() {
  useEffect(() => {
    const timer = setTimeout(() => {
      const pages = [
        GalleryPage.preload,
        () => import("./components/PhotoMap"),
        CollectionsPage.preload,
        AlbumDetailPage.preload,
        StatsPage.preload,
        InaturalistPage.preload,
        SettingsPage.preload,
        () => import("./pages/OfflinePacksPage"),
        PluginOfferPage.preload,
        TaxaExplorer.preload,
      ];
      for (const load of pages) load().catch(ignore("Couldn't preload a page"));
      if (isTauri()) countryBoundariesResource.load().catch(ignore("Couldn't preload the country outlines"));
    }, PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}

// Shown only if a page's code takes a moment to arrive, so fast loads don't flash a spinner.
function PageLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(t);
  }, []);
  return show ? <LoadingScreen /> : null;
}

// The status pills shown on every page read signed-in API routes (settings, pack updates).
// Mounting them only once a session exists keeps the login,
// password reset and share pages from firing requests that can only 401.
function SignedInStatus() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <LocaleSync />
      <StatusTray />
    </>
  );
}

// Applies the account's interface language once settings load (see hooks/useLocalePreference.ts).
function LocaleSync() {
  useLocaleSync();
  return null;
}

// A page that moved: old links, bookmarks and history entries land on its new home, with their
// query (the packs page's ?missing=) and back-link state.
function MovedTo({ to }: { to: string }) {
  const location = useLocation();
  const [path, hash] = to.split("#");
  return <Navigate to={path + location.search + (hash ? `#${hash}` : location.hash)} state={location.state} replace />;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function TaskbarProgress() {
  useTaskbarProgress(true);
  return null;
}

// The desktop app's View and File menu items (menu.rs): go to a page, or open search.
function MenuCommands({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const navigate = useNavigate();
  const { open } = useCommandPalette();
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const fns = await Promise.all([
          listen<string>("menu:navigate", (e) => navigate(e.payload)),
          listen("menu:search", () => open()),
          listen("menu:toggle-sidebar", () => onToggleSidebar()),
        ]);
        if (cancelled) fns.forEach((fn) => fn());
        else unlisten.push(...fns);
      })
      .catch(ignore("Couldn't listen for menu commands"));
    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, [navigate, open, onToggleSidebar]);
  return null;
}

// Every signed-in page gets the app's navigation: a sidebar and toolbar in the desktop app, the
// top nav in a browser (or a narrow desktop window). Its own Suspense keeps the navigation up
// while a page's code loads. Login, onboarding, password reset and share links skip it.
function AppLayout() {
  const sidebar = useSidebarLayout();
  const { pathname } = useLocation();
  const [sidebarHidden, toggleSidebar] = useSidebarHidden();
  usePreloadPages();
  // Marks <html> for index.css and TitleBarDragRegion, only while this layout is on screen.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-sidebar-layout", sidebar);
    return () => document.documentElement.removeAttribute("data-sidebar-layout");
  }, [sidebar]);
  const darkChrome = useDarkChrome();
  const { theme } = useTheme();
  // Dark on <html> too, so portaled dialogs, menus and toasts follow; the saved theme is untouched.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-dark-chrome", darkChrome);
    root.classList.toggle("dark", darkChrome || theme === "dark");
    return () => {
      root.removeAttribute("data-dark-chrome");
      root.classList.toggle("dark", theme === "dark");
    };
  }, [darkChrome, theme]);
  const page = (
    <CrashBoundary resetKey={pathname}>
      <Suspense fallback={<PageLoading />}>
        <Outlet />
      </Suspense>
    </CrashBoundary>
  );
  return (
    <RequireAuth>
      <CommandPaletteProvider>
        <MenuCommands onToggleSidebar={toggleSidebar} />
        <ShortcutSheet />
        <Tour />
        <PhotoVersionsHost />
        {isTauri() && <PairingConsentModal />}
        {isTauri() && <HostOpenListener />}
        {isTauri() && <TaskbarProgress />}
        {/* Browsers have their own swipe back; apps use horizontal swipes themselves. */}
        {window.liferSetup && pluginIdFromPath(pathname) === null && <SwipeBack />}
        {/* One tree for both layouts, so resizing across the breakpoint keeps the page mounted. */}
        <div className={`app-shell flex min-h-screen bg-canvas text-ink ${sidebar ? "" : "flex-col"}`}>
          {sidebar && !sidebarHidden && <AppSidebar />}
          <div className={sidebar ? "flex min-w-0 flex-1 flex-col" : "contents"}>
            {sidebar ? (
              <>
                <AppToolbar sidebarHidden={sidebarHidden} onToggleSidebar={toggleSidebar} />
                <UpdatesBanner />
              </>
            ) : (
              <AppNav />
            )}
            {/* Docked in the layout, so it never covers page controls, onboarding or viewers. */}
            <OfflineBanner />
            <LibraryFolderBanner />
            <LowSpaceBanner />
            <LibraryLocationBanner />
            {page}
            {/* Started apps' frames live here, not in their page, so they survive navigation. */}
            <PluginFrames />
          </div>
        </div>
      </CommandPaletteProvider>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PlaceStepProvider>
          <TitleBarDragRegion />
          <SignedInStatus />
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/onboarding"
                element={
                  <RequireAuth>
                    <OnboardingPage />
                  </RequireAuth>
                }
              />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/share/:token" element={<SharePage />} />
              <Route element={<AppLayout />}>
                <Route path="/" element={<CollectionPage />} />
                <Route path="/species/:id" element={<SpeciesDetailPage />} />
                <Route path="/gallery" element={<GalleryPage />} />
                <Route path="/gallery/similar" element={<SimilarPhotosPage />} />
                <Route path="/stats" element={<StatsPage />} />
                <Route path="/region/:id" element={<RegionPage />} />
                <Route path="/import" element={<BulkImportPage />} />
                <Route path="/import/lightroom" element={<LightroomImport />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/:groupId" element={<SettingsPage />} />
                <Route path={SPECIES_DOWNLOADS_PATH} element={<SettingsPage subpage="downloads" />} />
                <Route path="/settings/regions" element={<MovedTo to={SPECIES_DOWNLOADS_PATH} />} />
                <Route path="/trash" element={<TrashedPhotosPage />} />
                <Route path="/offline-packs" element={<MovedTo to={SPECIES_DOWNLOADS_PATH} />} />
                <Route path="/trips" element={<MovedTo to="/albums?view=trips" />} />
                <Route path="/trips/:id" element={<TripDetailPage />} />
                <Route path="/albums" element={<CollectionsPage />} />
                <Route path="/albums/:id" element={<AlbumDetailPage />} />
                <Route path="/settings/api-keys" element={<ApiKeysPage />} />
                <Route path="/inaturalist" element={<InaturalistPage />} />
                <Route path="/archived" element={<ArchivedSpeciesPage />} />
                <Route path="/hidden-species" element={<HiddenSpeciesPage />} />
                <Route path="/archive-health" element={<ArchiveHealthPage />} />
                <Route path="/sensitive-species" element={<SensitiveSpeciesPage />} />
                <Route path="/tags" element={<ManageTagsPage />} />
                <Route path="/places" element={<ManagePlacesPage />} />
                <Route path="/portfolio" element={<PortfolioPage />} />
                <Route path="/apps/offer/:id" element={<PluginOfferPage />} />
                <Route path="/apps/:id" element={<PluginPage />} />
                <Route path="/guide" element={<GuidePage />} />
                <Route path="/review" element={<ReviewPage />} />
                <Route path="/year-in-review" element={<YearInReviewPage />} />
                <Route path="/explore" element={<TaxaExplorer />} />
              </Route>
            </Routes>
          </Suspense>
        </PlaceStepProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
