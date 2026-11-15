import { redirectSystemPath } from '../app/+native-intent';

describe('sign-in link routing', () => {
  const link = 'carecircle:///auth/callback?code=b9b957a7-016a-4d0c-9e00-8963dbe16b0f';

  it('never sends the sign-in link to a screen that does not exist', () => {
    expect(redirectSystemPath({ path: link, initial: true })).toBe('/');
    expect(redirectSystemPath({ path: link, initial: false })).toBeNull();
    expect(redirectSystemPath({ path: '/auth/callback?code=abc', initial: false })).toBeNull();
  });

  it('leaves other links alone', () => {
    expect(redirectSystemPath({ path: '/gallery', initial: false })).toBe('/gallery');
  });
});
