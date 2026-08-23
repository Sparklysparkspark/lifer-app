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
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import MigrationStatusIndicator from "./components/MigrationStatusIndicator";
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
      <MigrationStatusIndicator />
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
        path="/offline-packs"
        element={
          <RequireAuth>
            <OfflinePacksPage />
          </RequireAuth>
        }
      />
      </Routes>
    </>
  );
}
