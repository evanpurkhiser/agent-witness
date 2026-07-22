// SSH public key fingerprints, matching `ssh-keygen -lf`.

import {b64encode, type Bytes} from 'app/utils/bytes';

const subtle = globalThis.crypto.subtle;

/**
 * Compute the OpenSSH SHA-256 fingerprint of a public key blob — the
 * `SHA256:<unpadded base64>` form OpenSSH displays.
 */
export async function sshFingerprint(publicBlob: Bytes): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', publicBlob));
  return `SHA256:${b64encode(digest).replace(/=+$/, '')}`;
}
