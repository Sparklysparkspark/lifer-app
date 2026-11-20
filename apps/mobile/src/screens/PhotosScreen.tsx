import { useEffect, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp } from "../app/AppContext";
import { useHeader } from "../navigation/useHeader";
import { useNav, type RootParams } from "../navigation/types";
import { PhotoGrid } from "../photos/PhotoGrid";
import { albumPhotos } from "../store/browse";
import { speciesPhotos, tripPhotos, type GridPhoto } from "../store/library";
import { useTheme } from "../theme/useTheme";
import { EmptyState, PageTitle } from "../ui";

/** The Gallery grid and viewer scoped to one album, one species or one trip. */
export function PhotosScreen({ route }: { route: { params: RootParams["Photos"] } }) {
  const { title, scope } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const app = useApp();
  const nav = useNav();
  const [photos, setPhotos] = useState<GridPhoto[] | null>(null);
  useHeader({ title, noAccount: true, options: { headerLargeTitleEnabled: false } });

  useEffect(() => {
    let alive = true;
    const load =
      scope.kind === "album"
        ? albumPhotos(app.db, scope.id)
        : scope.kind === "trip"
          ? tripPhotos(app.db, scope.id)
          : speciesPhotos(app.db, scope.name);
    void load.then((p) => alive && setPhotos(p));
    return () => {
      alive = false;
    };
  }, [app.db, app.version, scope]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <PhotoGrid
        photos={photos ?? []}
        byMonth={scope.kind !== "species"}
        header={<PageTitle text={title} />}
        onOpen={(index) => nav.navigate("Viewer", { ids: (photos ?? []).map((p) => p.photoId), index })}
        empty={
          photos ? (
            <EmptyState icon="gallery" title={t(scope.kind === "album" ? "albums.emptyAlbum" : "species.noPhotos")} />
          ) : undefined
        }
      />
    </View>
  );
}
