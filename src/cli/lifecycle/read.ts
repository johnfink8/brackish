// Shared support for the read verbs. `fetchTaggedShow` is the common show flow — fetch the accepted
// and proposed versions (either may be absent), compute the delta, render tagged — done once here
// so each noun's `show` capability is a two-line "here's how to fetch my accepted/proposed".

import { compactSummary, generatePatch } from '../../lib/diff.js';
import { renderTaggedShow } from '../../render/output.js';
import { getOrNull } from '../common.js';
import type { ShowArtifact, ShowResult } from './types.js';

export async function fetchTaggedShow<V extends ShowArtifact>(
  label: string,
  getAccepted: () => Promise<V>,
  getProposed: () => Promise<V>,
): Promise<ShowResult | null> {
  const [accepted, proposed] = await Promise.all([getOrNull(getAccepted), getOrNull(getProposed)]);
  if (!accepted && !proposed) return null;
  const deltaVsAccepted =
    accepted && proposed ? compactSummary(generatePatch(accepted.spec, proposed.spec)) : null;
  const rendered = renderTaggedShow({ label, accepted, proposed, deltaVsAccepted });
  return {
    json: { accepted, proposed, deltaVsAccepted },
    meta: rendered.meta,
    body: rendered.body,
  };
}
