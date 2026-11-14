// Test-only fixture template: mints a throwaway fungible token.
//
// This crate is NOT part of the contest entry. It exists so the engine tests
// can pay `CrowdfundCampaign::pledge` with a bucket whose resource is not
// TARI, proving the template rejects non-TARI payments against the real
// engine. It is compiled only by `cargo test` (via
// `TemplateTest::new` with two template paths) and is never published.
//
// SPDX-License-Identifier: MIT

use tari_template_lib::prelude::*;

#[template]
mod test_token {
    use super::*;

    /// No state: this template only exposes the `mint` function.
    pub struct TestTokenMinter;

    impl TestTokenMinter {
        /// Creates a fresh public fungible "TEST" resource and returns the
        /// whole initial supply as a bucket. Each call mints a NEW resource,
        /// so the returned bucket's resource address is never TARI_TOKEN.
        pub fn mint(amount: Amount) -> Bucket {
            ResourceBuilder::public_fungible()
                .with_token_symbol("TEST")
                .initial_supply(amount)
        }
    }
}
