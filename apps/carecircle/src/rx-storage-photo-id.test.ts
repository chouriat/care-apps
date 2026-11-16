// Added in review of PR #28: on a phone (Hermes) there is no `crypto.randomUUID`, so a new
// prescription photo id must come from Expo's native UUID generator instead of crashing.
import { createPrescriptionPhotoId } from './features/meds/rx-storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('createPrescriptionPhotoId', () => {
  it('uses crypto.randomUUID when the runtime has it (Jest, web)', () => {
    expect(createPrescriptionPhotoId()).toMatch(UUID);
    expect(
      createPrescriptionPhotoId({
        crypto: { randomUUID: () => 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' },
      }),
    ).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('falls back to the native Expo UUID generator when crypto.randomUUID is missing (Hermes)', () => {
    expect(
      createPrescriptionPhotoId({
        expo: { uuidv4: () => '0F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9' },
      }),
    ).toBe('0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9');
    expect(
      createPrescriptionPhotoId({
        crypto: {},
        expo: { uuidv4: () => '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9' },
      }),
    ).toBe('0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9');
  });

  it('throws instead of inventing an id when no generator exists or it returns garbage', () => {
    expect(() => createPrescriptionPhotoId({})).toThrow();
    expect(() => createPrescriptionPhotoId({ expo: { uuidv4: () => '../evil' } })).toThrow();
  });
});
