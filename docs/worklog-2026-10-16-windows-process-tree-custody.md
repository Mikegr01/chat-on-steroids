# Windows process-tree custody

The adversarial review identified a false retirement boundary: taskkill failure fell back to
leader-only termination, then UnifiedExecProcessManager discarded its row and released the
durable session's process owner. Session deletion could therefore succeed with a live descendant.

The new Windows regression launches an owned leader, child and grandchild. Independently
detached helpers avoid incidental Node child-lifetime containment. Only the taskkill spawn is
faulted: a real helper exits unsuccessfully, optionally killing the real leader first. The OS
grandchild PID remains observable. Before repair both cases returned deletion=completed,
represented=false and owner=null while that PID was still alive. Test cleanup independently
terminates the fixture PIDs.

The shared tree helper now returns whether Windows tree termination succeeded, removes the
leader-only fallback and treats a missing leader as insufficient proof. The existing manager
claims retirement before awaiting termination, retains unresolved rows and custody, and refuses
to turn leader exit or output consumption into completed retirement. A shared in-flight promise
keeps a concurrent initial response behind the same retirement boundary. Windows PTY termination
addresses the tree before killing the PTY handle. Shutdown attempts every sibling and reports
unresolved failures while retaining those rows; its existing overall exit deadline is unchanged.

This deliberately fails closed when the tree cannot be proven gone. Session deletion rejects;
the durable session remains. Custody lasts for the running app, as before. This change does not
introduce a persistent process ledger, automatic descendant reconciliation or OS containment.

Validation before commit:

- Exact three-case OS regression: five consecutive runs passed, 15/15 cases. The successful
  branch observes both child and grandchild gone; refusal and partial kill retain custody.
- Process, session, MCP, runtime, output-delivery, GC and shutdown set: 13 files passed,
  496 tests passed and 10 platform/opt-in cases skipped. Existing isolation assertions remain.
- Typecheck passed. The paired native verification change has its own focused gate and worklog.

No S7/video execution, frame contract, native authorization or Resolve code changed. No push,
PR update, merge or history rewrite is authorized by this worklog. Canonical verification follows
the new commits and is recorded in the task's final verification report.
