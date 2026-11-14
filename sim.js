// Simulation of the CrowdfundCampaign template's state machine (v2).
//
// This is a faithful, dependency-free mirror of `src/lib.rs` as specified
// in `docs/MECHANISM-V2.md`: same method names, same check order, same
// rejection messages verbatim, same formulas (BigInt floor division), same
// event topics and payload shapes (with persona ids instead of public
// keys). It runs entirely in the browser with no wallet, no network, and
// no funds. The engine tests in `tests/test.rs` prove the same rules
// against the real Ootle engine, and `sim.test.mjs` asserts this
// simulation behaves identically on the same scenarios, including every
// edge case in spec section 9 that is expressible in the simulation.
//
// Deliberate differences from the on-chain template (nothing hidden):
//   * There are no buckets/resources here, so two template resource
//     checks have no simulation equivalent: "Pledges must be paid in TARI"
//     and "Bond must be paid in TARI". Both are enforced on-chain by the
//     template asserts.
//   * Backer identities are demo persona ids ("rani", "bima", ...) instead
//     of Ristretto public keys.
//   * Amounts are BigInt smallest-units, exactly like the template Amount.
//
// Error messages are copied verbatim from the template asserts so that a
// rejection in the demo reads exactly like a rejection on-chain.

const MAX_TITLE_CHARS = 120;
const MAX_PROMISE_CHARS = 280;
const TRANCHE_COUNT = 3;
const VETO_WINDOW_EPOCHS = 72;

export class CrowdfundSim {
  /**
   * @param {object} opts
   * @param {string} opts.creator - persona id of the campaign creator.
   * @param {string} opts.title - campaign title (1-120 chars).
   * @param {string} opts.promise - creator's promise text (1-280 chars).
   * @param {bigint} opts.goal - funding goal, smallest units, > 0.
   * @param {number} opts.deadlineEpoch - first settling epoch, > currentEpoch.
   * @param {number} opts.currentEpoch - epoch at creation time.
   * @param {bigint} opts.bond - deposited bond, >= max(goal/10, 100).
   */
  constructor({ creator, title, promise, goal, deadlineEpoch, currentEpoch, bond }) {
    // Check order mirrors spec section 4.1 exactly (the TARI resource
    // check on the bond has no simulation equivalent; see header).
    if (typeof title !== "string" || title.length === 0) {
      throw new Error("Campaign title must not be empty");
    }
    if ([...title].length > MAX_TITLE_CHARS) {
      throw new Error("Campaign title is too long");
    }
    if (typeof promise !== "string" || promise.length === 0) {
      throw new Error("Campaign promise must not be empty");
    }
    if ([...promise].length > MAX_PROMISE_CHARS) {
      throw new Error("Campaign promise is too long");
    }
    if (typeof goal !== "bigint" || goal <= 0n) {
      throw new Error("Funding goal must be greater than zero");
    }
    if (!Number.isInteger(deadlineEpoch) || deadlineEpoch <= currentEpoch) {
      throw new Error("Deadline epoch must be in the future");
    }
    const tenth = goal / 10n;
    const requiredBond = tenth > 100n ? tenth : 100n;
    if (typeof bond !== "bigint" || bond < requiredBond) {
      throw new Error("Creator bond is below the required minimum");
    }
    this.creator = creator;
    this.title = title;
    this.promise = promise;
    this.goal = goal;
    this.deadlineEpoch = deadlineEpoch;
    /** Pledge vault balance. Drops as tranches release and refunds pay out. */
    this.vault = 0n;
    /** Bond vault balance. Holds ONLY the creator's bond. */
    this.bondVault = bond;
    /** The deposited bond (>= required bond; overpayment becomes the bond). */
    this.bondAmount = bond;
    this.bondClaimed = false;
    /** Accumulator: total ever pledged. NEVER decreases. */
    this.pledgedTotal = 0n;
    /** Total released to the creator across tranches (bookkeeping). */
    this.releasedTotal = 0n;
    /** @type {Map<string, bigint>} backer id -> total pledged */
    this.pledges = new Map();
    /** @type {Map<string, bigint>} vetoer id -> pledge weight, current window */
    this.vetoers = new Map();
    this.vetoTotal = 0n;
    this.tranchesReleased = 0;
    this.vetoed = false;
    this.abandoned = false;
    /** Snapshot of the vault balance at veto/abandonment success. */
    this.refundPool = 0n;
    this.fundedAnnounced = false;
    /** @type {Array<{topic: string, payload: Record<string, string>}>} */
    this.events = [
      {
        topic: "CrowdfundCampaign.CampaignCreated",
        payload: {
          creator,
          title,
          promise,
          goal: goal.toString(),
          deadline_epoch: String(deadlineEpoch),
          bond: bond.toString(),
        },
      },
    ];
  }

  /** Total EVER pledged (accumulator; stable across releases and refunds). */
  get totalPledged() {
    return this.pledgedTotal;
  }

  /** Current pledge-vault balance. */
  get vaultBalance() {
    return this.vault;
  }

  /** Required bond: max(goal/10, 100), floor division. */
  get requiredBond() {
    const tenth = this.goal / 10n;
    return tenth > 100n ? tenth : 100n;
  }

  /** Current bond-vault balance. */
  get bondBalance() {
    return this.bondVault;
  }

  /** Epoch at which the next tranche becomes claimable. */
  get nextTrancheEpoch() {
    return this.deadlineEpoch + this.tranchesReleased * VETO_WINDOW_EPOCHS;
  }

  get isVetoed() {
    return this.vetoed;
  }

  get isAbandoned() {
    return this.abandoned;
  }

  get pledgeCount() {
    return this.pledges.size;
  }

  /** Fully claimed: all tranches released. */
  get isClaimed() {
    return this.tranchesReleased === TRANCHE_COUNT;
  }

  get isFunded() {
    return this.pledgedTotal >= this.goal;
  }

  pledgeOf(backer) {
    return this.pledges.get(backer) ?? 0n;
  }

  /** Caller's recorded veto weight this window, else 0. */
  myVeto(caller) {
    return this.vetoers.get(caller) ?? 0n;
  }

  /** Status label for the UI. Derived, never stored. */
  status(currentEpoch) {
    if (this.vetoed) return "vetoed";
    if (this.abandoned) return "abandoned";
    if (this.isClaimed) return "completed";
    if (currentEpoch < this.deadlineEpoch) return this.isFunded ? "open-funded" : "open";
    return this.isFunded ? "settled-funded" : "settled-failed";
  }

  /**
   * Pledge into the vault. Mirrors `pledge` in the template (spec 4.2).
   * @returns {Array} events emitted by this call.
   */
  pledge(backer, amount, currentEpoch) {
    // The TARI resource check has no simulation equivalent; see header.
    if (typeof amount !== "bigint" || amount <= 0n) {
      throw new Error("Pledge must be greater than zero");
    }
    if (currentEpoch >= this.deadlineEpoch) {
      throw new Error("Campaign deadline has passed");
    }
    if (this.tranchesReleased !== 0) {
      throw new Error("Campaign funds have already been released");
    }
    if (this.vetoed) {
      throw new Error("Campaign was vetoed; pledges are closed");
    }
    if (this.abandoned) {
      throw new Error("Campaign was abandoned; pledges are closed");
    }
    const previous = this.pledges.get(backer) ?? 0n;
    this.pledges.set(backer, previous + amount);
    this.vault += amount;
    this.pledgedTotal += amount;

    const emitted = [
      {
        topic: "CrowdfundCampaign.Pledged",
        payload: {
          backer,
          amount: amount.toString(),
          total_pledged: this.pledgedTotal.toString(),
        },
      },
    ];
    if (!this.fundedAnnounced && this.vault >= this.goal) {
      this.fundedAnnounced = true;
      emitted.push({
        topic: "CrowdfundCampaign.Funded",
        payload: {
          goal: this.goal.toString(),
          total_pledged: this.pledgedTotal.toString(),
        },
      });
    }
    this.events.push(...emitted);
    return emitted;
  }

  /**
   * Release the next tranche to the creator. Mirrors `claim` in the
   * template (spec 4.3). One tranche per call.
   * @returns {{amount: bigint, events: Array}}
   */
  claim(caller, currentEpoch) {
    if (caller !== this.creator) {
      throw new Error("Only the campaign creator can claim the funds");
    }
    if (this.vetoed) {
      throw new Error("Campaign was vetoed; remaining funds are refundable to backers");
    }
    if (this.abandoned) {
      throw new Error("Campaign was abandoned; remaining funds are refundable to backers");
    }
    if (this.tranchesReleased >= TRANCHE_COUNT) {
      throw new Error("Campaign funds have already been claimed");
    }
    if (currentEpoch < this.deadlineEpoch) {
      throw new Error("Campaign deadline has not been reached");
    }
    if (this.pledgedTotal < this.goal) {
      throw new Error("Funding goal was not met; backers may refund instead");
    }
    if (currentEpoch < this.nextTrancheEpoch) {
      throw new Error("The next release has not opened yet");
    }
    // Tranche amount: floor thirds, remainder to tranche 3.
    const base = this.pledgedTotal / 3n;
    const trancheNo = this.tranchesReleased + 1;
    const amount = trancheNo < TRANCHE_COUNT ? base : this.pledgedTotal - 2n * base;
    this.tranchesReleased += 1;
    // A release is a fresh decision point: clear the veto tally.
    this.vetoers.clear();
    this.vetoTotal = 0n;
    this.vault -= amount;
    this.releasedTotal += amount;
    const emitted = [
      {
        topic: "CrowdfundCampaign.TrancheReleased",
        payload: { tranche: String(trancheNo), amount: amount.toString() },
      },
    ];
    if (this.tranchesReleased === TRANCHE_COUNT) {
      emitted.push({
        topic: "CrowdfundCampaign.CampaignCompleted",
        payload: { total_released: this.releasedTotal.toString() },
      });
    }
    this.events.push(...emitted);
    return { amount, events: emitted };
  }

  /**
   * Veto the pending release. Mirrors `veto` in the template (spec 4.4).
   * Any backer with a pledge may veto; the threshold is evaluated eagerly.
   * @returns {Array} events emitted by this call.
   */
  veto(caller, currentEpoch) {
    if (currentEpoch < this.deadlineEpoch) {
      throw new Error("Veto opens after the campaign deadline");
    }
    if (this.vetoed) {
      throw new Error("Campaign was already vetoed");
    }
    if (this.abandoned) {
      throw new Error("Campaign was abandoned; veto is closed");
    }
    if (this.tranchesReleased >= TRANCHE_COUNT) {
      throw new Error("Campaign is complete; veto is closed");
    }
    if (this.pledgedTotal < this.goal) {
      throw new Error("Campaign did not reach its goal; refunds are already open");
    }
    const weight = this.pledges.get(caller) ?? 0n;
    if (weight <= 0n) {
      throw new Error("No pledge to veto with for this backer");
    }
    if (this.vetoers.has(caller)) {
      throw new Error("Backer has already vetoed this release");
    }
    this.vetoers.set(caller, weight);
    this.vetoTotal += weight;
    const emitted = [
      {
        topic: "CrowdfundCampaign.VetoCast",
        payload: {
          backer: caller,
          weight: weight.toString(),
          veto_total: this.vetoTotal.toString(),
        },
      },
    ];
    // Eager strict-majority evaluation, overflow-free, no multiplication.
    if (this.vetoTotal > this.pledgedTotal - this.vetoTotal) {
      this.vetoed = true;
      this.refundPool = this.vault;
      emitted.push(
        {
          topic: "CrowdfundCampaign.VetoSucceeded",
          payload: {
            veto_total: this.vetoTotal.toString(),
            pledged_total: this.pledgedTotal.toString(),
          },
        },
        {
          topic: "CrowdfundCampaign.BondForfeited",
          payload: { amount: this.bondAmount.toString() },
        },
      );
    }
    this.events.push(...emitted);
    return emitted;
  }

  /**
   * Declare the campaign abandoned. Mirrors `abandon` in the template
   * (spec 4.5). Callable by anyone: the trigger is fully objective
   * (epoch-based), so the caller identity is irrelevant. Accepts either
   * `abandon(currentEpoch)` or `abandon(caller, currentEpoch)`.
   * @returns {Array} events emitted by this call.
   */
  abandon(callerOrEpoch, maybeEpoch) {
    const currentEpoch = maybeEpoch === undefined ? callerOrEpoch : maybeEpoch;
    if (this.vetoed) {
      throw new Error("Campaign was already vetoed");
    }
    if (this.abandoned) {
      throw new Error("Campaign was already abandoned");
    }
    if (this.tranchesReleased >= TRANCHE_COUNT) {
      throw new Error("Campaign is complete; abandonment is closed");
    }
    if (this.pledgedTotal < this.goal) {
      throw new Error("Campaign did not reach its goal; refunds are already open");
    }
    if (currentEpoch < this.nextTrancheEpoch + VETO_WINDOW_EPOCHS) {
      throw new Error("Creator has not abandoned the campaign yet");
    }
    this.abandoned = true;
    this.refundPool = this.vault;
    const emitted = [
      {
        topic: "CrowdfundCampaign.Abandoned",
        payload: {
          unreleased: this.refundPool.toString(),
          bond_forfeited: this.bondAmount.toString(),
        },
      },
      {
        topic: "CrowdfundCampaign.BondForfeited",
        payload: { amount: this.bondAmount.toString() },
      },
    ];
    this.events.push(...emitted);
    return emitted;
  }

  /**
   * Refund the caller. Mirrors `refund` in the template (spec 4.6): full
   * pledge on failure; pro-rata vault + bond shares after a veto or
   * abandonment, with the last refunder taking all rounding dust.
   * @returns {{amount: bigint, events: Array}}
   */
  refund(caller, currentEpoch) {
    if (currentEpoch < this.deadlineEpoch) {
      throw new Error("Refunds open after the campaign deadline");
    }
    if (this.tranchesReleased >= TRANCHE_COUNT) {
      throw new Error("Campaign funds were claimed; refunds are closed");
    }
    if (this.vetoed || this.abandoned) {
      const pledged = this.pledges.get(caller) ?? 0n;
      if (pledged <= 0n) {
        throw new Error("No pledge to refund for this backer");
      }
      const isLast = this.pledges.size === 1;
      // Remove the ledger entry first: a second refund finds nothing.
      this.pledges.delete(caller);
      let vaultShare;
      let bondShare;
      if (isLast) {
        // The last refunder receives the ENTIRE remaining balance of both
        // vaults — computed shares plus all rounding dust.
        vaultShare = this.vault;
        bondShare = this.bondVault;
      } else {
        vaultShare = (pledged * this.refundPool) / this.pledgedTotal;
        bondShare = (pledged * this.bondAmount) / this.pledgedTotal;
      }
      this.vault -= vaultShare;
      this.bondVault -= bondShare;
      const amount = vaultShare + bondShare;
      const emitted = [
        {
          topic: "CrowdfundCampaign.Refunded",
          payload: {
            backer: caller,
            amount: amount.toString(),
            bond_share: bondShare.toString(),
          },
        },
      ];
      this.events.push(...emitted);
      return { amount, events: emitted };
    }
    if (this.pledgedTotal >= this.goal) {
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
        payload: { backer: caller, amount: pledged.toString(), bond_share: "0" },
      },
    ];
    this.events.push(...emitted);
    return { amount: pledged, events: emitted };
  }

  /**
   * Return the bond to the creator. Mirrors `claim_bond` in the template
   * (spec 4.7).
   * @returns {{amount: bigint, events: Array}}
   */
  claimBond(caller, currentEpoch) {
    if (caller !== this.creator) {
      throw new Error("Only the campaign creator can claim the bond");
    }
    if (this.bondClaimed) {
      throw new Error("Bond has already been claimed");
    }
    if (this.vetoed) {
      throw new Error("Bond was forfeited to backers");
    }
    if (this.abandoned) {
      throw new Error("Bond was forfeited to backers");
    }
    if (currentEpoch < this.deadlineEpoch) {
      throw new Error("Bond is locked until the campaign deadline");
    }
    if (!(this.pledgedTotal < this.goal || this.tranchesReleased === TRANCHE_COUNT)) {
      throw new Error("Bond is locked until all releases complete");
    }
    // Set the one-time flag BEFORE the transfer.
    this.bondClaimed = true;
    const amount = this.bondVault;
    this.bondVault = 0n;
    const emitted = [
      {
        topic: "CrowdfundCampaign.BondReturned",
        payload: { creator: this.creator, amount: amount.toString() },
      },
    ];
    this.events.push(...emitted);
    return { amount, events: emitted };
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
