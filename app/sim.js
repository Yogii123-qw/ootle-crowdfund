// Simulation of the CrowdfundCampaign template's state machine.
//
// This is a faithful, dependency-free mirror of `src/lib.rs`: same rules,
// same check order, same rejection messages. It runs entirely in the
// browser with no wallet, no network, and no funds. The engine tests in
// `tests/test.rs` prove the same rules against the real Ootle engine, and
// `sim.test.mjs` asserts this simulation behaves identically on the same
// scenarios.
//
// Deliberate differences from the on-chain template (nothing hidden):
//   * There are no buckets/resources here, so the template's "Pledges must
//     be paid in TARI" resource check has no simulation equivalent. It is
//     enforced on-chain by the template assert.
//   * Backer identities are demo persona ids ("rani", "bima", ...) instead
//     of Ristretto public keys.
//   * Amounts are BigInt smallest-units, exactly like the template Amount.
//
// Error messages are copied verbatim from the template asserts so that a
// rejection in the demo reads exactly like a rejection on-chain.

const MAX_TITLE_CHARS = 120;

export class CrowdfundSim {
  /**
   * @param {object} opts
   * @param {string} opts.creator - persona id of the campaign creator.
   * @param {string} opts.title - campaign title (1-120 chars).
   * @param {bigint} opts.goal - funding goal, smallest units, > 0.
   * @param {number} opts.deadlineEpoch - first settling epoch, > currentEpoch.
   * @param {number} opts.currentEpoch - epoch at creation time.
   */
  constructor({ creator, title, goal, deadlineEpoch, currentEpoch }) {
    if (typeof title !== "string" || title.length === 0) {
      throw new Error("Campaign title must not be empty");
    }
    if ([...title].length > MAX_TITLE_CHARS) {
      throw new Error("Campaign title is too long");
    }
    if (typeof goal !== "bigint" || goal <= 0n) {
      throw new Error("Funding goal must be greater than zero");
    }
    if (!Number.isInteger(deadlineEpoch) || deadlineEpoch <= currentEpoch) {
      throw new Error("Deadline epoch must be in the future");
    }
    this.creator = creator;
    this.title = title;
    this.goal = goal;
    this.deadlineEpoch = deadlineEpoch;
    this.vault = 0n;
    /** @type {Map<string, bigint>} backer id -> total pledged */
    this.pledges = new Map();
    this.claimed = false;
    this.fundedAnnounced = false;
    /** @type {Array<{topic: string, payload: Record<string, string>}>} */
    this.events = [
      {
        topic: "CrowdfundCampaign.CampaignCreated",
        payload: {
          creator,
          title,
          goal: goal.toString(),
          deadline_epoch: String(deadlineEpoch),
        },
      },
    ];
  }

  get totalPledged() {
    return this.vault;
  }

  get pledgeCount() {
    return this.pledges.size;
  }

  get isClaimed() {
    return this.claimed;
  }

  get isFunded() {
    return this.vault >= this.goal;
  }

  pledgeOf(backer) {
    return this.pledges.get(backer) ?? 0n;
  }

  /** Status label for the UI. Derived, never stored. */
  status(currentEpoch) {
    if (this.claimed) return "claimed";
    if (currentEpoch < this.deadlineEpoch) return this.isFunded ? "open-funded" : "open";
    return this.isFunded ? "settled-funded" : "settled-failed";
  }

  /**
   * Pledge into the vault. Mirrors `pledge` in the template.
   * @returns {Array} events emitted by this call.
   */
  pledge(backer, amount, currentEpoch) {
    if (typeof amount !== "bigint" || amount <= 0n) {
      throw new Error("Pledge must be greater than zero");
    }
    if (currentEpoch >= this.deadlineEpoch) {
      throw new Error("Campaign deadline has passed");
    }
    if (this.claimed) {
      throw new Error("Campaign funds have already been claimed");
    }
    const previous = this.pledges.get(backer) ?? 0n;
    this.pledges.set(backer, previous + amount);
    this.vault += amount;

    const emitted = [
      {
        topic: "CrowdfundCampaign.Pledged",
        payload: {
          backer,
          amount: amount.toString(),
          total_pledged: this.vault.toString(),
        },
      },
    ];
    if (!this.fundedAnnounced && this.vault >= this.goal) {
      this.fundedAnnounced = true;
      emitted.push({
        topic: "CrowdfundCampaign.Funded",
        payload: {
          goal: this.goal.toString(),
          total_pledged: this.vault.toString(),
        },
      });
    }
    this.events.push(...emitted);
    return emitted;
  }

  /**
   * Claim the whole vault for the creator. Mirrors `claim` in the template.
   * @returns {{amount: bigint, events: Array}}
   */
  claim(caller, currentEpoch) {
    if (caller !== this.creator) {
      throw new Error("Only the campaign creator can claim the funds");
    }
    if (this.claimed) {
      throw new Error("Campaign funds have already been claimed");
    }
    if (currentEpoch < this.deadlineEpoch) {
      throw new Error("Campaign deadline has not been reached");
    }
    if (this.vault < this.goal) {
      throw new Error("Funding goal was not met; backers may refund instead");
    }
    this.claimed = true;
    const amount = this.vault;
    this.vault = 0n;
    const emitted = [
      {
        topic: "CrowdfundCampaign.Claimed",
        payload: { creator: this.creator, amount: amount.toString() },
      },
    ];
    this.events.push(...emitted);
    return { amount, events: emitted };
  }

  /**
   * Refund the caller's full pledge. Mirrors `refund` in the template.
   * @returns {{amount: bigint, events: Array}}
   */
  refund(caller, currentEpoch) {
    if (currentEpoch < this.deadlineEpoch) {
      throw new Error("Refunds open after the campaign deadline");
    }
    if (this.claimed) {
      throw new Error("Campaign funds were claimed; refunds are closed");
    }
    if (this.vault >= this.goal) {
      throw new Error("Campaign reached its goal; refunds are closed");
    }
    const pledged = this.pledges.get(caller) ?? 0n;
    if (pledged <= 0n) {
      throw new Error("No pledge to refund for this backer");
    }
    // Remove the ledger entry first: a second refund finds nothing.
    this.pledges.delete(caller);
    this.vault -= pledged;
    const emitted = [
      {
        topic: "CrowdfundCampaign.Refunded",
        payload: { backer: caller, amount: pledged.toString() },
      },
    ];
    this.events.push(...emitted);
    return { amount: pledged, events: emitted };
  }
}

/**
 * Parse a user-typed amount into BigInt smallest-units.
 * Accepts only non-negative integer strings (whitespace tolerated).
 * @throws {Error} with a UI-facing message (not a template message).
 */
export function parseAmount(text) {
  const cleaned = String(text ?? "").trim().replace(/_/g, "");
  if (!/^\d+$/.test(cleaned)) {
    throw new Error("Enter a whole number of TARI units (no decimals, no symbols).");
  }
  return BigInt(cleaned);
}

/** Format a BigInt amount with thousands separators. */
export function formatAmount(amount) {
  return amount.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
