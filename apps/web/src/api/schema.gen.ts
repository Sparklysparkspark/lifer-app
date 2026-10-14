// Generated from the API's route schemas by `npm run gen:api-types`. Do not edit by hand:
// change the route's TypeBox schema in apps/api and regenerate. CI fails when this file is stale.

export interface paths {
  "/albums": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Albums */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              albums: ({
                /** Format: uuid */
                id: string;
                name: string;
                description: string | null;
                coverPhotoId: string | null;
                /** Format: date-time */
                createdAt: string;
                /** @enum {unknown} */
                coverLayout: "single" | "quad";
                coverCropX: number | null;
                coverCropY: number | null;
                coverCropSize: number | null;
                /** @description The 4 tiles of a quad cover, null where there's no photo */
                quadSlots: (
                  | ({
                      /** Format: uuid */
                      photoId: string;
                      cropX: number | null;
                      cropY: number | null;
                      cropSize: number | null;
                    } & {
                      [key: string]: unknown;
                    })
                  | null
                )[];
                captureCount: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    /** Create an album */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name?: string;
            description?: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              name: string;
              description: string | null;
              coverPhotoId: string | null;
              /** Format: date-time */
              createdAt: string;
              captureCount: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/albums/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Album details */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              name: string;
              description: string | null;
              coverPhotoId: string | null;
              /** Format: date-time */
              createdAt: string;
              /** @enum {unknown} */
              coverLayout: "single" | "quad";
              coverCropX: number | null;
              coverCropY: number | null;
              coverCropSize: number | null;
              /** @description The 4 tiles of a quad cover, null where there's no photo */
              quadSlots: (
                | ({
                    /** Format: uuid */
                    photoId: string;
                    cropX: number | null;
                    cropY: number | null;
                    cropSize: number | null;
                  } & {
                    [key: string]: unknown;
                  })
                | null
              )[];
              items: ({
                /** Format: uuid */
                photoId: string;
                width: number | null;
                height: number | null;
                /** Format: uuid */
                captureId: string;
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string;
                takenAt: string | null;
                cameraModel: string | null;
                lens: string | null;
                focalLengthMm: (number | string) | null;
                aperture: (number | string) | null;
                shutter: string | null;
                iso: number | null;
                qualityRating: number | null;
                lat: (number | string) | null;
                lon: (number | string) | null;
                regionId: string | null;
                regionName: string | null;
                /** @enum {unknown} */
                kind: "image" | "video";
                durationSeconds: (number | string) | null;
                tags: string[];
                cullVerdict: ("pick" | "reject") | null;
                cullLabel:
                  ("red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" | "black" | "white") | null;
                /** @description Imported hidden because a culling app rejected it */
                hidden: boolean;
                isFeatured: boolean | null;
                hasRawOriginal: boolean;
                originalRef: string | null;
                originalManaged: boolean | null;
                originalKind: string | null;
                rawRef: string | null;
                matchScore: number | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    /** Delete an album (photos are kept) */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    /** Update an album */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name?: string;
            description?: string | null;
            coverPhotoId?: string | null;
            /** @enum {unknown} */
            coverLayout?: "single" | "quad";
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              name: string;
              description: string | null;
              coverPhotoId: string | null;
              /** Format: date-time */
              createdAt: string;
              /** @enum {unknown} */
              coverLayout: "single" | "quad";
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/albums/{id}/captures": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Add photos to an album */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            captureIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/albums/{id}/captures/{captureId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Remove a photo from an album */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
          captureId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/albums/{id}/cover-crop": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Set the album cover crop */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            x?: number;
            y?: number;
            size?: number;
            reset?: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/albums/{id}/quad-slot": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Set a photo in a four-photo album cover */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            slot: number;
            photoId?: string | null;
            crop?: {
              x: number;
              y: number;
              size: number;
            } | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/albums/{id}/shares": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Share links for an album */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              shares: ({
                /** Format: uuid */
                id: string;
                hasPassword: boolean;
                allowDownload: boolean;
                showMetadata: boolean;
                expiresAt: string | null;
                /** Format: date-time */
                createdAt: string;
                token: string | null;
                revoked: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the share.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    /** Create a share link */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            password?: string;
            allowDownload?: boolean;
            showMetadata?: boolean;
            expiresAt?: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              hasPassword: boolean;
              allowDownload: boolean;
              showMetadata: boolean;
              expiresAt: string | null;
              /** Format: date-time */
              createdAt: string;
              /** @description The link's secret */
              token: string;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the share.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/albums/{id}/species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Species in an album */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                family: string | null;
                taxonOrder?: string | null;
                /** @enum {unknown} */
                state: "collected" | "seen" | "unseen";
                isTarget: boolean;
                tier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                localTier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                tierReason?: string | null;
                localTierReason?: string | null;
                tierOverridden?: boolean;
                nameChanged?: boolean;
                vagrant: boolean;
                /** @description 12 monthly values, on region checklist rows */
                seasonality: null | number[];
                capturedYears: number[] | null;
                endemic: boolean;
                isGhost: boolean;
                isLost: boolean;
                rediscoveredGhost: boolean;
                rediscoveredLost: boolean;
                coverPhotoUrl: string | null;
                coverPhotoCredit: string | null;
                cardCropX: number | null;
                cardCropY: number | null;
                cardCropSize: number | null;
                referenceFocalX: number | null;
                referenceFocalY: number | null;
                coverVolumeLabel: string | null;
                isOtherTaxa: boolean;
                inatIconicTaxon: string | null;
                userAddedRegion?:
                  | ({
                      /** Format: uuid */
                      id: string;
                      name: string;
                      /** @enum {unknown} */
                      kind: "region" | "seaZone";
                    } & {
                      [key: string]: unknown;
                    })
                  | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the album.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api-keys": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /api-keys */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              keys: ({
                /** Format: uuid */
                id: string;
                name: string;
                permissions: string[];
                /** Format: date-time */
                createdAt: string;
                lastUsedAt: string | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    /** POST /api-keys */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name: string;
            permissions: (
              | "gallery.read"
              | "species.read"
              | "stats.read"
              | "trips.read"
              | "album.read"
              | "album.write"
              | "share.read"
              | "share.write"
              | "photos.read"
              | "photos.write"
              | "collection.read"
              | "collection.write"
            )[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              name: string;
              permissions: string[];
              /** Format: date-time */
              createdAt: string;
              /** @description The key itself, shown only this once */
              token: string;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/api-keys/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /api-keys/{id} */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/archive": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /archive */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string;
                family: string | null;
                referencePhoto: string | null;
                referenceThumbUrl: string | null;
                /** Format: date-time */
                archivedAt: string;
              } & {
                [key: string]: unknown;
              })[];
              families: ({
                taxonClass: string;
                family: string;
                count: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/archive/bulk": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /archive/bulk */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            speciesIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              archived: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** DELETE /archive/bulk */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            speciesIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              unarchived: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/desktop-session": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /auth/desktop-session */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/email": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /auth/email */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            currentPassword: string;
            newEmail: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              email: string;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/login": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /auth/login */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            email: string;
            password: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              email: string;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/logout": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /auth/logout */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/me": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /auth/me */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              user:
                | ({
                    /** Format: uuid */
                    id: string;
                    email: string;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/password": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /auth/password */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            currentPassword: string;
            newPassword: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/register": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /auth/register */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            email: string;
            password: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              email: string;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /auth/settings */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              email: string;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/auth/setup-status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /auth/setup-status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              needsSetup: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Photo feed for syncing
     * @description Every photo in the library, ordered by last change. Page with `cursor` until `nextCursor` is null; store the last item's `updatedAt` and pass it as `since` next time to get only new and edited photos. Photos deleted permanently simply stop appearing, so run an occasional full sync if you mirror deletions.
     */
    get: {
      parameters: {
        query?: {
          /** @description Only photos changed after this time (an `updatedAt` from an earlier call) */
          since?: string;
          /** @description `nextCursor` from the previous page */
          cursor?: string;
          /** @description Page size, 1-500 (default 100) */
          limit?: number;
          /** @description Only photos showing this species (primary or additional) */
          speciesId?: string;
          /** @description 1 to include photos in the trash, with deletedAt set */
          includeDeleted?: "0" | "1";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: {
                /** Format: uuid */
                captureId: string;
                photoId: string | null;
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                additionalSpecies: {
                  /** Format: uuid */
                  speciesId: string;
                  scientificName: string;
                  commonName: string | null;
                }[];
                takenAt: string | null;
                /** @description ISO 8601 */
                createdAt: string;
                /** @description Full-precision time of the last change; pass it back as `since` */
                updatedAt: string;
                deletedAt: string | null;
                lat: number | null;
                lon: number | null;
                regionId: string | null;
                regionName: string | null;
                locationLabel: string | null;
                tripId: string | null;
                camera: {
                  model: string | null;
                  lens: string | null;
                  focalLengthMm: number | null;
                  aperture: number | null;
                  shutter: string | null;
                  iso: number | null;
                };
                rating: number | null;
                tags: string[];
                /** @enum {unknown} */
                kind: "image" | "video";
                width: number | null;
                height: number | null;
                originals: {
                  jpeg: {
                    fileName: string | null;
                    sizeBytes: number | null;
                    sha256: string | null;
                  } | null;
                  raw: {
                    fileName: string | null;
                    sizeBytes: number | null;
                    sha256: string | null;
                  } | null;
                  video: {
                    fileName: string | null;
                    sizeBytes: number | null;
                    sha256: string | null;
                  } | null;
                };
                images: {
                  thumb: string;
                  display: string;
                  original: string;
                } | null;
              }[];
              nextCursor: string | null;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /captures/{id} */
    delete: {
      parameters: {
        query?: {
          /** @description 1 to also delete the RAW file when the trash is purged */
          deleteRaw?: "1";
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/{id}/rating": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Set the star rating */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            rating: number | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/{id}/reassign": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Change a photo's species */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: uuid */
            speciesId: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/{id}/region": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /**
     * Set the region and/or location label
     * @description A field left out stays as it is.
     */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            regionId?: string | null;
            locationLabel?: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/{id}/species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** Add another species shown in the photo */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: uuid */
            speciesId: string;
          };
        };
      };
      responses: {
        /** @description OK */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/{id}/species/{speciesId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Remove an additional species */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/{id}/tags": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Replace the photo's tags */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            tags: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              tags: string[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/{id}/taken-at": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** Set the capture time */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            takenAt: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/batch-delete": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /captures/batch-delete */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            captureIds: string[];
            deleteRaw?: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              deleted: number;
              notFound: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/hidden-count": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /captures/hidden-count */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              count: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/suggest-species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /captures/suggest-species */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              suggestions: ({
                /** Format: uuid */
                id: string;
                scientific_name: string;
                common_name: string | null;
                score: number;
                /** @description your_photos, reference_photo or keyword_tag */
                source: string;
                confident?: boolean;
                matchPercent?: number;
              } & {
                [key: string]: unknown;
              })[];
              code?: string;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/suggest-species-from-video": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /captures/suggest-species-from-video */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              suggestions: ({
                /** Format: uuid */
                id: string;
                scientific_name: string;
                common_name: string | null;
                score: number;
                /** @description your_photos, reference_photo or keyword_tag */
                source: string;
                confident?: boolean;
                matchPercent?: number;
              } & {
                [key: string]: unknown;
              })[];
              /** @description Why there are no suggestions, when the video couldn't be read */
              error?: string;
              code?: string;
              stagedId?: string | null;
              uploadId?: string | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/tags": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /captures/tags */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              tags: string[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    /** DELETE /captures/tags */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            tag: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              updated?: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    /** PATCH /captures/tags */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            captureIds: string[];
            tags: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              updated?: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/tags/manage": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /captures/tags/manage */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              tags: {
                tag: string;
                count: number;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/captures/tags/rename": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** PATCH /captures/tags/rename */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            from: string;
            to: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              updated?: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/captures/unhide": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /captures/unhide */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            captureIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              unhidden: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/collection": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /collection */
    get: {
      parameters: {
        query?: {
          /** @description Comma-separated taxon classes, e.g. aves,mammalia */
          taxon?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                family: string | null;
                taxonOrder?: string | null;
                /** @enum {unknown} */
                state: "collected" | "seen" | "unseen";
                isTarget: boolean;
                tier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                localTier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                tierReason?: string | null;
                localTierReason?: string | null;
                tierOverridden?: boolean;
                nameChanged?: boolean;
                vagrant: boolean;
                /** @description 12 monthly values, on region checklist rows */
                seasonality: null | number[];
                capturedYears: number[] | null;
                endemic: boolean;
                isGhost: boolean;
                isLost: boolean;
                rediscoveredGhost: boolean;
                rediscoveredLost: boolean;
                coverPhotoUrl: string | null;
                coverPhotoCredit: string | null;
                cardCropX: number | null;
                cardCropY: number | null;
                cardCropSize: number | null;
                referenceFocalX: number | null;
                referenceFocalY: number | null;
                coverVolumeLabel: string | null;
                isOtherTaxa: boolean;
                inatIconicTaxon: string | null;
                userAddedRegion?:
                  | ({
                      /** Format: uuid */
                      id: string;
                      name: string;
                      /** @enum {unknown} */
                      kind: "region" | "seaZone";
                    } & {
                      [key: string]: unknown;
                    })
                  | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/collection/count": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /collection/count */
    get: {
      parameters: {
        query?: {
          /** @description Comma-separated taxon classes, e.g. aves,mammalia */
          taxon?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              total: number;
              collected: number;
              seen: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/collection/stats": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /collection/stats */
    get: {
      parameters: {
        query?: {
          /** @description Count local tiers here */
          regionId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              totalCollected: number;
              byTier: {
                [key: string]: number;
              };
              byFamily: ({
                family: string;
                count: number;
              } & {
                [key: string]: unknown;
              })[];
              byYear: ({
                year: number;
                count: number;
              } & {
                [key: string]: unknown;
              })[];
              tierRegions: ({
                id: string;
                name: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/gallery": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** All photos with filters. Unpaged unless limit is given; prefer GET /captures for syncing */
    get: {
      parameters: {
        query?: {
          /** @description Comma-separated taxon classes */
          taxa?: string;
          /** @description Region, or "uncategorized" for photos with no region */
          regionId?: string | "uncategorized";
          /** @description Taken on or after (YYYY-MM-DD) */
          dateFrom?: string;
          /** @description Taken on or before (YYYY-MM-DD) */
          dateTo?: string;
          /** @description Only photos with this tag */
          tag?: string;
          /** @description Only photos in this trip */
          tripId?: string;
          /** @description Only photos in this album */
          albumId?: string;
          /** @description 1 for photos with no capture date only */
          missingDate?: "0" | "1";
          /** @description Only species of this rarity tier */
          tier?: "legendary" | "rare" | "uncommon" | "occasional" | "common" | "unrated";
          /** @description With tier: the region whose local tier counts */
          tierRegionId?: string;
          /** @description Only this kind of shot, as Stats' Photography DNA counts them */
          shotKind?: "portrait" | "flight" | "behavior" | "environmental";
          /** @description 1 for 5-star photos only */
          onlyTopRated?: "0" | "1";
          /** @description 1 for species cover photos only */
          onlyFeatured?: "0" | "1";
          /** @description 1 for videos only */
          onlyVideo?: "0" | "1";
          /** @description 1 to leave videos out */
          excludeVideo?: "0" | "1";
          /** @description 1 for photos with a RAW original only (RAW-only photos included) */
          onlyHasRaw?: "0" | "1";
          /** @description 1 to leave out edited photos that have a RAW original (RAW-only photos stay) */
          excludeHasRaw?: "0" | "1";
          /** @description 0 to leave out photos whose only original is a RAW */
          includeRaw?: "0" | "1";
          /** @description 1 for only the photos whose only original is a RAW */
          onlyRaw?: "0" | "1";
          /** @description 1 for only the photos imported hidden because a culling app rejected them */
          hidden?: "0" | "1";
          /** @description newest (default), oldest, ratingHigh or ratingLow */
          sort?: string;
          /** @description Page size, 1 to 500 (larger is capped at 500). When given, the response adds nextCursor */
          limit?: number;
          /** @description nextCursor from the previous page, with the same sort and filters */
          cursor?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                photoId: string;
                width: number | null;
                height: number | null;
                /** Format: uuid */
                captureId: string;
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string;
                takenAt: string | null;
                cameraModel: string | null;
                lens: string | null;
                focalLengthMm: (number | string) | null;
                aperture: (number | string) | null;
                shutter: string | null;
                iso: number | null;
                qualityRating: number | null;
                lat: (number | string) | null;
                lon: (number | string) | null;
                regionId: string | null;
                regionName: string | null;
                /** @enum {unknown} */
                kind: "image" | "video";
                durationSeconds: (number | string) | null;
                tags: string[];
                cullVerdict: ("pick" | "reject") | null;
                cullLabel:
                  ("red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" | "black" | "white") | null;
                /** @description Imported hidden because a culling app rejected it */
                hidden: boolean;
                isFeatured: boolean | null;
                hasRawOriginal: boolean;
                originalRef: string | null;
                originalManaged: boolean | null;
                originalKind: string | null;
                rawRef: string | null;
                matchScore: number | null;
              } & {
                [key: string]: unknown;
              })[];
              /** @description Only when limit is given: pass as cursor for the next page; null on the last page */
              nextCursor?: string | null;
              /** @description Only on the first page (limit given, no cursor): how many photos match the filters in all */
              total?: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the gallery.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/gallery/has-video": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Whether the library has any videos */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              hasVideo: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the gallery.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/gallery/ids": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Every capture id matching the GET /gallery filters, with the video and RAW ones listed again */
    get: {
      parameters: {
        query?: {
          /** @description Comma-separated taxon classes */
          taxa?: string;
          /** @description Region, or "uncategorized" for photos with no region */
          regionId?: string | "uncategorized";
          /** @description Taken on or after (YYYY-MM-DD) */
          dateFrom?: string;
          /** @description Taken on or before (YYYY-MM-DD) */
          dateTo?: string;
          /** @description Only photos with this tag */
          tag?: string;
          /** @description Only photos in this trip */
          tripId?: string;
          /** @description Only photos in this album */
          albumId?: string;
          /** @description 1 for photos with no capture date only */
          missingDate?: "0" | "1";
          /** @description Only species of this rarity tier */
          tier?: "legendary" | "rare" | "uncommon" | "occasional" | "common" | "unrated";
          /** @description With tier: the region whose local tier counts */
          tierRegionId?: string;
          /** @description Only this kind of shot, as Stats' Photography DNA counts them */
          shotKind?: "portrait" | "flight" | "behavior" | "environmental";
          /** @description 1 for 5-star photos only */
          onlyTopRated?: "0" | "1";
          /** @description 1 for species cover photos only */
          onlyFeatured?: "0" | "1";
          /** @description 1 for videos only */
          onlyVideo?: "0" | "1";
          /** @description 1 to leave videos out */
          excludeVideo?: "0" | "1";
          /** @description 1 for photos with a RAW original only (RAW-only photos included) */
          onlyHasRaw?: "0" | "1";
          /** @description 1 to leave out edited photos that have a RAW original (RAW-only photos stay) */
          excludeHasRaw?: "0" | "1";
          /** @description 0 to leave out photos whose only original is a RAW */
          includeRaw?: "0" | "1";
          /** @description 1 for only the photos whose only original is a RAW */
          onlyRaw?: "0" | "1";
          /** @description 1 for only the photos imported hidden because a culling app rejected them */
          hidden?: "0" | "1";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              captureIds: string[];
              videoCaptureIds: string[];
              rawCaptureIds: string[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the gallery.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/gallery/regions-with-photos": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Regions that have photos */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              regionIds: string[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the gallery.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/gallery/search": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Search photos by content, species, place, date, trip or album name */
    get: {
      parameters: {
        query?: {
          /** @description Comma-separated taxon classes */
          taxa?: string;
          /** @description Region, or "uncategorized" for photos with no region */
          regionId?: string | "uncategorized";
          /** @description Taken on or after (YYYY-MM-DD) */
          dateFrom?: string;
          /** @description Taken on or before (YYYY-MM-DD) */
          dateTo?: string;
          /** @description Only photos with this tag */
          tag?: string;
          /** @description Only photos in this trip */
          tripId?: string;
          /** @description Only photos in this album */
          albumId?: string;
          /** @description 1 for photos with no capture date only */
          missingDate?: "0" | "1";
          /** @description Only species of this rarity tier */
          tier?: "legendary" | "rare" | "uncommon" | "occasional" | "common" | "unrated";
          /** @description With tier: the region whose local tier counts */
          tierRegionId?: string;
          /** @description Only this kind of shot, as Stats' Photography DNA counts them */
          shotKind?: "portrait" | "flight" | "behavior" | "environmental";
          /** @description 1 for 5-star photos only */
          onlyTopRated?: "0" | "1";
          /** @description 1 for species cover photos only */
          onlyFeatured?: "0" | "1";
          /** @description 1 for videos only */
          onlyVideo?: "0" | "1";
          /** @description 1 to leave videos out */
          excludeVideo?: "0" | "1";
          /** @description 1 for photos with a RAW original only (RAW-only photos included) */
          onlyHasRaw?: "0" | "1";
          /** @description 1 to leave out edited photos that have a RAW original (RAW-only photos stay) */
          excludeHasRaw?: "0" | "1";
          /** @description 0 to leave out photos whose only original is a RAW */
          includeRaw?: "0" | "1";
          /** @description 1 for only the photos whose only original is a RAW */
          onlyRaw?: "0" | "1";
          /** @description 1 for only the photos imported hidden because a culling app rejected them */
          hidden?: "0" | "1";
          /** @description What to look for, e.g. "bird in flight" or "costa rica trip" */
          q?: string;
          /** @description 1 to skip picture matching and answer at once */
          quick?: "0" | "1";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                photoId: string;
                width: number | null;
                height: number | null;
                /** Format: uuid */
                captureId: string;
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string;
                takenAt: string | null;
                cameraModel: string | null;
                lens: string | null;
                focalLengthMm: (number | string) | null;
                aperture: (number | string) | null;
                shutter: string | null;
                iso: number | null;
                qualityRating: number | null;
                lat: (number | string) | null;
                lon: (number | string) | null;
                regionId: string | null;
                regionName: string | null;
                /** @enum {unknown} */
                kind: "image" | "video";
                durationSeconds: (number | string) | null;
                tags: string[];
                cullVerdict: ("pick" | "reject") | null;
                cullLabel:
                  ("red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" | "black" | "white") | null;
                /** @description Imported hidden because a culling app rejected it */
                hidden: boolean;
                isFeatured: boolean | null;
                hasRawOriginal: boolean;
                originalRef: string | null;
                originalManaged: boolean | null;
                originalKind: string | null;
                rawRef: string | null;
                matchScore: number | null;
              } & {
                [key: string]: unknown;
              })[];
              interpretation?: {
                species: string[];
                groups: string[];
                scenes: string[];
                places: string[];
                dates: string[];
                description: string | null;
              } & {
                [key: string]: unknown;
              };
              pending?: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the gallery.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/gallery/taxa": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Taxon classes that have photos */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              taxa: (string | null)[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the gallery.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/imports/ebird-csv": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /imports/ebird-csv */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              totalRows: number;
              uniqueSpecies: number;
              matched: number;
              alreadySeenOrCollected: number;
              unmatched: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/callback": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /inaturalist/callback */
    get: {
      parameters: {
        query?: {
          code?: string;
          state?: string;
          error?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/completed": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /inaturalist/completed */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              observations: ({
                observationId: string;
                scientificName: string;
                commonName: string | null;
                currentPhotoId: string | null;
                /** Format: date-time */
                createdAt: string;
                confirmedAt: string | null;
                url: string;
                editUrl: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/connect": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /inaturalist/connect */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/disconnect": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /inaturalist/disconnect */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/import": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /inaturalist/import */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/observations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /inaturalist/observations */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            captureIds: string[];
            /** Format: uuid */
            regionId?: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              observationId: string;
              editUrl: string;
              /** @description No GPS was sent: place it on iNaturalist */
              needsLocation: boolean;
              needsDate: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/observations/{observationId}/confirm": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /inaturalist/observations/{observationId}/confirm */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          observationId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/pending": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /inaturalist/pending */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              observations: ({
                observationId: string;
                scientificName: string;
                commonName: string | null;
                currentPhotoId: string | null;
                /** Format: date-time */
                createdAt: string;
                confirmedAt: string | null;
                url: string;
                editUrl: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/server-config": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /inaturalist/server-config */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** PUT /inaturalist/server-config */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            clientId?: string | null;
            clearClientId?: boolean;
            redirectUri?: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/inaturalist/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /inaturalist/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              available: boolean;
              connected: boolean;
              username: string | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/folder-status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /library/folder-status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/ignore": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /library/ignore */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            contentHash: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/reimport": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /library/reimport */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** Format: uuid */
            volumeId?: string;
            path?: string;
            organize?: boolean;
            /**
             * @description Photos a culling app rejected: hide (the default) recovers them hidden, skip leaves them out, ignore recovers them as usual
             * @enum {unknown}
             */
            cullMarks?: "skip" | "hide" | "ignore";
          };
        };
      };
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/reimport/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /library/reimport/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/reimport/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /library/reimport/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/reimport/unmatched-preview-by-hash/{hash}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /library/reimport/unmatched-preview-by-hash/{hash} */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          hash: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/library/reimport/unmatched-preview/{index}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /library/reimport/unmatched-preview/{index} */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          index: number;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/life-list": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Life list
     * @description One row per species you've photographed, oldest first. `include=seen` adds species marked seen without a photo.
     */
    get: {
      parameters: {
        query?: {
          /** @description Comma-separated taxon classes, e.g. aves,mammalia */
          taxonClass?: string;
          /** @description `seen` to include seen-only species */
          include?: "seen";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              species: {
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                family: string | null;
                /** @enum {unknown} */
                status: "photographed" | "seen";
                firstCollected: string | null;
                lastPhotographed: string | null;
                photoCount: number;
                bestRating: number | null;
                coverPhotoId: string | null;
                coverImage: string | null;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/life-list/summary": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Life list counts
     * @description Small and cheap to poll: totals, per-group counts, the latest lifer, and optionally progress on one region's checklist. An unknown or malformed `regionId` answers 404.
     */
    get: {
      parameters: {
        query?: {
          /** @description Also report progress on this region's checklist */
          regionId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              photographedSpecies: number;
              seenOnlySpecies: number;
              photos: number;
              newThisYear: number;
              byTaxonClass: {
                [key: string]: number;
              };
              latestLifer: {
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                firstCollected: string | null;
                coverImage: string | null;
              } | null;
              region: {
                /** Format: uuid */
                regionId: string;
                name: string;
                photographed: number;
                checklistSize: number;
              } | null;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/{packId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /offline-packs/{packId} */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          packId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              deletedSpeciesFiles: number;
              keptSpeciesCount: number;
              regions: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/{packId}/delete-preview": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /offline-packs/{packId}/delete-preview */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          packId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              checklistRegionsAffectedCount: number;
              speciesToRemoveCount: number;
              speciesKeptCount: number;
              bytesToFree: number;
              isEstimate: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/{packId}/provinces": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /offline-packs/{packId}/provinces */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          packId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              provinces: ({
                id: string;
                name: string;
                applied: boolean;
              } & {
                [key: string]: unknown;
              })[];
              /** @description What the country calls them, like "States" */
              subdivisionLabel: string;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/{packId}/provinces/offload": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/{packId}/provinces/offload */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          packId: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            regionIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              remainingApplied: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/download": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/download */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            packIds: string[];
            /** @description Download again even when up to date */
            force?: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/download-batch": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/download-batch */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            regionNames: string[];
            taxa?: string[] | "all";
            /** @enum {unknown} */
            variant?: "full" | "small";
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
              packIds: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/download/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/download/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/download/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /offline-packs/download/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/index": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /offline-packs/index */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              generatedAt: string;
              /** @description Photo sizes aren't in sizeBytes yet: ask again shortly for them */
              sizesPending?: boolean;
              packs: ({
                id: string;
                type: "region" | "seaZone";
                region?: string;
                seaZone?: string;
                taxon?: string | null;
                variant?: "full" | "small";
                sizeBytes: number;
                speciesCount: number;
                contentVersion: string;
                url: string;
                range?: [number, number];
                sha256?: string;
                seaZoneDependencies?: string[];
                downloaded: boolean;
                updateAvailable: boolean;
                /** @description When the index lists it */
                photoBytes?: number;
                /** @description When the index lists it */
                checklistBytes?: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/offload-batch": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/offload-batch */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            packIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              deletedSpeciesFiles: number;
              keptSpeciesCount: number;
              regions: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/offload-preview": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/offload-preview */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            packIds: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              checklistRegionsAffectedCount: number;
              speciesToRemoveCount: number;
              speciesKeptCount: number;
              bytesToFree: number;
              isEstimate: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/recommend": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /offline-packs/recommend */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            scientificNames: string[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              recommended: ({
                id: string;
                region?: string;
                seaZone?: string;
                taxon: string | null;
                sizeBytes: number;
                /** @description How many of the requested species it adds */
                covers: number;
              } & {
                [key: string]: unknown;
              })[];
              uncovered: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/offline-packs/updates-summary": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /offline-packs/updates-summary */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              updateCount: number;
              totalBytes: number;
              packIds: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/openapi.json": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /openapi.json */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/originals/{id}/download": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /originals/{id}/download */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/originals/reveal": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /originals/reveal */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            path: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/photos/{id}/display": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Display-size image (WebP) */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/photos/{id}/medium": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Grid-size image, 1,024px (WebP) */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/photos/{id}/original": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Original file
     * @description The full original photo file, as imported. `download=1` adds a download filename. 409 when it lives on a drive that isn't connected.
     */
    get: {
      parameters: {
        query?: {
          /** @description 1 to set Content-Disposition: attachment */
          download?: "0" | "1";
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/octet-stream": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/photos/{id}/original-raw": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Original RAW file, when the photo has one */
    get: {
      parameters: {
        query?: {
          /** @description 1 to set Content-Disposition: attachment */
          download?: "0" | "1";
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/octet-stream": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/photos/{id}/thumb": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Thumbnail (WebP) */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/photos/{id}/video": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Video file (supports Range requests) */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "video/*": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              regions: ({
                /** Format: uuid */
                id: string;
                name: string;
                parentId: string | null;
                ebirdRegionCode: string | null;
                boundaryGeoJson: unknown | null;
                /** @description Provinces have been added under it */
                hasChildren: boolean;
                /** @description False for World and the continents */
                hasScopedChecklist: boolean;
                sovereigntyGroup: string | null;
                isSovereignDependency: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/aggregate-species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{id}/aggregate-species */
    get: {
      parameters: {
        query?: {
          taxon?: string;
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                family: string | null;
                taxonOrder?: string | null;
                /** @enum {unknown} */
                state: "collected" | "seen" | "unseen";
                isTarget: boolean;
                tier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                localTier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                tierReason?: string | null;
                localTierReason?: string | null;
                tierOverridden?: boolean;
                nameChanged?: boolean;
                vagrant: boolean;
                /** @description 12 monthly values, on region checklist rows */
                seasonality: null | number[];
                capturedYears: number[] | null;
                endemic: boolean;
                isGhost: boolean;
                isLost: boolean;
                rediscoveredGhost: boolean;
                rediscoveredLost: boolean;
                coverPhotoUrl: string | null;
                coverPhotoCredit: string | null;
                cardCropX: number | null;
                cardCropY: number | null;
                cardCropSize: number | null;
                referenceFocalX: number | null;
                referenceFocalY: number | null;
                coverVolumeLabel: string | null;
                isOtherTaxa: boolean;
                inatIconicTaxon: string | null;
                userAddedRegion?:
                  | ({
                      /** Format: uuid */
                      id: string;
                      name: string;
                      /** @enum {unknown} */
                      kind: "region" | "seaZone";
                    } & {
                      [key: string]: unknown;
                    })
                  | null;
              } & {
                [key: string]: unknown;
              })[];
              downloadedCountryNames: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/checklist-additions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Species you added to a region's checklist
     * @description Only additions made to this region itself, not to provinces inside it. Species you imported by hand from iNaturalist are included. 404 for an unknown region.
     */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: {
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                /** Format: date-time */
                addedAt: string;
                alreadyOnChecklist: boolean;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/drill-down": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /regions/{id}/drill-down */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              created: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/hidden-species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{id}/hidden-species */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                /** Format: date-time */
                hiddenAt: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/photographed-taxa": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{id}/photographed-taxa */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              taxa: string[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/sea-zones": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{id}/sea-zones */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              zones: ({
                /** Format: uuid */
                id: string;
                name: string;
                addedByYou: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{id}/species */
    get: {
      parameters: {
        query?: {
          sort?: "taxonomic" | "rarity" | "name";
          filter?: "all" | "missing" | "collected" | "seen";
          taxon?: string;
          seaZoneIds?: string;
          includeLand?: "0" | "1";
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** @description The region's pack isn't downloaded yet */
              needsPack?: boolean;
              region: {
                /** Format: uuid */
                id: string;
                name: string;
                ebirdRegionCode: string | null;
                boundaryGeoJson: unknown | null;
                hasChildren: boolean;
                canDrillDown: boolean;
              } & {
                [key: string]: unknown;
              };
              stats: {
                total: number;
                collected: number;
                seen: number;
              } & {
                [key: string]: unknown;
              };
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                family: string | null;
                taxonOrder?: string | null;
                /** @enum {unknown} */
                state: "collected" | "seen" | "unseen";
                isTarget: boolean;
                tier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                localTier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                tierReason?: string | null;
                localTierReason?: string | null;
                tierOverridden?: boolean;
                nameChanged?: boolean;
                vagrant: boolean;
                /** @description 12 monthly values, on region checklist rows */
                seasonality: null | number[];
                capturedYears: number[] | null;
                endemic: boolean;
                isGhost: boolean;
                isLost: boolean;
                rediscoveredGhost: boolean;
                rediscoveredLost: boolean;
                coverPhotoUrl: string | null;
                coverPhotoCredit: string | null;
                cardCropX: number | null;
                cardCropY: number | null;
                cardCropSize: number | null;
                referenceFocalX: number | null;
                referenceFocalY: number | null;
                coverVolumeLabel: string | null;
                isOtherTaxa: boolean;
                inatIconicTaxon: string | null;
                userAddedRegion?:
                  | ({
                      /** Format: uuid */
                      id: string;
                      name: string;
                      /** @enum {unknown} */
                      kind: "region" | "seaZone";
                    } & {
                      [key: string]: unknown;
                    })
                  | null;
              } & {
                [key: string]: unknown;
              })[];
              taxonPackMissing?: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{id}/species/count": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{id}/species/count */
    get: {
      parameters: {
        query?: {
          taxon?: string;
          seaZoneIds?: string;
          includeLand?: "0" | "1";
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              total: number;
              collected: number;
              seen: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{regionId}/checklist-additions/{speciesId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /**
     * Add a species to a region's checklist
     * @description Puts any species on a country's or province's checklist for you, like a hand-imported species you also found in another province. Safe to repeat: adding it again answers 200 with `added: false`. `alreadyOnChecklist` is true when the catalog already lists it there. It undoes a hide of the species in that region. Your additions are kept apart from the catalog, so catalog updates and offline packs never remove them. 400 with code `no_checklist` for World or a continent, which have no checklist of their own; 404 for an unknown region or species.
     */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          /** @description The region whose checklist to change */
          regionId: string;
          /** @description The species to add or remove */
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              /** @description False when you had already added it (nothing changed) */
              added: boolean;
              /** @description The catalog already lists this species there, so it showed there before */
              alreadyOnChecklist: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    /**
     * Remove a species you added to a region's checklist
     * @description Removes only your addition: if the catalog lists the species there too, it stays on the checklist. 404 with code `not_added` when you hadn't added it there.
     */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          /** @description The region whose checklist to change */
          regionId: string;
          /** @description The species to add or remove */
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{regionId}/species/{speciesId}/hidden-children": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/{regionId}/species/{speciesId}/hidden-children */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          regionId: string;
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              children: ({
                /** Format: uuid */
                regionId: string;
                regionName: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/{regionId}/species/{speciesId}/hide": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /regions/{regionId}/species/{speciesId}/hide */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          regionId: string;
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** DELETE /regions/{regionId}/species/{speciesId}/hide */
    delete: {
      parameters: {
        query?: {
          cascadeRegionIds?: string;
        };
        header?: never;
        path: {
          regionId: string;
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/boundaries": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/boundaries */
    get: {
      parameters: {
        query?: {
          level?: "country";
        };
        header?: {
          "if-none-match"?: string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/hidden-species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/hidden-species */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                referencePhoto: string | null;
                referenceThumbUrl: string | null;
                /** Format: date-time */
                hiddenAt: string;
                /** Format: uuid */
                regionId: string;
                regionName: string;
                countryId: string | null;
                countryName: string | null;
                isCountry: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/regions/taxon-presence": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /regions/taxon-presence */
    get: {
      parameters: {
        query: {
          regionIds: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/sea-zones": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Sea zones
     * @description Every sea zone (IHO sea areas, and a country's own waters within the larger ones), by name, for adding a species to one's checklist.
     */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              zones: {
                /** Format: uuid */
                id: string;
                name: string;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/sea-zones/{id}/checklist-additions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Species you added to a sea zone's checklist
     * @description 404 for an unknown sea zone.
     */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: {
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                /** Format: date-time */
                addedAt: string;
                alreadyOnChecklist: boolean;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/sea-zones/{seaZoneId}/checklist-additions/{speciesId}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /**
     * Add a species to a sea zone's checklist
     * @description Puts any species on a sea zone's checklist for you, like a sea turtle or a seabird its fish and marine mammal list doesn't have. It shows on a region's checklist when that zone is ticked as nearby water. Safe to repeat: adding it again answers 200 with `added: false`. `alreadyOnChecklist` is true when the catalog already lists it there. 404 for an unknown sea zone or species.
     */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          /** @description The sea zone whose checklist to change */
          seaZoneId: string;
          /** @description The species to add or remove */
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              /** @description False when you had already added it (nothing changed) */
              added: boolean;
              /** @description The catalog already lists this species there, so it showed there before */
              alreadyOnChecklist: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    /**
     * Remove a species you added to a sea zone's checklist
     * @description Removes only your addition, never the catalog's own entry. 404 with code `not_added` when you hadn't added it there.
     */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          /** @description The sea zone whose checklist to change */
          seaZoneId: string;
          /** @description The species to add or remove */
          speciesId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              organizeOriginalsByYear: boolean;
              organizeOriginalsByLocation: boolean;
              hideObscureSpecies: boolean;
              speciesSuggestEnabled: boolean;
              anyTaxaSearchEnabled: boolean;
              /** @description Per install, shared by every account on it */
              fetchWithheldPhotos: boolean;
              technicalDiving: boolean;
              speciesNamingStyles: string[];
              locale: string | null;
              abaCodesAvailable: boolean;
              /** @description The photo library folder */
              dataDir: string;
              /** @enum {unknown} */
              deploymentMode: "desktop" | "server";
              catalogLoading: ("running" | "failed") | null;
              /** @description Admin-declared extra library folders; always empty on desktop */
              libraryRoots: ({
                label: string;
                path: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/any-taxa-search": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/any-taxa-search */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              anyTaxaSearchEnabled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/browse-directory": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/browse-directory */
    get: {
      parameters: {
        query?: {
          path?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/catalog-update": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/catalog-update */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/catalog-update/apply": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/catalog-update/apply */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/catalog-update/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/catalog-update/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/catalog-update/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/catalog-update/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result: unknown | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/delete-local-library": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/delete-local-library */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /** @constant */
            confirm: true;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/embedding-model": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /settings/embedding-model */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/embedding-model/download": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/embedding-model/download */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/embedding-model/download/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/embedding-model/download/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/embedding-model/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/embedding-model/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result: unknown | null;
              activeModel: ("identification" | "general") | null;
              downloaded: boolean;
              idModelDownloaded: boolean;
              sceneModelDownloaded: boolean;
              usable: boolean;
              sizeBytes: number | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/fetch-withheld-photos": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/fetch-withheld-photos */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              fetchWithheldPhotos: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/hide-obscure-species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/hide-obscure-species */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              hideObscureSpecies: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/locale": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/locale */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            locale: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              locale: string | null;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/map": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /settings/map */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/map/download": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/map/download */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/map/download/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/map/download/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/map/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/map/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result: unknown | null;
              available: boolean;
              downloaded: boolean;
              sizeBytes: number | null;
              downloading: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/migrate-to-server": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/migrate-to-server */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            serverUrl: string;
            email: string;
            password: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/migrate-to-server/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/migrate-to-server/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/migrate-to-server/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/migrate-to-server/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result: unknown | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/organize-originals": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/organize-originals */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              organizeOriginalsByYear: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/organize-originals-by-location": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/organize-originals-by-location */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              organizeOriginalsByLocation: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/reorganize-originals": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/reorganize-originals */
    post: {
      parameters: {
        query?: {
          /** @description 1 to start the job and return at once, for polling */
          background?: "1";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started?: boolean;
              moved?: number;
              skipped?: number;
              failed?: number;
              total?: number;
              lastError?: string | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/reorganize-originals/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /settings/reorganize-originals/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/reorganize-originals/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/reorganize-originals/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result: unknown | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/species-naming-style": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/species-naming-style */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            styles: ("common" | "latin" | "aba_code" | "ebird_code" | "tree")[];
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              speciesNamingStyles: ("common" | "latin" | "aba_code" | "ebird_code" | "tree")[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/species-suggest": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/species-suggest */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              speciesSuggestEnabled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/storage": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/storage */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              dataDir: string;
              changeable: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** PUT /settings/storage */
    put: {
      parameters: {
        query?: {
          /** @description 1 to start the move and return at once, for polling */
          background?: "1";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            dataDir: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started?: boolean;
              dataDir?: string;
              previousDataDir?: string;
              filesMoved?: boolean;
              restartRequired?: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/storage/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /settings/storage/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result: unknown | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/settings/technical-diving": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /settings/technical-diving */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            enabled: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              technicalDiving: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/share/{token}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /share/{token} */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          token: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/share/{token}/photos/{photoId}/display": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /share/{token}/photos/{photoId}/display */
    get: {
      parameters: {
        query?: {
          download?: string;
        };
        header?: never;
        path: {
          token: string;
          photoId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/share/{token}/photos/{photoId}/thumb": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /share/{token}/photos/{photoId}/thumb */
    get: {
      parameters: {
        query?: {
          download?: string;
        };
        header?: never;
        path: {
          token: string;
          photoId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/share/{token}/unlock": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /share/{token}/unlock */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          token: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            password?: string;
          };
        };
      };
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/shares/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Revoke a share link */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the share.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Search species by name, alias, old scientific name, code, genus or family (accents ignored) */
    get: {
      parameters: {
        query?: {
          /** @description Search text. Empty returns your most recently photographed species */
          q?: string;
          /** @description Rank species on this region's checklist higher */
          regionId?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              results: {
                /** Format: uuid */
                id: string;
                scientific_name: string;
                common_name: string | null;
                /** @description Higher is better */
                rank?: number;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Species details */
    get: {
      parameters: {
        query?: {
          /** @description Region context */
          regionId?: string;
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              species: {
                scientific_name: string;
                common_name: string | null;
                taxon_class: string | null;
                tier: string | null;
                reference_photo_url: string | null;
              } & {
                [key: string]: unknown;
              };
              captures: ({
                /** Format: uuid */
                id: string;
                photo_id: string | null;
                taken_at: unknown;
              } & {
                [key: string]: unknown;
              })[];
              /** @description The user's state for this species, or null */
              userSpecies: unknown;
              referencePhotos: ({
                /** Format: uuid */
                id: string;
                photo_url: string;
                credit: string | null;
              } & {
                [key: string]: unknown;
              })[];
              seasonality: unknown;
              weeklyFrequency: unknown;
              weeklyRegionName: unknown;
              localTier: unknown;
              isVagrant: unknown;
              isInvasive: unknown;
              endemicCountryName: string | null;
              isArchived: boolean;
              regionBoundaryGeoJson: unknown;
              hotspotDistribution: string | null;
              hotspots: ({
                centroidLat: number;
                centroidLon: number;
                pointCount: number;
                bboxDiagonalKm: number;
                isSensitive: boolean;
                lastSeenYear: number | null;
                distinctYears: number | null;
                recordShare: number;
                isReliable: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/archive": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /species/{id}/archive */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** DELETE /species/{id}/archive */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/card-crop": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** PATCH /species/{id}/card-crop */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            x?: number;
            y?: number;
            size?: number;
            reset?: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/species/{id}/checklist-additions": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Checklists you added a species to
     * @description `items` lists every region whose checklist you added this species to, and `seaZones` every sea zone. A sea zone has no page of its own; `nearRegionId` is a region that offers it as nearby water, or null. 404 for an unknown species.
     */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: {
                /** Format: uuid */
                regionId: string;
                regionName: string;
                /** Format: date-time */
                addedAt: string;
                alreadyOnChecklist: boolean;
              }[];
              seaZones: {
                /** Format: uuid */
                seaZoneId: string;
                seaZoneName: string;
                /** Format: date-time */
                addedAt: string;
                alreadyOnChecklist: boolean;
                nearRegionId: string | null;
              }[];
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the collection.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/cover": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** PATCH /species/{id}/cover */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            photoId: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/species/{id}/encounters": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Your encounters with a species */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              totalPhotos: number;
              videoCount: number;
              encounterCount: number;
              locationCount: number;
              cameraCount: number;
              lensCount: number;
              /** @description Earliest capture time, or null */
              firstPhotographedAt: unknown;
              /** @description Latest capture time, or null */
              lastPhotographedAt: unknown;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/other-taxa": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /species/{id}/other-taxa */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/reference-photo/display": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Main reference photo, display size */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/reference-photo/thumb": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Main reference photo, thumbnail */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/reference-photos": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Reference gallery for a species */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              photos: ({
                url: string;
                credit: string | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/seen": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /species/{id}/seen */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    /** PATCH /species/{id}/seen */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/species/{id}/sequences": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Burst sequences among your photos of a species */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              sequences: ({
                photoIds: string[];
                /** Format: uuid */
                bestPhotoId: string;
                count: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/split": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /species/{id}/split */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    /** Settle photos under a species that was split */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            /**
             * Format: uuid
             * @description One of the species it was split into
             */
            speciesId?: string;
            /** @description True to keep the old name for these photos */
            keep?: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
              updated: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/target": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** DELETE /species/{id}/target */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    /** PATCH /species/{id}/target */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/species/{id}/tier": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /species/{id}/tier */
    get: {
      parameters: {
        query?: {
          regionId?: string;
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/tier-override": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /species/{id}/tier-override */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            regionId?: string | null;
            tier?: ("common" | "occasional" | "uncommon" | "rare" | "legendary") | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/unmatched-raws": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** RAW files for a species not yet paired with a photo */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              rawFiles: ({
                /** Format: uuid */
                id: string;
                filename: string;
                fileSize: number;
                /** Format: date-time */
                addedAt: string;
                previewUrl: string;
                downloadUrl: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/{id}/volume-usage": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Which drives hold this species' files */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              volumes: ({
                volumeId: string | null;
                label: string | null;
                count: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/inat-search": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /species/inat-search */
    get: {
      parameters: {
        query?: {
          q?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/matching-hardware": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /species/matching-hardware */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/matching-hardware/retest": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /species/matching-hardware/retest */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/matching-info": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /species/matching-info */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/matching/warm": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /species/matching/warm */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            regionId?: string | null;
          };
        };
      };
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/other-taxa": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /species/other-taxa */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            inatTaxonId: number;
            regionId: string;
          };
        };
      };
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/other-taxa/bulk": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /species/other-taxa/bulk */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            regionId: string;
            entries: string[];
          };
        };
      };
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/other-taxa/bulk/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /species/other-taxa/bulk/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/other-taxa/bulk/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /species/other-taxa/bulk/status */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/reference-gallery-photo/{photoId}/display": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Reference gallery photo, display size */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          photoId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/species/reference-gallery-photo/{photoId}/thumb": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Reference gallery photo, thumbnail */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          photoId: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "image/webp": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the species.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Library statistics */
    get: {
      parameters: {
        query?: {
          /** @description all (default), featured (species cover photos) or topRated (5 stars) */
          filter?: "all" | "featured" | "topRated";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              totalKeepers: number;
              insights: string[];
              ghostSpecies: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
              } & {
                [key: string]: unknown;
              })[];
              lostSpecies: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
              } & {
                [key: string]: unknown;
              })[];
              rediscoveredSpecies: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
              } & {
                [key: string]: unknown;
              })[];
              perMonth: ({
                /** @description YYYY-MM */
                month: string;
                label: string;
                newLifers: number;
                keepers: number;
              } & {
                [key: string]: unknown;
              })[];
              gearUsage: {
                cameras: ({
                  model: string;
                  photoCount: number;
                  speciesCount: number;
                } & {
                  [key: string]: unknown;
                })[];
                lenses: ({
                  model: string;
                  photoCount: number;
                  speciesCount: number;
                } & {
                  [key: string]: unknown;
                })[];
                combos: ({
                  camera: string;
                  lens: string;
                  photoCount: number;
                  speciesCount: number;
                } & {
                  [key: string]: unknown;
                })[];
              } & {
                [key: string]: unknown;
              };
              timeOfDay: ({
                hour: number;
                label: string;
                count: number;
              } & {
                [key: string]: unknown;
              })[];
              exifDistributions: {
                focalLength: ({
                  label: string;
                  count: number;
                  /** @description A sample of up to 300 photos in this bucket */
                  photoIds: string[];
                } & {
                  [key: string]: unknown;
                })[];
                iso: ({
                  label: string;
                  count: number;
                  /** @description A sample of up to 300 photos in this bucket */
                  photoIds: string[];
                } & {
                  [key: string]: unknown;
                })[];
                aperture: ({
                  label: string;
                  count: number;
                  /** @description A sample of up to 300 photos in this bucket */
                  photoIds: string[];
                } & {
                  [key: string]: unknown;
                })[];
                shutter: ({
                  label: string;
                  count: number;
                  /** @description A sample of up to 300 photos in this bucket */
                  photoIds: string[];
                } & {
                  [key: string]: unknown;
                })[];
              } & {
                [key: string]: unknown;
              };
              hitRateByFocalLength: ({
                label: string;
                species: number;
              } & {
                [key: string]: unknown;
              })[];
              scatter: ({
                focalLength: number | null;
                aperture: number | null;
                iso: number | null;
                shutterSeconds: number | null;
                shutterLabel: string | null;
                scientificName: string;
                commonName: string | null;
                photoId: string | null;
                camera: string | null;
                lens: string | null;
                takenAt: string | null;
              } & {
                [key: string]: unknown;
              })[];
              countriesPhotographed: {
                count: number;
                countries: ({
                  name: string;
                  photoCount: number;
                } & {
                  [key: string]: unknown;
                })[];
              } & {
                [key: string]: unknown;
              };
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats/archive-health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Missing files, unconnected drives and similar */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              total: number;
              missingDate: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats/export.csv": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Life list as CSV */
    get: {
      parameters: {
        query?: {
          /** @description all (default), featured (species cover photos) or topRated (5 stars) */
          filter?: "all" | "featured" | "topRated";
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "text/csv": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats/gear-species-breakdown": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Species by camera and lens */
    get: {
      parameters: {
        query?: {
          /** @description Camera model, as in GET /stats */
          camera?: string;
          /** @description Lens, as in GET /stats */
          lens?: string;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              breakdown: ({
                taxonClass: string;
                count: number;
                percent: number;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats/photography-dna": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Shooting habits */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              taxonBreakdown: ({
                taxonClass: string;
                count: number;
                percent: number;
              } & {
                [key: string]: unknown;
              })[];
              categoryBreakdown: ({
                key: string;
                count: number;
                percent: number;
              } & {
                [key: string]: unknown;
              })[];
              medianFocalLengthMm: number | null;
              medianShutterSeconds: number | null;
              medianIso: number | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats/species-portfolio": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Per-species photo coverage */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              species: ({
                /** Format: uuid */
                speciesId: string;
                commonName: string | null;
                scientificName: string;
                taxonClass: string;
                totalPhotos: number;
                rated4Plus: number;
                bestRating: number | null;
                earliestTakenAt: string | null;
                latestTakenAt: string | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/stats/year-comparison": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Year-over-year comparison */
    get: {
      parameters: {
        query: {
          /** @description First year, e.g. 2025 */
          yearA: number;
          /** @description Second year */
          yearB: number;
        };
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              a: {
                year: number;
                speciesCount: number;
                photoCount: number;
                avgFocalLength: number | null;
                avgIso: number | null;
              } & {
                [key: string]: unknown;
              };
              b: {
                year: number;
                speciesCount: number;
                photoCount: number;
                avgFocalLength: number | null;
                avgIso: number | null;
              } & {
                [key: string]: unknown;
              };
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the stats.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/storage-volumes": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /storage-volumes */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              volumes: ({
                /** Format: uuid */
                id: string;
                label: string;
                /** @enum {unknown} */
                kind: "drive" | "root";
                mountPath: string;
                rootPath: string | null;
                connected: boolean;
                /** Format: date-time */
                lastSeenAt: string;
                isDefault: boolean;
                /** @description Declared in the server's environment, not editable here */
                managedByEnv: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    /** POST /storage-volumes */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            path: string;
            label: string;
          };
        };
      };
      responses: {
        /** @description OK */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              label: string;
              mountPath: string;
              connected: boolean;
              /** @description Photos already on the drive that were linked back to it */
              readopted: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/storage-volumes/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /storage-volumes/{id} */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            label: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    /** DELETE /storage-volumes/{id} */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/storage-volumes/{id}/default": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /storage-volumes/{id}/default */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trash": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** GET /trash */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              retentionDays: number;
              items: ({
                /** Format: uuid */
                captureId: string;
                /** Format: uuid */
                speciesId: string;
                speciesName: string;
                /** Format: date-time */
                deletedAt: string;
                pendingDeleteRaw: boolean | null;
                photoId: string | null;
                width: number | null;
                height: number | null;
                hasRawOriginal: boolean;
                /** @enum {unknown} */
                kind: "image" | "video";
                durationSeconds: (number | string) | null;
                originalKind: string | null;
                /** Format: date-time */
                purgesAt: string;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trash/{id}/restore": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trash/{id}/restore */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trash/empty": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trash/empty */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              purged: number;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Trips */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              trips: ({
                /** Format: uuid */
                id: string;
                name: string;
                sourceFolder: string;
                destinationFolder: string;
                speciesCount: number;
                captureCount: number;
                earliestTakenAt: string | null;
                latestTakenAt: string | null;
                coverPhotoUrl: string | null;
                coverCropX: number | null;
                coverCropY: number | null;
                coverCropSize: number | null;
                /** @enum {unknown} */
                coverLayout: "single" | "quad";
                /** @description Up to 4 recent photos, for a quad cover */
                quadPhotoIds: string[];
                /** @description A scan or import is running */
                processing: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    /** POST /trips */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name?: string;
            sourceFolder: string;
            destinationFolder?: string;
          };
        };
      };
      responses: {
        /** @description OK */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              destinationFolder: string;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Trip details */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              name: string;
              description: string | null;
              sourceFolder: string;
              destinationFolder: string;
              coverCaptureId: string | null;
              coverCropX: number | null;
              coverCropY: number | null;
              coverCropSize: number | null;
              /** @enum {unknown} */
              coverLayout: "single" | "quad";
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    /** DELETE /trips/{id} */
    delete: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    options?: never;
    head?: never;
    /** PATCH /trips/{id} */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            sourceFolder?: string;
            destinationFolder?: string;
            name?: string;
            description?: string | null;
            /** @enum {unknown} */
            coverLayout?: "single" | "quad";
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/trips/{id}/cover": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** PUT /trips/{id}/cover */
    put: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            captureId: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/cover-crop": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    /** PATCH /trips/{id}/cover-crop */
    patch: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            x?: number;
            y?: number;
            size?: number;
            reset?: boolean;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              ok: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/trips/{id}/import": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trips/{id}/import */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            files: {
              relativePath: string;
              /** Format: uuid */
              speciesId: string;
            }[];
            regionId?: string | null;
            /**
             * @description Photos a culling app rejected: skip (the default) leaves them out, hide imports them hidden, ignore imports them as usual
             * @enum {unknown}
             */
            cullMarks?: "skip" | "hide" | "ignore";
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/import/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trips/{id}/import/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/import/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Trip import progress */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result:
                | ({
                    imported: number;
                    failed: number;
                    skipped: number;
                    hidden: number;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              /** Format: uuid */
              tripId: string;
              /** @description Grows as files finish */
              results: ({
                relativePath: string;
                /** Format: uuid */
                captureId?: string;
                error?: string;
                /** @constant */
                skipped?: "rejected";
                hidden?: boolean;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/inspect": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trips/{id}/inspect */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            relativePath: string;
            regionId?: string | null;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              suggestions: ({
                /** Format: uuid */
                id: string;
                scientific_name: string;
                common_name: string | null;
                score: number;
                /** @description your_photos, reference_photo or keyword_tag */
                source: string;
                confident?: boolean;
                matchPercent?: number;
              } & {
                [key: string]: unknown;
              })[];
              notWildlife:
                | ({
                    looksLike: string;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              invertebrate:
                | ({
                    looksLike: string;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              takenAt: string | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/photos": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Photos from a trip */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                photoId: string;
                width: number | null;
                height: number | null;
                /** Format: uuid */
                captureId: string;
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                takenAt: string | null;
                hasRaw: boolean;
                originalRef: string | null;
                originalKind: string | null;
                cameraModel: string | null;
                lens: string | null;
                focalLengthMm: (number | string) | null;
                aperture: (number | string) | null;
                shutter: string | null;
                iso: number | null;
                qualityRating: number | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/scan": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trips/{id}/scan */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              started: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/scan-preview": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Preview of a file in a trip folder
     * @description The image or video itself; a RAW, TIFF or HEIC file comes as a JPEG made from it.
     */
    get: {
      parameters: {
        query: {
          /** @description Path of the file inside the trip folder */
          file: string;
        };
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The file */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "*/*": string;
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/scan/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trips/{id}/scan/cancel */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              cancelled: boolean;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/scan/status": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Trip folder scan progress */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              running: boolean;
              phase: string | null;
              downloadedBytes: number | null;
              totalBytes: number | null;
              processed: number | null;
              total: number | null;
              currentItem: string | null;
              error: string | null;
              finishedAt: number | null;
              cancelRequested: boolean;
              cancelled: boolean;
              result:
                | ({
                    relinked: number;
                    markedStale: number;
                    collisions: number;
                    recovered: number;
                    rawsLinked: number;
                    newFiles: ({
                      relativePath: string;
                      cull: {
                        verdict: ("pick" | "reject") | null;
                        label:
                          | ("red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" | "black" | "white")
                          | null;
                      } & {
                        [key: string]: unknown;
                      };
                    } & {
                      [key: string]: unknown;
                    })[];
                    cullRejected: number;
                    cullPicked: number;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              /** Format: uuid */
              tripId: string;
              relinked: number;
              markedStale: number;
              collisions: number;
              recovered: number;
              rawsLinked: number;
              newFiles: ({
                relativePath: string;
                cull: {
                  verdict: ("pick" | "reject") | null;
                  label:
                    ("red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" | "black" | "white") | null;
                } & {
                  [key: string]: unknown;
                };
              } & {
                [key: string]: unknown;
              })[];
              cullRejected: number;
              cullPicked: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/species": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Species seen on a trip */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              items: ({
                /** Format: uuid */
                speciesId: string;
                scientificName: string;
                commonName: string | null;
                taxonClass: string | null;
                family: string | null;
                taxonOrder?: string | null;
                /** @enum {unknown} */
                state: "collected" | "seen" | "unseen";
                isTarget: boolean;
                tier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                localTier: ("common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated") | null;
                tierReason?: string | null;
                localTierReason?: string | null;
                tierOverridden?: boolean;
                nameChanged?: boolean;
                vagrant: boolean;
                /** @description 12 monthly values, on region checklist rows */
                seasonality: null | number[];
                capturedYears: number[] | null;
                endemic: boolean;
                isGhost: boolean;
                isLost: boolean;
                rediscoveredGhost: boolean;
                rediscoveredLost: boolean;
                coverPhotoUrl: string | null;
                coverPhotoCredit: string | null;
                cardCropX: number | null;
                cardCropY: number | null;
                cardCropSize: number | null;
                referenceFocalX: number | null;
                referenceFocalY: number | null;
                coverVolumeLabel: string | null;
                isOtherTaxa: boolean;
                inatIconicTaxon: string | null;
                userAddedRegion?:
                  | ({
                      /** Format: uuid */
                      id: string;
                      name: string;
                      /** @enum {unknown} */
                      kind: "region" | "seaZone";
                    } & {
                      [key: string]: unknown;
                    })
                  | null;
              } & {
                [key: string]: unknown;
              })[];
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/{id}/summary": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** Trip summary */
    get: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              speciesCount: number;
              liferCount: number;
              rareCount: number;
              endemicCount: number;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the trips.read scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/trips/build": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /trips/build */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "application/json": {
            name?: string;
            parentDir: string;
          };
        };
      };
      responses: {
        /** @description OK */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              id: string;
              sourceFolder: string;
              destinationFolder: string;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Import a photo
     * @description multipart/form-data. Accepted photos: .jpg/.jpeg/.jpe (image/jpeg, image/jpg, image/pjpeg); .png (image/png); .webp (image/webp); .tif/.tiff (image/tiff, image/tif, image/x-tiff); .heic/.heif/.hif (image/heic, image/heif, image/heic-sequence, image/heif-sequence). A camera RAW (or a TIFF holding sensor data) can also be sent on its own. The file's own metadata (capture time, GPS, camera, star rating) is read on import. With `skipDuplicates=1`, an exact copy you already have returns that photo (200, `duplicate: true`) instead of a second one. `cullMarks` decides what happens to a photo a culling app rejected (xmp:Rating -1, a Lightroom, digiKam, Vireo or SuperPicky reject flag): `ignore` (the default) imports it, `skip` answers 200 with `skipped: "rejected"` and imports nothing, `hide` imports it hidden (`hidden: true`, out of the gallery and life list until unhidden). A verdict on `rawFile` counts for `file` too. The file is only read, never changed. Instead of `file`, send `uploadId` (a finished resumable upload, see /uploads/tus) or, after POST /uploads/inspect, `stagedId` with `fileName` and `fileType` to import the copy the server kept. 410 means that copy is gone (expired, already imported or never finished), so send the file again; 409 means the same upload is being imported by another request.
     */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "multipart/form-data": {
            /**
             * Format: binary
             * @description The photo (or a RAW file on its own)
             */
            file?: string;
            /**
             * Format: binary
             * @description Optional RAW that goes with `file`
             */
            rawFile?: string;
            /**
             * Format: uuid
             * @description Required. Find it with GET /species?q=
             */
            speciesId: string;
            /** Format: uuid */
            regionId?: string;
            locationLabel?: string;
            /** Format: uuid */
            albumId?: string;
            /** Format: uuid */
            tripId?: string;
            /** @enum {string} */
            skipDuplicates?: "1";
            /**
             * @description What to do if a culling app rejected the photo: ignore (default), skip or hide
             * @enum {string}
             */
            cullMarks?: "ignore" | "skip" | "hide";
            /** @description Instead of `file`: a finished resumable upload (the last path segment of its /uploads/tus URL) */
            uploadId?: string;
            /** @description Instead of `rawFile`: the RAW as a finished resumable upload */
            rawUploadId?: string;
            /** @description Instead of `file`: the `stagedId` from POST /uploads/inspect */
            stagedId?: string;
            /** @description With `stagedId`: the original file name (optional with `uploadId`, which knows its own) */
            fileName?: string;
            /** @description With `stagedId`: the file's MIME type, e.g. image/jpeg (optional with `uploadId`) */
            fileType?: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              captureId?: string;
              photoId?: string | null;
              duplicate?: boolean;
              /** @constant */
              skipped?: "rejected";
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description OK */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              /** Format: uuid */
              captureId: string;
              photoId: string | null;
              hidden: boolean;
              linkedExisting?: boolean;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads/inspect": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Check a photo before importing it
     * @description multipart/form-data with `file`, or `uploadId` for a finished resumable upload (read where it is; import it next with the same `uploadId`). Reports an exact or near-identical photo you already have and, with `regionId`, species suggestions. A `file` is kept for 2 hours so POST /uploads can import it by `stagedId` without sending it again. `previewDataUrl` is a JPEG for files a browser can't show (RAW, TIFF, HEIC). `cull` is what a culling app marked in the file's own metadata: `verdict` (`pick`, `reject` or null) and `label` (a colour, or null). 410 when `uploadId` is gone.
     */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody: {
        content: {
          "multipart/form-data": {
            /** Format: binary */
            file?: string;
            /** @description Instead of `file`: a finished resumable upload */
            uploadId?: string;
            /** Format: uuid */
            regionId?: string;
          };
        };
      };
      responses: {
        /** @description OK */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": {
              takenAt: string | null;
              keywords: string[];
              cull: {
                verdict: ("pick" | "reject") | null;
                label: ("red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray" | "black" | "white") | null;
              } & {
                [key: string]: unknown;
              };
              possibleDuplicate:
                | ({
                    /** Format: uuid */
                    captureId: string;
                    photoId: string | null;
                    /** Format: uuid */
                    speciesId: string;
                    speciesName: string;
                    scientificName: string;
                    commonName: string | null;
                    takenAt: string | null;
                    exact: boolean;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              suggestions: ({
                /** Format: uuid */
                id: string;
                scientific_name: string;
                common_name: string | null;
                score: number;
                /** @description your_photos, reference_photo or keyword_tag */
                source: string;
                confident?: boolean;
                matchPercent?: number;
              } & {
                [key: string]: unknown;
              })[];
              burst:
                | ({
                    uploadIds: string[];
                    suggestions: ({
                      /** Format: uuid */
                      id: string;
                      scientific_name: string;
                      common_name: string | null;
                      score: number;
                      /** @description your_photos, reference_photo or keyword_tag */
                      source: string;
                      confident?: boolean;
                      matchPercent?: number;
                    } & {
                      [key: string]: unknown;
                    })[];
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              matchingMs: number | null;
              previewDataUrl: string | null;
              stagedId: string | null;
              uploadId: string | null;
              notWildlife:
                | ({
                    looksLike: string;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              invertebrate:
                | ({
                    looksLike: string;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
              rawMatch:
                | ({
                    /** Format: uuid */
                    captureId: string;
                    /** Format: uuid */
                    speciesId: string;
                    speciesName: string;
                    scientificName: string;
                    commonName: string | null;
                  } & {
                    [key: string]: unknown;
                  })
                | null;
            } & {
              [key: string]: unknown;
            };
          };
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads/raw": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /uploads/raw */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads/tus": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Start a resumable upload (tus 1.0)
     * @description The tus 1.0 protocol (https://tus.io/protocols/resumable-upload) with the creation, creation-with-upload, creation-defer-length, termination and expiration extensions, for files of any size through any proxy. Answers 201 with a relative `Location` (`/api/uploads/tus/{id}`); `{id}` is the `uploadId` other endpoints take. Send the bytes with PATCH in chunks (8 MB works everywhere; a proxy that answers 413 needs smaller ones). A finished upload is kept 2 hours for an import, and an unfinished one 2 hours after its last chunk (`Upload-Expires`). Uploads belong to the user who created them. A browser session also needs the `x-lifer-client: 1` header. 413 when `Upload-Length` is over the server's MAX_UPLOAD_BYTES.
     */
    post: {
      parameters: {
        query?: never;
        header: {
          /** @description 1.0.0 */
          "Tus-Resumable": string;
          /** @description Total size in bytes (or Upload-Defer-Length: 1) */
          "Upload-Length"?: string;
          /** @description Comma-separated `key base64value` pairs: `filename` and `filetype` (the MIME type) */
          "Upload-Metadata"?: string;
        };
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Created. `Location` is the upload URL */
        201: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    /** Resumable upload capabilities */
    options: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description `Tus-Version`, `Tus-Extension` and `Tus-Max-Size` headers */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/uploads/tus/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /** Cancel a resumable upload */
    delete: {
      parameters: {
        query?: never;
        header: {
          /** @description 1.0.0 */
          "Tus-Resumable": string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Deleted */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** Resumable upload capabilities */
    options: {
      parameters: {
        query?: never;
        header?: never;
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description `Tus-Version`, `Tus-Extension` and `Tus-Max-Size` headers */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /** How much of a resumable upload arrived */
    head: {
      parameters: {
        query?: never;
        header: {
          /** @description 1.0.0 */
          "Tus-Resumable": string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description `Upload-Offset` (resume from here), `Upload-Length` and `Upload-Metadata` */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    /**
     * Send the next chunk of a resumable upload
     * @description Body: `application/offset+octet-stream`, starting at `Upload-Offset`. 409 when the offset doesn't match the server's (ask with HEAD), 404 for an upload that isn't yours, 410 when it expired.
     */
    patch: {
      parameters: {
        query?: never;
        header: {
          /** @description 1.0.0 */
          "Tus-Resumable": string;
          /** @description Where this chunk starts */
          "Upload-Offset": string;
        };
        path: {
          id: string;
        };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description The new `Upload-Offset` */
        204: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Missing key, or the key lacks the photos.write scope */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    trace?: never;
  };
  "/uploads/video": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** POST /uploads/video */
    post: {
      parameters: {
        query?: never;
        header?: never;
        path?: never;
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        /** @description Not described yet */
        200: {
          headers: {
            [name: string]: unknown;
          };
          content?: never;
        };
        /** @description The request doesn't match this operation's parameters or body */
        400: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Not signed in */
        401: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
        /** @description Any other error */
        default: {
          headers: {
            [name: string]: unknown;
          };
          content: {
            "application/json": components["schemas"]["Error"];
          };
        };
      };
    };
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    Error: {
      /** @description What went wrong, fit to show a person */
      error: string;
      /** @description Stable reason code, when there is one */
      code?: string;
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
