/* Minimal Discord REST client for the role sync.
 *
 * Only what the portal needs: read the guild's roles and members. Results are
 * cached because the admin page would otherwise pull ~1000 members on every
 * render, which is slow and burns rate limit for no benefit.
 */

const API = 'https://discord.com/api/v10';
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, data: null };
let inFlight = null;

export function discordConfigured() {
  return !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID)
    && String(process.env.DISCORD_SYNC_DISABLED || '').toLowerCase() !== 'true';
}

async function call(path, init = {}, { timeoutMs = 15000 } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(API + path, {
        ...init,
        signal: ac.signal,
        headers: {
          Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN,
          'Content-Type': 'application/json',
          ...(init.headers || {})
        }
      });
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after') || 1);
      await new Promise(res => setTimeout(res, (wait + 0.25) * 1000));
      continue;
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(`Discord ${r.status} on ${path}: ${text.slice(0, 200)}`);
    return json;
  }
  throw new Error('Discord rate limited repeatedly on ' + path);
}

/* Roles + members, shaped for computeRoleDiff. Cached; concurrent callers
   share one fetch rather than each starting their own. */
export async function getGuildSnapshot({ force = false } = {}) {
  if (!discordConfigured()) return null;
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (inFlight) return inFlight;

  const guild = process.env.DISCORD_GUILD_ID;
  inFlight = (async () => {
    const roles = await call(`/guilds/${guild}/roles`);
    const roleNameById = Object.fromEntries(roles.map(r => [r.id, r.name]));

    const members = [];
    let after = '0';
    for (;;) {
      const page = await call(`/guilds/${guild}/members?limit=1000&after=${after}`);
      members.push(...page);
      if (page.length < 1000) break;
      after = page[page.length - 1].user.id;
    }

    const data = {
      fetchedAt: new Date(),
      roleNames: roles.map(r => r.name),
      roles,
      members: members.map(m => ({
        id: m.user.id,
        nickname: m.nick || m.user.global_name || m.user.username,
        roleNames: (m.roles || []).map(id => roleNameById[id]).filter(Boolean)
      }))
    };
    cache = { at: Date.now(), data };
    return data;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

export function invalidateGuildCache() {
  cache = { at: 0, data: null };
}

/* Role changes for one member. Discord has no bulk endpoint, so this is one
   call per role. */
export async function addRoleToMember(memberId, roleId) {
  await call(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${memberId}/roles/${roleId}`, { method: 'PUT' });
}

export async function removeRoleFromMember(memberId, roleId) {
  await call(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${memberId}/roles/${roleId}`, { method: 'DELETE' });
}
