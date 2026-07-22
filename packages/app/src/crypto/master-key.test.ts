import {describe, expect, it} from 'vitest';

import {
  deriveWrappingKey,
  generateMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
} from 'app/crypto/master-key';
import {random} from 'app/utils/bytes';

describe('master key envelope', () => {
  it('round-trips the master key with the same passkey', async () => {
    const prfOutput = random(32);
    const salt = random(32);
    const master = await generateMasterKey();

    const blob = await wrapMasterKey(master, await deriveWrappingKey(prfOutput, salt));
    const recovered = await unwrapMasterKey(
      blob,
      await deriveWrappingKey(prfOutput, salt),
    );

    expect(recovered.usages).toContain('unwrapKey');
    expect(recovered.extractable).toBe(false);
  });

  it('rejects unwrapping with a different passkey', async () => {
    const prfOutput = random(32);
    const master = await generateMasterKey();
    const blob = await wrapMasterKey(
      master,
      await deriveWrappingKey(prfOutput, random(32)),
    );

    await expect(
      unwrapMasterKey(blob, await deriveWrappingKey(prfOutput, random(32))),
    ).rejects.toThrow();
  });
});
