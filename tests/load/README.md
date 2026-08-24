# tests/load — k6 benchmark and query plans

Built in P6. Results, the machine spec, and the `EXPLAIN` output before and
after the indexing pass are in **`LOAD_TEST.md`** at the repository root; this
README covers how to run the pieces.

Layout:

```
scripts/atrium.js        the k6 benchmark — four endpoints, four scenarios
explain/plans.sql        EXPLAIN (ANALYZE, BUFFERS) for the same four paths
explain/capture.sh       one capture into an artifact
explain/ab.sh            three warm passes, keeps the third
artifacts/               committed raw output of every run in LOAD_TEST.md
```

k6 is run from the `grafana/k6` docker image. It is deliberately **not** an npm
dependency — the npm `k6` package is a stub that shells out to a binary you
still have to install, which makes the benchmark non-reproducible for a
reviewer.

Run:

```bash
docker run --rm -i --network=host -v "$PWD/scripts:/scripts" grafana/k6 run /scripts/<script>.js
```

Targets to measure, against `--profile=full` locally (brief §08, p95):

| Endpoint | Target |
| --- | --- |
| Room availability, 7 day range | < 300 ms |
| Cross venue search with combined filters | < 500 ms |
| Create hold | < 250 ms |
| Venue revenue report, 30 days | < 800 ms |

Results, plus `EXPLAIN ANALYZE` before and after indexing, plus the machine
spec, are in `LOAD_TEST.md`. The brief states the reviewer will re-run these
scripts from the repository, so the numbers must be reproducible rather than
merely reported — which is why the scripts pick their own parameters instead of
carrying ids pasted in by whoever ran them last.

Two switches, both for diagnosis rather than for the headline:

- `ATRIUM_ONLY=hold` — run one scenario alone, to separate "this endpoint is
  slow" from "this endpoint is slow while twenty-five other VUs are on the same
  database".
- `ATRIUM_READ_VUS=n` — turn read concurrency down without changing the mix, to
  locate the saturation knee rather than guess at it.

On Windows under Git Bash, prefix `docker run` with `MSYS_NO_PATHCONV=1` and use
an absolute drive path for the volume; Git Bash rewrites `/scripts` before
Docker sees it and k6 then reports the script as missing.

**Re-running the benchmark leaves 301 real holds behind** for a full
`HOLD_TTL_SECONDS`. The setup window is three weeks across sixty rooms so
consecutive runs do not collide — at seven days and forty rooms the fourth run
found 50 free slots and refused to start.
