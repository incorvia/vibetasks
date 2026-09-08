# Time domain API

Calendar, task-editor, command, CLI, and future AI entry points must use the same intent-level services. `TimeStore` and `TimerService` are persistence primitives; UI code may query `TimeStore`, but it must not mutate blocks or sessions directly.

## SchedulingService

- `getTaskSchedule(taskId)` returns the one planned primary schedule for a task.
- `scheduleTask(taskId, { allDay: true, date, source? })` creates or moves a date-only primary schedule without inventing a midnight start or duration.
- `scheduleTask(taskId, { start, duration?, source? })` creates or moves a timed primary schedule. Its default duration is the task estimate, then 60 minutes.
- `unscheduleTask(taskId)` removes the primary schedule without changing the deadline or estimate.
- `createAllocation(...)` and `updateAllocation(...)` manage explicit task/project/area time allocations.
- `moveBlock`, `resizeBlock`, and `cancelBlock` are the shared calendar editing operations for either block kind.
- `updateFromCalendar` and `setCalendarLink` are the narrow Google Calendar integration boundary.
- `completeTask` preserves the primary placement as completed calendar history while cancelling other future allocations; `reopenTask` restores that placement.
- `cancelFutureForTask` enforces cancellation/deletion lifecycle cleanup.

The service validates timestamps and whole-minute durations and prevents allocation editors from accidentally rewriting a task schedule.

## WorkTimerService

- `startTask(taskId, blockId?)`, `stop`, `pause`, and `resume` manage actual work sessions.
- `startBlock(blockId, selectedTaskId?)` resolves the block scope and returns `started`, `selection_required`, or `empty`.
- `completeTask`, `completeActive`, and `skip` contain the shared timer/Blitz transition behavior.
- `active`, `recover`, and the conflict methods expose the one-timer-per-vault state machine.

Timers always resolve to a task. Completing a task delegates the task-status transition to the host, so recurrence, completion timestamps, and future-schedule cleanup remain in the task domain.

## Storage boundary

Both task schedules (`kind: task_schedule`) and explicit allocations (`kind: allocation`) are stored as blocks in canonical daily time logs. Work sessions are stored separately in those logs. This common storage shape is an implementation detail; callers choose an intent through one of the services rather than constructing records themselves.

The Today view combines open tasks due today with open tasks whose planned primary schedule touches today. It de-duplicates tasks carrying both signals and keeps overdue tasks in the overdue section. Scheduling never writes or changes `due`.
