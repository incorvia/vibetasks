# Automation API

Opal Tasks exposes a versioned, JSON-friendly API for local automations such as day-planning
skills. Obsidian remains the runtime: callers use `obsidian eval`, while the API routes writes
through the same lifecycle services as the UI.

The API is available at:

```js
app.plugins.plugins.opal_tasks.api.v1
```

Check `capabilities()` before relying on an operation. The API version is independent of the
plugin release version.

## Read a day

```bash
obsidian vault="My vault" eval code="(async()=>{const a=app.plugins.plugins.opal_tasks?.api?.v1;if(!a)throw new Error('Opal Tasks automation API unavailable');return JSON.stringify(await a.getDayContext({date:'2026-09-08',refreshCalendar:true}));})()"
```

`getDayContext()` returns:

- All open tasks, plus non-open tasks that have a block or work session on the requested day.
- Each task's stable ID, path, normalized status category, priority, deadline and estimate.
- Planned task schedules and broader allocations intersecting the day.
- Work sessions started that day.
- Read-only Google Calendar events and calendar freshness/error state.
- A deterministic `revision` for approval workflows.

Use task IDs in plan operations. Paths and titles are presentation data and can be renamed or be
ambiguous.

## Validate and apply a plan

Drafting should be a separate, read-only phase. Save the returned `revision` with the draft. After
the user approves it, validate and apply the exact approved operations:

```js
const api = app.plugins.plugins.opal_tasks.api.v1;
const plan = {
  date: "2026-09-08",
  expectedRevision: "fnv1a-12345678",
  idempotencyKey: "day-plan:2026-09-08:v1",
  operations: [
    {
      type: "schedule-task",
      taskId: "01K4P6Z1MXX8BM5FYN6Z2N54HA",
      schedule: { start: "2026-09-08T09:00:00-05:00", duration: 45 }
    },
    {
      type: "create-task",
      task: { title: "Lunch", estimate: 45, labels: ["personal"] },
      schedule: { start: "2026-09-08T12:00:00-05:00", duration: 45 }
    }
  ]
};
return JSON.stringify(await api.applyPlan(plan));
```

Supported operations are:

- `schedule-task` and `unschedule-task`
- `update-task` for `due`, `estimate`, and `priority`
- `set-task-status`
- `create-task`, optionally with an immediate schedule

Schedule starts must include a date and time. An offset is strongly recommended. Durations and
estimates are positive whole minutes. A date-only placement uses
`schedule: { "allDay": true, "date": "2026-09-08" }` and intentionally has no artificial
midnight start or 24-hour duration.

Validation detects malformed values, missing or non-open scheduled tasks, unknown statuses,
changes since the draft revision, and overlaps with existing time blocks, calendar events, or
other proposed timed blocks. Date-only placements remain floating and do not create conflicts.
Set `allowConflicts: true` only when the user explicitly approves an overlap; conflict errors then
become warnings.

`applyPlan()` runs validation again immediately before writing. Plan writes can touch several
Markdown records and are not atomic, so the result reports each operation as `applied` or
`failed`. An `idempotencyKey` prevents duplicate application while the current plugin instance is
running; reusing a key with a different payload is rejected. Callers must still inspect every
result after an Obsidian restart.

## Direct mutations

For small, explicitly approved changes:

```js
await api.updateTask({ taskId: "01...", patch: { estimate: 30 } });
await api.setTaskStatus({ taskId: "01...", status: "done" });
```

Status IDs are vault-specific. Read the `statuses` array in the day context and choose by its
`kind` (`open`, `done`, or `cancelled`) rather than assuming a built-in ID.

## Change subscriptions

In-process integrations can subscribe to coarse invalidation events:

```js
const unsubscribe = api.subscribe((event) => console.log(event));
// "tasks-changed" | "time-changed" | "calendar-changed"
```

Subscriptions do not cross process boundaries. CLI callers should request a new day context each
time they run.

## Storage boundary

Reading the Markdown collection directly remains supported. Automation should not hand-edit task
schedules, statuses, recurrence timestamps, timers, or daily time logs: those mutations have
domain behavior that the API preserves.
