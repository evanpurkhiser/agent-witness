// Page-side WebAuthn + PRF. The passkey never leaves the authenticator; we only
// use its PRF output as vault key material. Browser-only (needs a secure
// context); not unit-tested.

import {getAuthenticatorName} from 'passkey-authenticator-aaguids';

import {b64urlencode, type Bytes, random} from 'app/utils/bytes';
import type {CreateVaultParams} from 'app/vault/vault';

const RP_NAME = 'agent-witness';

/**
 * Derive a human label for the passkey from its authenticator's AAGUID (e.g.
 * "1Password", "iCloud Keychain"), falling back when it's unknown or zeroed.
 */
function passkeyLabel(credential: PublicKeyCredential): string {
  const {response} = credential;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    return 'Passkey';
  }
  const authenticatorData = b64urlencode(new Uint8Array(response.getAuthenticatorData()));
  return getAuthenticatorName({authenticatorData}) ?? 'Passkey';
}

/**
 * Run a WebAuthn assertion for a credential and return its PRF output. iOS does
 * not always return PRF results at creation time, so unlock (and enrollment as a
 * fallback) go through an assertion here.
 */
async function evaluatePrf(credentialId: Bytes, salt: Bytes): Promise<Bytes> {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{type: 'public-key', id: credentialId}],
      userVerification: 'required',
      extensions: {prf: {eval: {first: salt}}},
    },
  });

  if (!(assertion instanceof PublicKeyCredential)) {
    throw new Error('passkey assertion failed');
  }

  const prf = assertion.getClientExtensionResults().prf?.results?.first;
  if (!prf) {
    throw new Error('this passkey did not return a PRF result');
  }
  return new Uint8Array(prf as ArrayBuffer);
}

/**
 * Register a new passkey and derive its PRF output, returning the material
 * needed to create the vault.
 */
export async function registerPasskey(): Promise<CreateVaultParams> {
  const salt = random(32);
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: {name: RP_NAME},
      user: {id: random(16), name: RP_NAME, displayName: RP_NAME},
      challenge: random(32),
      pubKeyCredParams: [
        {type: 'public-key', alg: -8}, // Ed25519
        {type: 'public-key', alg: -7}, // ES256
        {type: 'public-key', alg: -257}, // RS256
      ],
      authenticatorSelection: {residentKey: 'required', userVerification: 'required'},
      extensions: {prf: {eval: {first: salt}}},
    },
  });

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('passkey creation failed');
  }

  const credentialId = new Uint8Array(credential.rawId);
  const label = passkeyLabel(credential);

  // Many platforms (recent Safari/iOS included) return the PRF result straight
  // from creation; only fall back to a second assertion when they do not.
  const atCreation = credential.getClientExtensionResults().prf?.results?.first;
  const prfOutput = atCreation
    ? new Uint8Array(atCreation as ArrayBuffer)
    : await evaluatePrf(credentialId, salt);

  return {prfOutput, credentialId, salt, label};
}

/**
 * Re-derive a passkey's PRF output to unlock an existing vault.
 */
export function authenticatePasskey(credentialId: Bytes, salt: Bytes): Promise<Bytes> {
  return evaluatePrf(credentialId, salt);
}
