/* Discord role reconciliation — pure logic, no network.
 *
 * Identity comes from the server nickname: another bot already writes the
 * VATSIM name and CID into it, so the CID is read from there rather than
 * asking members to link an account.
 *
 * Role model (mirrors the Discord Permissions tab):
 *   WF Team Member / WF Affiliate   top-level, one per person
 *   <operator name>                 sub-role, plain grey, e.g. "Simfest UK"
 *   Team Lead / Affiliate Lead      only for the operator's lead
 */

export const ROLE_TEAM_MEMBER = 'WF Team Member';
export const ROLE_AFFILIATE = 'WF Affiliate';
export const ROLE_TEAM_LEAD = 'Team Lead';
export const ROLE_AFFILIATE_LEAD = 'Affiliate Lead';

// Every role this system owns and is therefore allowed to remove. Anything
// else a member holds is somebody else's business and is never touched.
export function managedRoleNames(rosterGroups) {
  const names = new Set([ROLE_TEAM_MEMBER, ROLE_AFFILIATE, ROLE_TEAM_LEAD, ROLE_AFFILIATE_LEAD]);
  for (const g of rosterGroups) if (g.label) names.add(g.label);
  return names;
}

/* CID out of a nickname. Deliberately loose about layout — "Fraser Cooper -
 * 1303570", "1303570 | Fraser Cooper" and "Fraser Cooper (1303570)" all work.
 * VATSIM CIDs are 6-9 digits; anything shorter is far more likely to be a year
 * or an aircraft type than an account, so it is ignored. Ambiguous nicknames
 * with two plausible CIDs return null rather than guessing wrong. */
export function parseCidFromNickname(nickname) {
  if (!nickname) return null;
  const matches = String(nickname).match(/\d{6,9}/g);
  if (!matches || matches.length !== 1) return null;
  const cid = Number(matches[0]);
  return Number.isFinite(cid) && cid > 0 ? cid : null;
}

/* The human part of a nickname, i.e. everything that isn't the CID or the
 * separator around it. "Michael Benson - 810399" -> "Michael Benson". Used to
 * fill in names for CIDs that have never logged into the portal. */
export function parseNameFromNickname(nickname) {
  if (!nickname) return '';
  return String(nickname)
    .replace(/\d{6,9}/g, ' ')          // drop the CID
    .replace(/[|\-–—/(),:]+/g, ' ')    // and the separators left behind
    .replace(/\s+/g, ' ')
    .trim();
}

/* What each CID in the roster should hold. */
export function desiredRolesByCid(rosterGroups) {
  const want = new Map();
  for (const g of rosterGroups) {
    for (const p of g.people) {
      const roles = want.get(p.cid) || new Set();
      roles.add(g.kind === 'team' ? ROLE_TEAM_MEMBER : ROLE_AFFILIATE);
      if (g.label) roles.add(g.label);
      if (p.lead) roles.add(g.kind === 'team' ? ROLE_TEAM_LEAD : ROLE_AFFILIATE_LEAD);
      want.set(p.cid, roles);
    }
  }
  return want;
}

/* Compare the roster against the guild.
 *
 * members: [{ id, nickname, roleNames: [] }]
 * Returns { changes, unmatched, missingFromGuild, missingRoles, stats }
 *
 * Only ever touches roles in managedRoleNames — a member's unrelated roles are
 * left exactly as they are. Members whose nickname yields no CID are reported
 * as `unmatched` and never modified, so a nickname change cannot silently
 * strip somebody's roles.
 */
export function computeRoleDiff({ rosterGroups, members, guildRoleNames, manualCidByDiscordId = null }) {
  const managed = managedRoleNames(rosterGroups);
  const want = desiredRolesByCid(rosterGroups);
  const guildRoles = new Set(guildRoleNames || []);

  // Roles the roster needs that don't exist in the server yet
  const missingRoles = [...managed].filter(r => !guildRoles.has(r)).sort();

  const changes = [];
  const unmatched = [];
  const seenCids = new Set();

  for (const m of members || []) {
    // A manual link wins over the nickname: it exists precisely because the
    // nickname could not be matched (or matched the wrong person).
    const cid = (manualCidByDiscordId && manualCidByDiscordId.get(m.id)) || parseCidFromNickname(m.nickname);
    if (!cid) {
      // Only worth reporting if they hold a role we manage — otherwise they
      // are simply a server member with nothing to do with WorldFlight.
      const held = (m.roleNames || []).filter(r => managed.has(r));
      if (held.length) unmatched.push({ id: m.id, nickname: m.nickname || '', heldManagedRoles: held });
      continue;
    }
    seenCids.add(cid);

    const has = new Set(m.roleNames || []);
    const should = want.get(cid) || new Set();

    const add = [...should].filter(r => !has.has(r)).sort();
    // Remove only roles we own; never anything outside the managed set
    const remove = [...has].filter(r => managed.has(r) && !should.has(r)).sort();

    if (add.length || remove.length) {
      changes.push({ id: m.id, cid, nickname: m.nickname || '', add, remove, inRoster: should.size > 0 });
    }
  }

  // People the portal knows about who aren't in the server at all
  const missingFromGuild = [...want.keys()].filter(cid => !seenCids.has(cid)).sort((a, b) => a - b);

  return {
    changes,
    unmatched,
    missingFromGuild,
    missingRoles,
    stats: {
      guildMembers: (members || []).length,
      rosterPeople: want.size,
      matched: seenCids.size,
      toChange: changes.length,
      toAdd: changes.reduce((n, c) => n + c.add.length, 0),
      toRemove: changes.reduce((n, c) => n + c.remove.length, 0)
    }
  };
}

/* The operator sub-roles, i.e. the managed roles that aren't the four
   top-level ones. */
export function subRoleNames(rosterGroups) {
  const top = new Set([ROLE_TEAM_MEMBER, ROLE_AFFILIATE, ROLE_TEAM_LEAD, ROLE_AFFILIATE_LEAD]);
  return [...managedRoleNames(rosterGroups)].filter(n => !top.has(n)).sort((a, b) => a.localeCompare(b));
}

/* Where the sub-roles should sit: alphabetically, directly above `anchorName`
 * (VATSIM Member) and below whatever currently sits above them. Everything
 * else keeps its relative order.
 *
 * roles: the guild's roles as returned by Discord ({ id, name, position }).
 * Returns [{ id, position }] for a bulk PATCH, or [] if nothing needs moving.
 */
export function planRoleOrder({ roles, rosterGroups, anchorName = 'VATSIM Member', botRoleId = null }) {
  const anchor = roles.find(r => r.name === anchorName);
  if (!anchor) return { positions: [], reason: `no anchor role "${anchorName}"` };

  const subs = new Set(subRoleNames(rosterGroups));
  const moving = roles.filter(r => subs.has(r.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!moving.length) return { positions: [], reason: 'no sub-roles' };

  const movingIds = new Set(moving.map(r => r.id));
  // Everything else, highest first, with @everyone excluded (it is pinned to 0)
  const rest = roles
    .filter(r => r.name !== '@everyone' && !movingIds.has(r.id))
    .sort((a, b) => b.position - a.position);

  // Rebuild top-to-bottom, dropping the block in immediately above the anchor
  const desired = [];
  for (const r of rest) {
    if (r.id === anchor.id) desired.push(...moving);
    desired.push(r);
  }

  // The bot can only move roles below its own, so refuse if that would break
  if (botRoleId) {
    const botIdx = desired.findIndex(r => r.id === botRoleId);
    const firstMovedIdx = desired.findIndex(r => movingIds.has(r.id));
    if (botIdx > firstMovedIdx) {
      return { positions: [], reason: 'bot role sits below the roles it would move' };
    }
  }

  /* Compare the *relative* order, not the position numbers. Discord's numbers
     are arbitrary and renumbering an already-correct hierarchy would PATCH on
     every single run for no reason. */
  const current = roles
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .map(r => r.id);
  const wanted = desired.map(r => r.id);
  if (current.length === wanted.length && current.every((id, i) => id === wanted[i])) {
    return { positions: [], changed: 0, reason: 'already in order' };
  }

  const positions = desired.map((r, i) => ({ id: r.id, position: desired.length - i }));
  const byId = Object.fromEntries(roles.map(r => [r.id, r]));
  const changed = positions.filter(p => byId[p.id] && byId[p.id].position !== p.position).length;
  return { positions, changed, reason: '' };
}

/* Removals are OFF until the portal roster is known to be complete. While
 * teams are still being filled in, a member who simply hasn't been added yet
 * looks identical to someone who left — and removing their roles would be
 * wrong. The diff still reports removals so they can be reviewed; this only
 * governs what is actually executed. */
export const removalsEnabled = () =>
  String(process.env.DISCORD_SYNC_REMOVALS || '').toLowerCase() === 'true';

/* The operations that will actually run, given the removal setting. Keeping
 * this separate from computeRoleDiff means the UI can always show the full
 * picture ("would remove X") while the applier stays additive-only. */
export function buildApplyPlan(diff, { allowRemovals = removalsEnabled() } = {}) {
  const ops = [];
  let suppressedRemovals = 0;
  for (const c of diff.changes) {
    const remove = allowRemovals ? c.remove : [];
    suppressedRemovals += allowRemovals ? 0 : c.remove.length;
    if (!c.add.length && !remove.length) continue;
    ops.push({ id: c.id, cid: c.cid, nickname: c.nickname, add: c.add, remove });
  }
  return {
    ops,
    allowRemovals,
    suppressedRemovals,
    totalAdds: ops.reduce((n, o) => n + o.add.length, 0),
    totalRemovals: ops.reduce((n, o) => n + o.remove.length, 0)
  };
}

/* Guard against acting on a broken read. If the bot can suddenly only match a
 * fraction of the members it matched before, that is far more likely to be a
 * bad fetch or a nickname-format change than 40 people genuinely leaving —
 * and with auto-apply on, blindly trusting it would strip real roles. */
export function isDiffSafeToApply(diff, { minMatchRatio = 0.5, maxRemovals = 25, allowRemovals = removalsEnabled() } = {}) {
  const { stats } = diff;
  const reasons = [];
  if (!stats.guildMembers) reasons.push('no guild members were read');
  if (stats.rosterPeople && stats.matched / stats.rosterPeople < minMatchRatio) {
    reasons.push(`only ${stats.matched}/${stats.rosterPeople} roster CIDs matched a nickname`);
  }
  // Irrelevant while additive-only: nothing is being removed to cap.
  if (allowRemovals && stats.toRemove > maxRemovals) {
    reasons.push(`${stats.toRemove} role removals exceeds the ${maxRemovals} safety cap`);
  }
  if (diff.missingRoles.length) {
    reasons.push(`server is missing role(s): ${diff.missingRoles.join(', ')}`);
  }
  return { safe: reasons.length === 0, reasons };
}
