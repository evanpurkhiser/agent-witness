import {describe, expect, it} from 'vitest';

import {readFileSync} from 'node:fs';

import {sshFingerprint} from 'app/ssh/fingerprint';
import {b64decode} from 'app/utils/bytes';

// Ground-truth fingerprints from `ssh-keygen -lf <fixture>.pub`.
const EXPECTED = {
  ed25519: 'SHA256:wCyFHQrqFBBRWCuNhhcbEGlxmNh8w/nfJ1Bpf64T1Bc',
  rsa: 'SHA256:ZkpHPvsJ/hUCV+pMPfr/V9jFBWydRwbXcTLcmtkfhiM',
  ecdsa: 'SHA256:DmNuHme4sYanxz4f+ym4HAISRL54jo/Vl4x+rksJzXk',
} as const;

/**
 * The base64-decoded key blob from a `.pub` fixture file.
 */
function pubBlob(name: string): Uint8Array<ArrayBuffer> {
  const text = readFileSync(
    new URL(`../../../../fixtures/keys/${name}.pub`, import.meta.url),
    'utf8',
  );
  return b64decode(text.split(/\s+/)[1]);
}

describe('sshFingerprint', () => {
  it.each(Object.entries(EXPECTED))(
    'matches ssh-keygen for %s',
    async (name, expected) => {
      expect(await sshFingerprint(pubBlob(name))).toBe(expected);
    },
  );
});
