/**
 * Server-side Haversine Distance & Speed Verification Engine
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_METERS = 6371000; // Earth mean radius in meters

/**
 * Checks whether coordinate values are valid finite WGS-84 numbers.
 */
export function isValidLatLng(p: any): p is LatLng {
  return (
    p != null &&
    typeof p.lat === 'number' &&
    Number.isFinite(p.lat) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    typeof p.lng === 'number' &&
    Number.isFinite(p.lng) &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/**
 * Calculates the great-circle distance in meters between two lat/lng coordinates
 * using the Haversine formula. Includes bounds clipping to eliminate floating-point NaN.
 */
export function calculateHaversineDistanceMeters(p1: LatLng, p2: LatLng): number {
  if (!isValidLatLng(p1) || !isValidLatLng(p2)) {
    return NaN;
  }

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.lat)) *
    Math.cos(toRad(p2.lat)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);

  // Clamp 'a' to [0, 1] to prevent Math.sqrt of negative numbers from floating-point errors
  const clampedA = Math.max(0, Math.min(1, a));
  const c = 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Performs authoritative server-side speed and teleportation verification between coordinate updates.
 * Flags payload as overspeed if calculated speed exceeds speedLimitMps (default 6.7 m/s / ~24 km/h),
 * or if significant distance was traversed with frozen/past timestamps.
 */
export function verifyPlayerSpeed(
  prevCoords: LatLng | null | undefined,
  prevTimestamp: number | null | undefined,
  currentCoords: LatLng,
  currentTimestamp: number,
  speedLimitMps: number = 6.7,
  reportedSpeed?: number,
  accuracy?: number
): {
  calculatedSpeed: number;
  distanceMeters: number;
  timeDeltaSeconds: number;
  isOverspeed: boolean;
} {
  // If first update, fall back to reported speed
  if (!prevCoords || !prevTimestamp) {
    const fallbackSpeed = reportedSpeed ?? 0;
    return {
      calculatedSpeed: fallbackSpeed,
      distanceMeters: 0,
      timeDeltaSeconds: 0,
      isOverspeed: fallbackSpeed > speedLimitMps,
    };
  }

  // Calculate distance
  const distanceMeters = calculateHaversineDistanceMeters(prevCoords, currentCoords);
  if (isNaN(distanceMeters)) {
    // Malformed coordinates detected
    return {
      calculatedSpeed: 0,
      distanceMeters: 0,
      timeDeltaSeconds: 0,
      isOverspeed: true,
    };
  }

  const timeDeltaSeconds = (currentTimestamp - prevTimestamp) / 1000;

  // Anti-Cheat: Frozen or backwards timestamp exploit check
  if (timeDeltaSeconds <= 0) {
    // If distance moved is greater than 5 meters with 0 or negative elapsed time,
    // this is a teleportation attack or clock tampering exploit
    if (distanceMeters > 5) {
      return {
        calculatedSpeed: 999.0,
        distanceMeters,
        timeDeltaSeconds: 0,
        isOverspeed: true,
      };
    }
    // Negligible distance with repeated timestamp
    const fallbackSpeed = reportedSpeed ?? 0;
    return {
      calculatedSpeed: fallbackSpeed,
      distanceMeters,
      timeDeltaSeconds: 0,
      isOverspeed: fallbackSpeed > speedLimitMps,
    };
  }

  // If low GPS accuracy (> 35m), don't trigger false overspeed from satellite drift
  if (accuracy && accuracy > 35.0 && distanceMeters < accuracy * 1.5) {
    const safeSpeed = reportedSpeed ?? 0;
    return {
      calculatedSpeed: safeSpeed,
      distanceMeters,
      timeDeltaSeconds,
      isOverspeed: safeSpeed > speedLimitMps,
    };
  }

  // For small movements (< 2.5m) within 2 seconds, treat as GPS drift/stationary
  if (distanceMeters < 2.5 && timeDeltaSeconds <= 2.0 && (!reportedSpeed || reportedSpeed < 0.5)) {
    return {
      calculatedSpeed: 0,
      distanceMeters,
      timeDeltaSeconds,
      isOverspeed: false,
    };
  }

  // Compute speed: prefer Doppler reported speed if positive and valid;
  // otherwise calculate from distance / time
  let calculatedSpeed = reportedSpeed && reportedSpeed > 0
    ? reportedSpeed
    : (timeDeltaSeconds >= 0.5 ? distanceMeters / timeDeltaSeconds : (reportedSpeed ?? 0));

  // If calculating from distance / time, ensure we don't divide by tiny fractions of a second
  if (timeDeltaSeconds < 0.8 && distanceMeters < 8.0) {
    calculatedSpeed = reportedSpeed ?? (distanceMeters / Math.max(1.0, timeDeltaSeconds));
  }

  const isOverspeed = calculatedSpeed > speedLimitMps;

  return {
    calculatedSpeed,
    distanceMeters,
    timeDeltaSeconds,
    isOverspeed,
  };
}

/**
 * Formats public landmark / street names cleanly.
 */
function formatPublicName(raw: string): string {
  if (!raw) return 'Public Road';
  const clean = raw.trim();
  const capped = clean.length > 28 ? clean.slice(0, 28) : clean;
  return capped.toUpperCase();
}

/**
 * Robust fallback generator producing designated public road intersections and civic waypoints.
 */
export function generatePublicRoadWaypointsFallback(
  center: LatLng,
  radiusMeters: number,
  count: number
): { id: string; order: number; lat: number; lng: number; name: string }[] {
  const publicPlaceNames = [
    'Civic Plaza Crossing',
    'Public Promenade Junction',
    'Main Avenue Crossing',
    'Central Boulevard Way',
    'Park Perimeter Waypoint',
    'Station Square Road',
    'Public Transit Crossway',
    'Community Centre Road',
    'Heritage Park Waypoint',
    'Grand Circle Crossing',
    'Riverfront Promenade',
    'Library Square Road',
    'North Avenue Junction',
    'South Boulevard Crossing',
    'East Civic Crossway',
  ];

  const checkpoints: { id: string; order: number; lat: number; lng: number; name: string }[] = [];
  const safeRadius = Math.max(30, radiusMeters * 0.85);

  for (let i = 0; i < count; i++) {
    // Distribute along road network bearings
    const angleStep = (2 * Math.PI) / count;
    const theta = i * angleStep + (Math.random() * 0.2 - 0.1);
    const u = 0.25 + 0.70 * ((i % 3 + 1) / 3.0);
    const r = safeRadius * Math.sqrt(u);

    const dx = r * Math.cos(theta);
    const dy = r * Math.sin(theta);

    const latRad = (center.lat * Math.PI) / 180;
    const dLat = dy / 111320.0;
    const dLng = dx / (111320.0 * Math.cos(latRad));

    const lat = center.lat + dLat;
    const lng = center.lng + dLng;

    const placeName = publicPlaceNames[i % publicPlaceNames.length];

    checkpoints.push({
      id: `cp_${i + 1}_${Math.random().toString(36).substring(2, 6)}`,
      order: i + 1,
      lat: parseFloat(lat.toFixed(6)),
      lng: parseFloat(lng.toFixed(6)),
      name: placeName,
    });
  }

  return checkpoints;
}

/**
 * Fetches real public places (parks, plazas, community squares) and roads (highways, footways)
 * from OpenStreetMap Overpass API within the specified radius of the center.
 * If offline or query times out, falls back to public road bearing nodes.
 */
export async function generatePublicRoadCheckpoints(
  center: LatLng,
  radiusMeters: number,
  count: number
): Promise<{ id: string; order: number; lat: number; lng: number; name?: string }[]> {
  try {
    const query = `[out:json][timeout:3];(way["highway"~"residential|tertiary|secondary|primary|footway|pedestrian|living_street"](around:${Math.round(radiusMeters)},${center.lat},${center.lng});node["amenity"~"park|plaza|bench|cafe|fountain|library|community_centre"](around:${Math.round(radiusMeters)},${center.lat},${center.lng});node["leisure"~"park|playground|garden|pitch"](around:${Math.round(radiusMeters)},${center.lat},${center.lng}););out center 40;`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = (await response.json()) as any;
      const elements = data?.elements || [];
      const validPoints: { lat: number; lng: number; name: string }[] = [];

      for (const el of elements) {
        const ptLat = el.lat ?? el.center?.lat;
        const ptLng = el.lng ?? el.center?.lng;
        if (typeof ptLat === 'number' && typeof ptLng === 'number') {
          const dist = calculateHaversineDistanceMeters(center, { lat: ptLat, lng: ptLng });
          if (dist <= radiusMeters) {
            const rawName = el.tags?.name || el.tags?.highway || el.tags?.amenity || el.tags?.leisure || 'Public Road';
            const formattedName = formatPublicName(rawName);
            validPoints.push({ lat: ptLat, lng: ptLng, name: formattedName });
          }
        }
      }

      if (validPoints.length >= count) {
        const shuffled = shuffleArray(validPoints).slice(0, count);
        return shuffled.map((pt, idx) => ({
          id: `cp_${idx + 1}_${Math.random().toString(36).substring(2, 6)}`,
          order: idx + 1,
          lat: parseFloat(pt.lat.toFixed(6)),
          lng: parseFloat(pt.lng.toFixed(6)),
          name: pt.name,
        }));
      }
    }
  } catch {
    // Overpass query timed out or offline, proceed to fallback
  }

  return generatePublicRoadWaypointsFallback(center, radiusMeters, count);
}

/**
 * Generates `count` random GPS coordinates uniformly distributed within a geofence circle.
 */
export function generateRandomGeofenceCoordinates(
  center: LatLng,
  radiusMeters: number,
  count: number
): { id: string; order: number; lat: number; lng: number; name?: string }[] {
  return generatePublicRoadWaypointsFallback(center, radiusMeters, count);
}

/**
 * Shuffles an array independently using Fisher-Yates algorithm.
 */
export function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
