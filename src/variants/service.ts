import type { Config, Platform } from '../config.js';
import { transaction, type Db } from '../db/index.js';
import { conflict, unprocessable } from '../http/errors.js';
import type { JobRepository } from '../jobs/repository.js';
import type { Post } from '../posts/repository.js';
import { assertValidVariant, validateVariant, type Violation } from '../platforms/validate.js';
import { profileFor } from '../platforms/profiles.js';
import { generateVariant, type ShapingNote } from './generator.js';
import type { Variant, VariantRepository, VariantStatus } from './repository.js';
import { canTransition, EDITABLE_STATUSES, explainRefusal } from './workflow.js';

export interface GenerateResult {
  created: Variant[];
  /** Platforms left alone because a human had already approved or published them. */
  skipped: { platform: Platform; reason: string; variantId: number }[];
  /** Drafts replaced by this call, reported so the response is not silently lossy. */
  replaced: number[];
}

export class VariantService {
  constructor(
    private readonly db: Db,
    private readonly variants: VariantRepository,
    private readonly jobs: JobRepository,
    private readonly config: Config,
  ) {}

  /**
   * One variant per configured platform, generated from the stored post only.
   *
   * All or nothing: every generated text is validated before anything is written,
   * so a post can never end up with half a campaign. If a template produces
   * rule-breaking text the whole call fails and names the platform and the rule.
   */
  generate(post: Post): GenerateResult {
    const skipped: GenerateResult['skipped'] = [];
    const replaced: number[] = [];
    const pending: { platform: Platform; text: string; notes: ShapingNote[] }[] = [];
    const failures: { platform: Platform; violations: Violation[] }[] = [];

    for (const platform of this.config.platforms) {
      const decided = this.variants.findDecidedByPostAndPlatform(post.id, platform);
      if (decided) {
        skipped.push({
          platform,
          variantId: decided.id,
          reason: `kept the existing ${decided.status} variant, which a human decided on`,
        });
        continue;
      }
      // Every stale draft for this platform goes, so regenerating cannot leave
      // two variants for the same platform behind.
      replaced.push(...this.variants.listReplaceable(post.id, platform).map((v) => v.id));

      const { text, notes } = generateVariant(post, platform);
      const violations = validateVariant(platform, text);
      if (violations.length > 0) {
        failures.push({ platform, violations });
      } else {
        pending.push({ platform, text, notes });
      }
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `${f.platform} (${f.violations.map((v) => v.rule).join(', ')})`)
        .join('; ');
      throw unprocessable(
        'constraint_violation',
        `Generated text breaks a platform profile, so nothing was stored: ${summary}. ` +
          `The stored post is probably too short or too long for that platform.`,
        { platform: failures[0]?.platform, violations: failures.flatMap((f) => f.violations) },
      );
    }

    // One transaction: the delete of a superseded draft and the insert of its
    // replacement either both happen or neither does.
    const created = transaction(this.db, () => {
      for (const id of replaced) this.variants.deleteById(id);
      return pending.map(({ platform, text, notes }) =>
        this.variants.insert(post.id, platform, text, notes),
      );
    });

    return { created, skipped, replaced };
  }

  /** A hand-written variant. Validated by exactly the same gate as a generated one. */
  createManual(post: Post, platform: Platform, text: string): Variant {
    assertValidVariant(platform, text);
    return this.variants.insert(post.id, platform, text);
  }

  /**
   * Approve or reject. The transition table decides what is legal, and the update is
   * a compare-and-set, so two concurrent reviewers cannot both win.
   */
  setStatus(variant: Variant, to: VariantStatus): Variant {
    if (!canTransition(variant.status, to)) {
      throw conflict('invalid_transition', explainRefusal(variant.status, to), {
        variantId: variant.id,
        from: variant.status,
        to,
      });
    }

    if (!this.variants.updateStatus(variant.id, variant.status, to)) {
      // The guard matched nothing, so the row changed between read and write.
      throw conflict(
        'concurrent_update',
        `Variant ${variant.id} was changed by someone else while this request ran. Read it again and retry.`,
        { variantId: variant.id, expected: variant.status },
      );
    }

    return this.reload(variant.id);
  }

  /**
   * Edits the text of a variant. Re-validates against the platform profile, and sends
   * the variant back to `draft`: an approval applied to different words is meaningless.
   */
  edit(variant: Variant, text: string): Variant {
    if (!EDITABLE_STATUSES.includes(variant.status)) {
      throw conflict(
        'not_editable',
        `Variant ${variant.id} is ${variant.status} and cannot be edited, because the message is already live`,
        { variantId: variant.id, status: variant.status },
      );
    }

    assertValidVariant(variant.platform, text);

    // Any job still waiting to publish the old text is cancelled. Letting it run
    // would publish words that are no longer approved, and were possibly the exact
    // words the editor was removing.
    const cancelled = this.jobs.cancelPendingForVariant(variant.id);
    if (cancelled > 0) {
      console.log(`[review] cancelled ${cancelled} pending job(s) for edited variant ${variant.id}`);
    }

    if (!this.variants.updateText(variant.id, text)) {
      throw conflict(
        'concurrent_update',
        `Variant ${variant.id} was changed by someone else while this request ran. Read it again and retry.`,
        { variantId: variant.id, expected: variant.status },
      );
    }

    return this.reload(variant.id);
  }

  private reload(id: number): Variant {
    const fresh = this.variants.findById(id);
    if (!fresh) throw new Error(`Variant ${id} vanished after a successful update`);
    return fresh;
  }

  /** Reports how much of each profile a variant uses, for the review UI and evidence. */
  describe(variant: Variant): Variant & { length: number; limit: number; platformLabel: string } {
    const profile = profileFor(variant.platform);
    return {
      ...variant,
      length: [...variant.text].length,
      limit: profile.maxLength,
      platformLabel: profile.label,
    };
  }
}
