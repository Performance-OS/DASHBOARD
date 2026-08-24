// Runs inside GitHub Actions on a schedule (see .github/workflows/strava-sync.yml).
// Finds every passcode that has connected Strava (via the "Connect to Strava" button in the
// dashboard, handled by the strava-oauth-callback Edge Function), refreshes each person's
// access token, pulls their recent activities, and writes the result back under their own
// passcode. One run covers everyone connected - no per-person secrets needed here anymore.

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function assertEnv(name, val){
  if(!val){ console.error(`Missing required secret/env var: ${name}`); process.exit(1); }
}
[
  ['STRAVA_CLIENT_ID', STRAVA_CLIENT_ID], ['STRAVA_CLIENT_SECRET', STRAVA_CLIENT_SECRET],
  ['SUPABASE_URL', SUPABASE_URL], ['SUPABASE_ANON_KEY', SUPABASE_ANON_KEY],
].forEach(([name, val]) => assertEnv(name, val));

function toLocalISO(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function mondayOnOrBefore(date){
  const dt = new Date(date);
  const dow = (dt.getDay()+6) % 7; // 0 = Monday
  dt.setDate(dt.getDate() - dow);
  return toLocalISO(dt);
}
function fmtPace(secPerKm){
  if(!isFinite(secPerKm) || secPerKm<=0) return '--:--';
  const m = Math.floor(secPerKm/60), s = Math.round(secPerKm%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

async function fetchConnectedUsers(){
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/kv_store?key=eq.strava_auth&select=passcode,value`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  if(!res.ok) throw new Error(`Fetching connected users failed: ${res.status} ${await res.text()}`);
  return await res.json(); // [{passcode, value: '{"refresh_token":...}'}]
}

async function getAccessToken(refreshToken){
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if(!res.ok) throw new Error(`Strava token refresh failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchActivities(accessToken){
  const after = Math.floor((Date.now() - 400*24*60*60*1000) / 1000);
  let page = 1, all = [];
  while(true){
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if(!res.ok) throw new Error(`Strava activities fetch failed: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    all = all.concat(batch);
    if(batch.length < 100) break;
    page++;
    if(page > 20) break; // safety cap
  }
  return all;
}

function buildWeeklyData(activities){
  const runs = activities.filter(a => a.type === 'Run' || a.sport_type === 'Run');
  const byWeek = {};
  runs.forEach(a => {
    const date = a.start_date_local.slice(0,10);
    const monday = mondayOnOrBefore(date);
    if(!byWeek[monday]) byWeek[monday] = {km:0, runs:0};
    byWeek[monday].km += a.distance/1000;
    byWeek[monday].runs += 1;
  });
  const weekly = Object.keys(byWeek).sort().map(week => ({
    week, km: Math.round(byWeek[week].km*10)/10, runs: byWeek[week].runs,
  }));
  const recent = runs
    .sort((a,b) => b.start_date_local.localeCompare(a.start_date_local))
    .slice(0, 10)
    .map(a => ({
      date: a.start_date_local.slice(0,10),
      km: Math.round((a.distance/1000)*100)/100,
      time_s: a.moving_time,
      pace: fmtPace(a.distance>0 ? a.moving_time/(a.distance/1000) : 0),
    }));
  return { weekly, recent };
}

function buildThisWeekActivities(activities){
  const monday = mondayOnOrBefore(toLocalISO(new Date()));
  const mondayDate = new Date(monday);
  const sundayDate = new Date(mondayDate); sundayDate.setDate(mondayDate.getDate()+6);
  return activities
    .filter(a => {
      const d = a.start_date_local.slice(0,10);
      return d >= monday && d <= toLocalISO(sundayDate);
    })
    .map(a => ({
      date: a.start_date_local.slice(0,10),
      sport_type: a.sport_type || a.type,
      dist_m: a.distance,
      time_s: a.moving_time,
    }));
}

async function writeSnapshot(passcode, weeklyData, thisWeekActivities){
  const value = JSON.stringify({
    weekly_data: weeklyData,
    this_week_activities: thisWeekActivities,
    synced_at: new Date().toISOString(),
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv_store`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ passcode, key: 'strava_snapshot', value, updated_at: new Date().toISOString() }),
  });
  if(!res.ok) throw new Error(`Supabase write failed: ${res.status} ${await res.text()}`);
}

async function syncOneUser(passcode, refreshToken){
  const accessToken = await getAccessToken(refreshToken);
  const activities = await fetchActivities(accessToken);
  const weeklyData = buildWeeklyData(activities);
  const thisWeekActivities = buildThisWeekActivities(activities);
  await writeSnapshot(passcode, weeklyData, thisWeekActivities);
  return activities.length;
}

(async function main(){
  console.log('Finding everyone who\u2019s connected Strava...');
  const users = await fetchConnectedUsers();
  console.log(`Found ${users.length} connected passcode(s).`);

  let successCount = 0, failCount = 0;
  for(const user of users){
    const label = user.passcode.slice(0, 3) + '***'; // don't print full passcodes to a public Actions log
    try{
      const auth = JSON.parse(user.value);
      if(!auth.refresh_token){ console.warn(`  ${label}: no refresh_token stored - skipping`); continue; }
      const count = await syncOneUser(user.passcode, auth.refresh_token);
      console.log(`  ${label}: synced OK (${count} activities fetched)`);
      successCount++;
    }catch(e){
      // One person's expired/revoked connection shouldn't stop everyone else's sync.
      console.error(`  ${label}: FAILED -`, e.message);
      failCount++;
    }
  }
  console.log(`Done. ${successCount} succeeded, ${failCount} failed.`);
  if(successCount === 0 && failCount > 0) process.exit(1); // only hard-fail if literally everyone failed
})().catch(err => {
  console.error('Strava sync failed:', err);
  process.exit(1);
});
