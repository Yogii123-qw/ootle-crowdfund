// Live-mode stub — UNVERIFIED, intentionally minimal.
//
// This module ONLY detects whether a Tari browser wallet provider is
// present. It never prompts the user, never requests accounts, never signs,
// and never submits a transaction. Live mode cannot work yet because no
// template has been published: there is no template/component address to
// call, and inventing one would be faking a live path.
//
// What turning this into a real live path would require (future work, needs
// a published template + a wallet to test against):
//   1. Publish the template to Esmeralda/mainnet and record its address.
//   2. Include the connector script from the wallet integration reference
//      and feature-detect via `tari_getCapabilities` (never wallet-detect).
//   3. `tari_requestAccounts` -> build instructions calling the published
//      template -> `tari_signAndSubmitTransaction` (with `dryRun: true`
//      first for fee quotes) -> read results via `tari_getTransactionResult`.
//   4. Read campaign state through the public indexer (read-only fetch).
// Until all of that exists AND is tested against a real wallet, the demo
// stays in simulation mode and says so.

/** @returns {string} honest one-line status for the Live section. */
export function liveStatus() {
  const provider =
    typeof window !== "undefined" ? window.tari : undefined;
  if (!provider) {
    return (
      "No Tari wallet detected in this browser (no window.tari provider). " +
      "Live mode is not configured: no template has been published, so there is nothing to call. " +
      "The simulation above is the complete demo."
    );
  }
  return (
    "A window.tari provider was detected, but live mode is still disabled: " +
    "no template address has been published or configured, so no transaction can be built. " +
    "The simulation above is the complete demo. This stub made no wallet requests."
  );
}
