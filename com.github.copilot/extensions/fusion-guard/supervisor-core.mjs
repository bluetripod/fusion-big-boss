export const progressRequest = 'Give a concise progress update, including any blocker and the detail needed to understand it. Avoid unnecessary logs or task repetition. Continue your assigned work.';

function clean(value) {
  return String(value ?? '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ').trim();
}

function render(records, time) {
  const ordered = [...records].sort((a, b) =>
    Number(b.quiet || b.unavailable || b.observation.status === 'blocked') -
    Number(a.quiet || a.unavailable || a.observation.status === 'blocked'));
  return ordered.map(({ observation, quiet, unavailable }) => {
    const elapsed = Math.floor(Math.max(0, time - observation.startedAt) / 1000);
    const age = Number.isFinite(elapsed) ? `${elapsed}s` : 'unknown age';
    const state = clean(observation.status) || 'unknown';
    const flags = `${unavailable ? 'request unavailable; ' : ''}${quiet ? 'no observed progress; ' : ''}`;
    const unknown = observation.version === undefined ? '; progress unknown' : '';
    const prefix = `${clean(observation.id)} ${age} ${flags}${state}${unknown}`;
    const activity = clean(observation.activity);
    return `${prefix}${activity ? `: ${activity}` : ''}`;
  }).join('\n');
}

export function createSupervisor({ sample, notify, request, now = Date.now, schedule = setInterval, unschedule = clearInterval }) {
  let timer;
  let active = false;
  let generation = 0;
  let busy;
  let owners = new Map();

  function stop() {
    active = false;
    generation++;
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    owners = new Map();
    busy = undefined;
  }

  async function tick() {
    if (!active || busy) return;
    const token = {};
    busy = token;
    const current = generation;
    const live = () => active && generation === current;
    try {
      let observations;
      try {
        observations = await sample();
      } catch {
        for (const owner of owners.keys()) {
          if (!live()) return;
          try { await notify(owner, 'worker status unavailable'); } catch { /* Other owners still receive updates. */ }
        }
        return;
      }
      if (!live()) return;
      if (!observations.length) {
        stop();
        return;
      }

      const next = new Map();
      for (const observation of observations) {
        const previous = owners.get(observation.owner)?.get(observation.id);
        const quiet = observation.version !== undefined && previous?.version !== undefined &&
          observation.version === previous.version;
        const record = {
          observation,
          version: observation.version,
          quiet,
          outstanding: quiet && previous.outstanding,
          unavailable: quiet && previous.unavailable,
        };
        if (!next.has(observation.owner)) next.set(observation.owner, new Map());
        next.get(observation.owner).set(observation.id, record);
      }
      owners = next;

      for (const [owner, records] of next) {
        for (const record of records.values()) {
          if (!live()) return;
          const observation = record.observation;
          if (record.quiet && !record.outstanding && observation.status === 'running' && observation.requestable === true) {
            record.outstanding = true;
            try {
              record.unavailable = await request(observation, progressRequest) !== true;
            } catch {
              record.unavailable = true;
            }
            if (!live()) return;
          }
        }
        if (!live()) return;
        try { await notify(owner, render([...records.values()], now())); } catch { /* Other owners still receive updates. */ }
        if (!live()) return;
      }
    } finally {
      if (busy === token) busy = undefined;
    }
  }

  function start() {
    if (active) return;
    active = true;
    const current = ++generation;
    timer = schedule(() => {
      if (active && generation === current) return tick();
    }, 60000);
    timer?.unref?.();
  }

  return { start, stop, tick };
}
