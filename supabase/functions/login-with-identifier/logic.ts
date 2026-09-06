export function isEmailIdentifier(identifier: string): boolean {
    return identifier.includes('@');
}

export const GENERIC_INVALID_MESSAGE = 'Invalid username or password.';
export const RATE_LIMITED_MESSAGE = 'Too many attempts. Please try again in a few minutes.';
