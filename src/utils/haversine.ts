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
