import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import LoginPage from "./pages/LoginPage";
import CollectionPage from "./pages/CollectionPage";
import SpeciesDetailPage from "./pages/SpeciesDetailPage";
import GalleryPage from "./pages/GalleryPage";
import RegionPage from "./pages/RegionPage";
import BulkImportPage from "./pages/BulkImportPage";
import SettingsPage from "./pages/SettingsPage";
import OfflinePacksPage from "./pages/OfflinePacksPage";
import TripsPage from "./pages/TripsPage";
import TripDetailPage from "./pages/TripDetailPage";
import ArchivedSpeciesPage from "./pages/ArchivedSpeciesPage";
import TrashedPhotosPage from "./pages/TrashedPhotosPage";
import GuidePage from "./pages/GuidePage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import MigrationStatusIndicator from "./components/MigrationStatusIndicator";
import UploadQueueBanner from "./components/UploadQueueBanner";
import UpdatesBanner from "./components/UpdatesBanner";
import TitleBarDragRegion from "./components/TitleBarDragRegion";
import { LoadingScreen } from "./components/LoadingScreen";

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
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
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
            <TripsPage />
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
        path="/archived"
        element={
          <RequireAuth>
            <ArchivedSpeciesPage />
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
    </>
  );
}
