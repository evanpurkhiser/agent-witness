import {describe, expect, it} from 'vitest';

import {sshFingerprint} from 'app/ssh/fingerprint';
import {pubKeyFixture} from 'app/test-helpers';

// Ground-truth fingerprints from `ssh-keygen -lf <fixture>.pub`.
const EXPECTED = {
  ed25519: 'SHA256:wCyFHQrqFBBRWCuNhhcbEGlxmNh8w/nfJ1Bpf64T1Bc',
  rsa: 'SHA256:ZkpHPvsJ/hUCV+pMPfr/V9jFBWydRwbXcTLcmtkfhiM',
  ecdsa: 'SHA256:DmNuHme4sYanxz4f+ym4HAISRL54jo/Vl4x+rksJzXk',
} as const;

describe('sshFingerprint', () => {
  it.each(Object.entries(EXPECTED))(
    'matches ssh-keygen for %s',
    async (name, expected) => {
      expect(await sshFingerprint(pubKeyFixture(name))).toBe(expected);
    },
  );
});
