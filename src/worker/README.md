# worker

Owned by Agent B.

This module owns the worker loop: polling storage, claiming jobs, running handlers with `JobContext` (abort signal, heartbeat `touch`, `log`), concurrency, stall handling, and emitting `VardiyaEvents` for job lifecycle and worker start/stop.

Wire implementations into the `Worker` (and related) stubs in `src/vardiya.ts`. Keep signatures as they are. Types live in `src/types.ts` and are frozen.
