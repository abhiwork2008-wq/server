import crypto from 'crypto';

/**
 * Standard uppercase alphanumeric character set (A-Z, 0-9).
 * Can optionally exclude ambiguous characters (0, O, 1, I) if desired,
 * but uppercase alphanumeric set produces codes like 'XR7B9P'.
 */
const ALPHANUMERIC_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes ambiguous '0','O','1','I'
const FULL_ALPHANUMERIC_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a 6-character uppercase alphanumeric room code (e.g., 'XR7B9P').
 * Uses cryptographically secure random integers.
 * 
 * @param length Length of the room code (defaults to 6)
 * @param excludeAmbiguous Whether to exclude ambiguous chars 0/O/1/I (defaults to false to support any uppercase alphanumeric like XR7B9P)
 * @returns 6-character uppercase alphanumeric string
 */
export function generateRoomCode(length: number = 6, excludeAmbiguous: boolean = false): string {
  const charset = excludeAmbiguous ? ALPHANUMERIC_CHARSET : FULL_ALPHANUMERIC_CHARSET;
  const charsetLength = charset.length;
  let code = '';

  for (let i = 0; i < length; i++) {
    const randomIndex = crypto.randomInt(0, charsetLength);
    code += charset[randomIndex];
  }

  return code;
}

/**
 * Validates whether a room code is a valid 6-character uppercase alphanumeric string.
 */
export function isValidRoomCode(code: string): boolean {
  if (!code || typeof code !== 'string') return false;
  return /^[A-Z0-9]{6}$/.test(code.trim().toUpperCase());
}
