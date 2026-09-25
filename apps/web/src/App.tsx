import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import LoginPage from "./pages/LoginPage";
import CollectionPage from "./pages/CollectionPage";
import MigrationStatusIndicator from "./components/MigrationStatusIndicator";
import UploadQueueBanner from "./components/UploadQueueBanner";
import UpdatesBanner from "./components/UpdatesBanner";
import LibraryFolderBanner from "./components/LibraryFolderBanner";
import TitleBarDragRegion from "./components/TitleBarDragRegion";
import { LoadingScreen } from "./components/LoadingScreen";

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
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage"));

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

export default function App() {
  return (
    <>
      <TitleBarDragRegion />
      <MigrationStatusIndicator />
      <UploadQueueBanner />
      <UpdatesBanner />
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
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <CollectionPage />
          </RequireAuth>
        }
      />
      <Route
        path="/species/:id"
        element={
          <RequireAuth>
            <SpeciesDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/gallery"
        element={
          <RequireAuth>
            <GalleryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/stats"
        element={
          <RequireAuth>
            <StatsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/region/:id"
        element={
          <RequireAuth>
            <RegionPage />
          </RequireAuth>
        }
      />
      <Route
        path="/import"
        element={
          <RequireAuth>
            <BulkImportPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/:groupId"
        element={
          <RequireAuth>
            <SettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/trash"
        element={
          <RequireAuth>
            <TrashedPhotosPage />
          </RequireAuth>
        }
      />
      <Route
        path="/offline-packs"
        element={
          <RequireAuth>
            <OfflinePacksPage />
          </RequireAuth>
        }
      />
      <Route
        path="/trips"
        element={
          <RequireAuth>
            <CollectionsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/trips/:id"
        element={
          <RequireAuth>
            <TripDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/albums"
        element={
          <RequireAuth>
            <CollectionsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/albums/:id"
        element={
          <RequireAuth>
            <AlbumDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings/api-keys"
        element={
          <RequireAuth>
            <ApiKeysPage />
          </RequireAuth>
        }
      />
      <Route
        path="/inaturalist"
        element={
          <RequireAuth>
            <InaturalistPage />
          </RequireAuth>
        }
      />
      <Route
        path="/archived"
        element={
          <RequireAuth>
            <ArchivedSpeciesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/hidden-species"
        element={
          <RequireAuth>
            <HiddenSpeciesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/tags"
        element={
          <RequireAuth>
            <ManageTagsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/guide"
        element={
          <RequireAuth>
            <GuidePage />
          </RequireAuth>
        }
      />
      </Routes>
      </Suspense>
    </>
  );
}
