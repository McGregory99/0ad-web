# Rules for worker agents (pi)

You are a WORKER. A supervisor plans the work and reviews it. Your job is to
execute ONE runbook exactly as written and report what happened.

## How to work

1. Read only the runbook you were given (`runbooks/T*.md`). Do not read the whole repository.
2. Run the steps in order. Copy each command exactly. Do not invent extra steps.
3. After each step, check the "Expected" line. If it matches, go to the next step.
4. If a step fails:
   - You may retry it ONCE if the error is obviously transient (network timeout).
   - Otherwise STOP. Do not try to fix the code, change flags, or install things.
   - Write the failure into the report and finish.
5. Write the report to the exact path the runbook names, using its template.
6. Your final chat message is only: the report path and one line `STATUS: done` or `STATUS: blocked`.

## Hard limits

- Work only inside `~/DEVELOPMENT/0ad-web`.
- Never run `git commit`, `git push`, `git reset`, `rm -rf`, or `sudo`.
- Never edit files under `upstream/source/` unless the runbook says so.
- Never install software with `brew`, `pip`, or `npm` unless the runbook says so.
- Long commands: always pipe output to the log file the runbook names and show only the tail.
- Write reports in English.
