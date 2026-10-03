import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import LoginPage from "./pages/LoginPage";
import CollectionPage from "./pages/CollectionPage";
import MigrationStatusIndicator from "./components/MigrationStatusIndicator";
import StatusTray from "./components/StatusTray";
import LibraryFolderBanner from "./components/LibraryFolderBanner";
import TitleBarDragRegion from "./components/TitleBarDragRegion";
import AppNav from "./components/AppNav";
import { LoadingScreen } from "./components/LoadingScreen";
import { ToastProvider } from "./hooks/useToast";
import { ConfirmProvider } from "./hooks/useConfirm";
import { CommandPaletteProvider } from "./hooks/useCommandPalette";

// Every page but the collection (where the app opens) and login loads on first visit, so opening
// Lifer doesn't wait for the code of 20 pages you may never open this session.
const OnboardingPage = lazy(() => import("./pages/OnboardingPage"));
const SpeciesDetailPage = lazy(() => import("./pages/SpeciesDetailPage"));
const GalleryPage = lazy(() => import("./pages/GalleryPage"));
const StatsPage = lazy(() => import("./pages/StatsPage"));
const RegionPage = lazy(() => import("./pages/RegionPage"));
const BulkImportPage = lazy(() => import("./pages/BulkImportPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const OfflinePacksPage = lazy(() => import("./pages/OfflinePacksPage"));
const CollectionsPage = lazy(() => import("./pages/CollectionsPage"));
const TripDetailPage = lazy(() => import("./pages/TripDetailPage"));
const AlbumDetailPage = lazy(() => import("./pages/AlbumDetailPage"));
const SharePage = lazy(() => import("./pages/SharePage"));
const ApiKeysPage = lazy(() => import("./pages/ApiKeysPage"));
const InaturalistPage = lazy(() => import("./pages/InaturalistPage"));
const ArchivedSpeciesPage = lazy(() => import("./pages/ArchivedSpeciesPage"));
const HiddenSpeciesPage = lazy(() => import("./pages/HiddenSpeciesPage"));
const ManageTagsPage = lazy(() => import("./pages/ManageTagsPage"));
const TrashedPhotosPage = lazy(() => import("./pages/TrashedPhotosPage"));
const GuidePage = lazy(() => import("./pages/GuidePage"));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage"));

// Shown only if a page's code takes a moment to arrive, so fast loads don't flash a spinner.
function PageLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(t);
  }, []);
  return show ? <LoadingScreen /> : null;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Every signed-in page gets the top nav. Its own Suspense keeps the nav up while a page's code
// loads. Login, onboarding, password reset and share links are full-screen and skip it.
function AppLayout() {
  return (
    <RequireAuth>
      <CommandPaletteProvider>
        <div className="flex min-h-screen flex-col bg-canvas">
          <AppNav />
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </div>
      </CommandPaletteProvider>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <TitleBarDragRegion />
        <MigrationStatusIndicator />
        <StatusTray />
        <LibraryFolderBanner />
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
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/region/:id" element={<RegionPage />} />
              <Route path="/import" element={<BulkImportPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/:groupId" element={<SettingsPage />} />
              <Route path="/trash" element={<TrashedPhotosPage />} />
              <Route path="/offline-packs" element={<OfflinePacksPage />} />
              <Route path="/trips" element={<CollectionsPage />} />
              <Route path="/trips/:id" element={<TripDetailPage />} />
              <Route path="/albums" element={<CollectionsPage />} />
              <Route path="/albums/:id" element={<AlbumDetailPage />} />
              <Route path="/settings/api-keys" element={<ApiKeysPage />} />
              <Route path="/inaturalist" element={<InaturalistPage />} />
              <Route path="/archived" element={<ArchivedSpeciesPage />} />
              <Route path="/hidden-species" element={<HiddenSpeciesPage />} />
              <Route path="/tags" element={<ManageTagsPage />} />
              <Route path="/guide" element={<GuidePage />} />
            </Route>
          </Routes>
        </Suspense>
      </ConfirmProvider>
    </ToastProvider>
  );
}
