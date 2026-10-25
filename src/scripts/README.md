# scripts/

Developer utility scripts shipped inside the `dsh-harnessams` package (reserved; currently
this README only). Anything placed here is published with the package tarball — see the
`files` whitelist in `package.json` and the must-contain / must-not-contain checks in
`PUBLISH.md` at the repo root.

Candidate future contents: repo self-checks (English-only / self-containment scanners) and
release helpers. The simulation pipeline scripts live in the SmartAnaSim repo (`scripts/`
there) and as verbatim copies in `LocalDesignExample/tools/`.
