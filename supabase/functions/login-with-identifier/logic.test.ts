import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isEmailIdentifier } from './logic.ts';

Deno.test('isEmailIdentifier - true for a string containing @', () => {
    assertEquals(isEmailIdentifier('someone@example.com'), true);
});

Deno.test('isEmailIdentifier - false for a plain username', () => {
    assertEquals(isEmailIdentifier('woogi999'), false);
});

Deno.test('isEmailIdentifier - false for an empty string', () => {
    assertEquals(isEmailIdentifier(''), false);
});
