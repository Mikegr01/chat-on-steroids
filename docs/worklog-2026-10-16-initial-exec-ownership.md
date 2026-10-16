# S7.5 initial exec ownership race closure — 2026-10-16

Starting candidate: `d76a2fd7ef7b1ae71f424db9887de6197d967adf`, branch
`integration/s75-origin-main-20261016`; fetched base remained
`e63508ebd3187bac2865c7dcad7537de2f06611a`.

## Reproduced defect

The previous manager launched a process, waited for its initial output, then returned its id
to Core. Only then did Core call `noteExecOwner`. Session deletion consulted the single
ownership registry during that gap and could miss an already-running initial exec.

Before the production repair, the new real HTTP MCP regression failed with this snapshot:

- Manager row visible, `initialExecCommandActive=true`, initial response still stalled.
- Owner absent; session deletion and deletion retry both completed.
- After releasing the initial response, `retirementPending=true`, owner absent and session gone.
- Independently recorded OS grandchild PID still alive under injected taskkill failure.

The fixture launches a real shell/child/grandchild tree. An atomic file publication observed
by `fs.watch` proves descendant readiness. Fake app timers hold the early-exit/output boundary;
only taskkill is faulted by a real nonzero helper process. No timing sleeps hide the race.

## Repair and authority

`ownership.ts` remains the only connector custody authority. Core supplies a synchronous
admission callback; immediately before native spawn it canonicalizes the captured principal,
checks the retired-session fence and binds custody. The manager registers the resulting native
handle before its early-exit/output await and before notifying observers. PTY preparation
rechecks the exact reservation incarnation before admission. Failure rollback and delayed
initial responses cannot release or operate on a replacement numeric incarnation.

The post-response owner write is removed. The retained retired-session response check only
denies the response; session deletion owns retirement. Exact late request proof promotes the
original custody, but retired sessions remain denied and trigger cleanup. Failed tree retirement
keeps the same owner and manager row. There is no second deletion scan or new process ledger.

## Focused evidence

The eight required cases are covered: publication wins with failed retirement; retirement wins
during PTY preparation; exact request-to-session promotion; retirement before correlation;
natural exit with owned retained output; delayed initial response; failed deletion retry;
successful retirement releasing row and custody. Additional checks cover anonymous isolation,
conflicting proof, foreign-session stop, failed native spawn rollback and recycled reservations.

Normal repository concurrency: 23 focused files passed, 576 tests passed and 12 skipped,
covering ownership, MCP, session deletion, output delivery, shutdown and runtime/process behavior.
Typecheck and `git diff --check` passed. On the final production code, the exact MCP race passed
10/10 deterministic repetitions; the prior Windows grandchild file passed 5/5 runs (15/15 cases).
Post-commit canonical/UI/build results are recorded in the completion report.

The earlier Windows process-tree fail-closed repair and mandatory native UCV verification gate
are unchanged. S7/frame/Resolve/one-shot authorization and package/verification files are untouched.
No push, PR update or merge is authorized here. Independent focused review remains required
before merge. Source/tests/build evidence does not establish installed or live acceptance.
