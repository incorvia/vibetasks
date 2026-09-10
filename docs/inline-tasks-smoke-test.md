# Inline tasks manual smoke test

Run against a vault with wiki links first, then repeat link creation with Markdown links and
shortest-path/relative-link settings changed.

## Desktop

1. In a regular note, convert a checkbox, bullet, numbered item, blockquote, heading, and prose
   line with **Convert current line to Opal task**.
2. Confirm indentation/list markers remain, the checkbox token disappears, and each destination
   task exists under `_opal_tasks/tasks` with `opal_source_note_id` matching the note's
   `opal_note_id`.
3. Convert `[x]` and confirm the record is completed with a completion timestamp.
4. Convert a line containing due time, `+` schedule, priority, estimate, label, recurrence, and an
   existing `@project`; confirm every parsed field and the scheduled time block.
5. Repeat inside frontmatter, a fenced code block, an `opal_tasks` block, an empty line, and a line
   containing only a task link; confirm conversion is unavailable.
6. In Live Preview, click status/title, modifier-click the title, right-click the widget, and move
   the cursor through its range. Confirm edits from another dashboard pane update the widget.
7. Repeat in Reading mode and after deleting the task record; the latter must become the original
   ordinary link without an exception.

## Project conversion

1. Create inline tasks in a regular note: open, completed, assigned to another project, and
   trashed. Add a manual task link and remove one converted task link.
2. Turn the note into an Opal project. Confirm open/completed/previously assigned originating tasks
   move to the new project; trash, removed links, and manual links do not.
3. Run the project command again. Confirm the report is idempotent and has no additional moves.
4. Copy the source note, then turn the copy into a project. Confirm it receives a new
   `opal_note_id` and cannot claim the original note's tasks.

## Window and device coverage

- Repeat widget interaction in two panes showing the same note and confirm both update.
- Repeat in an Obsidian popout window and confirm menus render in the popout document.
- On mobile, convert with the command and optional hover-button setting enabled, then long-press
  status and the rest of the widget to open their respective menus.
