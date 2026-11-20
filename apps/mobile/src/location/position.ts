import * as Location from "expo-location";

export interface Position {
  lat: number;
  lon: number;
}
export type Fix = { status: "ok"; position: Position } | { status: "denied" } | { status: "unavailable" };

/**
 * One position fix, for the moment it is needed. Asks only when `ask` is true (MR10); never when the
 * answer is already no. The position stays on the phone.
 */
export async function currentPosition(ask: boolean): Promise<Fix> {
  try {
    let perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted && ask && perm.canAskAgain) perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return { status: "denied" };
    const fix =
      (await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 })) ??
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    return fix
      ? { status: "ok", position: { lat: fix.coords.latitude, lon: fix.coords.longitude } }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Whether location is already allowed, without asking. */
export async function locationAllowed(): Promise<boolean> {
  try {
    return (await Location.getForegroundPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/** The country at a position, from the system's geocoder (needs a connection), or null. */
export async function countryAt(p: Position): Promise<string | null> {
  try {
    const [place] = await Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lon });
    return place?.country ?? null;
  } catch {
    return null;
  }
}
