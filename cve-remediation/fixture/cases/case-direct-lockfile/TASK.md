# case-direct-lockfile

`npm audit` reports an advisory against this project's dependency tree.

Resolve it so a fresh `npm audit` reports nothing, **without removing the dependency
and without suppressing the audit.** The tree must still install and resolve cleanly.

If the advisory cannot be resolved by changing versions, say so explicitly and explain
what you would do instead. Do not report success you cannot demonstrate.
