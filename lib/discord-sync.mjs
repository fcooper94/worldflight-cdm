/* Hourly reconcile of Discord roles against the portal roster.
 *
 * Additive-only until DISCORD_SYNC_REMOVALS=true — see discord-roles.mjs. The
 * roster is still being filled in, so a member who simply hasn't been added
 * yet is indistinguishable from someone who left.
 */
import {
  computeRoleDiff, buildApplyPlan, isDiffSafeToApply, removalsEnabled,
  managedRoleNames, planRoleOrder, parseCidFromNickname, parseNameFromNickname
} from './discord-roles.mjs';
import {
  discordConfigured, getGuildSnapshot, invalidateGuildCache,
  addRoleToMember, removeRoleFromMember, createRole, setRolePositions
} from './discord-api.mjs';

// A runaway roster shouldn't be able to spam the server with roles.
const MAX_ROLES_PER_RUN = 25;

/* Last run, for the admin UI. Kept in memory: it is a status readout, not a
   record, and a restart simply shows "never" until the next run. */
export const discordSyncState = {
  lastRunAt: null,
  lastOkAt: null,
  running: false,
  result: null,          // 'ok' | 'blocked' | 'error' | 'skipped'
  message: '',
  added: 0,
  removed: 0,
  failed: 0,
  rolesCreated: 0,
  reordered: false,
  namesStored: 0
};

export function discordSyncStatusText() {
  if (!discordConfigured()) return 'Discord sync is not configured';
  if (discordSyncState.running) return 'Syncing now…';
  if (!discordSyncState.lastRunAt) return 'Not synced yet';
  const t = new Date(discordSyncState.lastRunAt).toISOString().slice(11, 16) + 'z';
  if (discordSyncState.result === 'ok') {
    const bits = [];
    if (discordSyncState.rolesCreated) bits.push(`${discordSyncState.rolesCreated} role(s) created`);
    if (discordSyncState.added) bits.push(`${discordSyncState.added} added`);
    if (discordSyncState.removed) bits.push(`${discordSyncState.removed} removed`);
    return bits.length
      ? `Last synced ${t} — ${bits.join(', ')}`
      : `Last synced ${t} — already up to date`;
  }
  return `Last sync ${t} — ${discordSyncState.message || discordSyncState.result}`;
}

/* buildRoster must return the same shape the admin page uses:
   [{ kind: 'team'|'affiliate', label, people: [{ cid, lead }] }]           */
export async function runDiscordRoleSync({ buildRoster, loadManualLinks = null, persistNames = null, reason = 'scheduled' } = {}) {
  if (!discordConfigured()) {
    discordSyncState.result = 'skipped';
    discordSyncState.message = 'not configured';
    return discordSyncState;
  }
  if (discordSyncState.running) return discordSyncState;

  discordSyncState.running = true;
  discordSyncState.lastRunAt = new Date();
  discordSyncState.added = discordSyncState.removed = discordSyncState.failed = 0;
  discordSyncState.rolesCreated = 0;
  discordSyncState.reordered = false;
  discordSyncState.namesStored = 0;

  try {
    const rosterGroups = await buildRoster();
    invalidateGuildCache();
    let snap = await getGuildSnapshot({ force: true });

    /* Create any role the roster needs but the server lacks — a new team or
       affiliate would otherwise block the whole run on the missing-role
       safety check. Creating is additive, so it is safe to do unattended. */
    const have = new Set(snap.roleNames);
    const missing = [...managedRoleNames(rosterGroups)].filter(n => !have.has(n)).sort();
    if (missing.length) {
      const toMake = missing.slice(0, MAX_ROLES_PER_RUN);
      if (missing.length > toMake.length) {
        console.warn(`[DISCORD] ${missing.length} roles missing; creating ${toMake.length} this run (cap ${MAX_ROLES_PER_RUN})`);
      }
      for (const name of toMake) {
        try {
          await createRole(name);
          discordSyncState.rolesCreated++;
          console.log(`[DISCORD] created role "${name}"`);
        } catch (e) {
          discordSyncState.failed++;
          console.warn(`[DISCORD] could not create role "${name}": ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 400));
      }
      invalidateGuildCache();
      snap = await getGuildSnapshot({ force: true });
    }

    /* Keep the sub-roles sitting together, alphabetically, just above the
       anchor role — newly created ones land at the bottom otherwise. */
    try {
      const botRole = snap.roles.find(r => r.tags && r.tags.bot_id);
      const order = planRoleOrder({
        roles: snap.roles,
        rosterGroups,
        anchorName: process.env.DISCORD_ROLE_ANCHOR || 'VATSIM Member',
        botRoleId: botRole ? botRole.id : null
      });
      if (order.positions.length) {
        await setRolePositions(order.positions);
        discordSyncState.reordered = true;
        console.log(`[DISCORD] repositioned ${order.changed} role(s)`);
        invalidateGuildCache();
        snap = await getGuildSnapshot({ force: true });
      } else if (order.reason) {
        console.log(`[DISCORD] role order unchanged: ${order.reason}`);
      }
    } catch (e) {
      console.warn('[DISCORD] role reorder failed:', e.message);
    }

    const roleIdByName = Object.fromEntries(snap.roles.map(r => [r.name, r.id]));

    const manualCidByDiscordId = loadManualLinks ? await loadManualLinks() : null;

    /* Most roster CIDs have never logged into the portal, so the server
       nickname is the only place their name exists. Hand them to the caller
       to store, which fills in the "—" everywhere a CID is shown. */
    if (persistNames) {
      // Roster people only. Every run sees ~677 members with a CID, but we
      // have no business storing names for people who aren't on a team or
      // affiliate — they are in the Discord, not in the portal.
      const rosterCids = new Set();
      for (const g of rosterGroups) for (const p of g.people) rosterCids.add(p.cid);

      const names = new Map();
      for (const m of snap.members) {
        const cid = (manualCidByDiscordId && manualCidByDiscordId.get(m.id)) || parseCidFromNickname(m.nickname);
        if (!cid || !rosterCids.has(cid)) continue;
        const nm = parseNameFromNickname(m.nickname);
        if (nm && !names.has(cid)) names.set(cid, nm);
      }
      try {
        discordSyncState.namesStored = await persistNames(names) || 0;
      } catch (e) {
        console.warn('[DISCORD] storing names failed:', e.message);
      }
    }
    const diff = computeRoleDiff({
      rosterGroups, members: snap.members, guildRoleNames: snap.roleNames, manualCidByDiscordId
    });
    const safety = isDiffSafeToApply(diff);
    if (!safety.safe) {
      discordSyncState.result = 'blocked';
      discordSyncState.message = safety.reasons.join('; ');
      console.warn(`[DISCORD] sync blocked (${reason}): ${discordSyncState.message}`);
      return discordSyncState;
    }

    const plan = buildApplyPlan(diff);
    for (const op of plan.ops) {
      for (const name of op.add) {
        const id = roleIdByName[name];
        if (!id) { discordSyncState.failed++; continue; }
        try { await addRoleToMember(op.id, id); discordSyncState.added++; }
        catch (e) { discordSyncState.failed++; console.warn(`[DISCORD] add ${name} -> ${op.nickname}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 350));
      }
      for (const name of op.remove) {          // only ever populated once removals are on
        const id = roleIdByName[name];
        if (!id) { discordSyncState.failed++; continue; }
        try { await removeRoleFromMember(op.id, id); discordSyncState.removed++; }
        catch (e) { discordSyncState.failed++; console.warn(`[DISCORD] remove ${name} -> ${op.nickname}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 350));
      }
    }

    invalidateGuildCache();
    discordSyncState.result = 'ok';
    discordSyncState.lastOkAt = new Date();
    discordSyncState.message = plan.suppressedRemovals
      ? `${plan.suppressedRemovals} removal(s) suppressed (additive-only)`
      : '';
    console.log(`[DISCORD] sync ${reason}: +${discordSyncState.added} roles, -${discordSyncState.removed}, ${discordSyncState.failed} failed` +
      (removalsEnabled() ? '' : ` (removals off, ${plan.suppressedRemovals} suppressed)`));
  } catch (e) {
    discordSyncState.result = 'error';
    discordSyncState.message = e.message;
    console.error('[DISCORD] sync failed:', e.message);
  } finally {
    discordSyncState.running = false;
  }
  return discordSyncState;
}
